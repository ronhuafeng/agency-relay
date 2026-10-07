import { randomBytes } from "node:crypto";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { bytesToBase64, bytesToUtf8 } from "./support";

export interface SocketMessage {
  kind: "text" | "binary";
  data: Buffer;
}

export class StorySocket {
  private buffer = Buffer.alloc(0);
  private readonly messages: SocketMessage[] = [];
  private waiter: (() => void) | null = null;
  private failed: Error | null = null;

  private constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readFrames();
      this.waiter?.();
    });
    socket.on("error", (error) => {
      this.failed = error;
      this.waiter?.();
    });
    socket.on("close", () => {
      this.waiter?.();
    });
  }

  static async connect(urlString: string, headers: Record<string, string>): Promise<StorySocket> {
    const url = new URL(urlString);
    const key = bytesToBase64(randomBytes(16));
    const socket = connectTls({ host: url.hostname, port: 443, servername: url.hostname });
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", () => resolve());
      socket.once("error", reject);
    });
    const lines = [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.hostname}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      ""
    ];
    socket.write(lines.join("\r\n"));
    const header = await readHeader(socket);
    if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
      socket.destroy();
      throw new Error("websocket upgrade rejected");
    }
    return new StorySocket(socket);
  }

  sendText(text: string): void {
    this.send(0x1, Buffer.from(text));
  }

  sendBinary(data: Buffer): void {
    this.send(0x2, data);
  }

  async waitFor(match: (message: SocketMessage) => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.failed) {
        throw this.failed;
      }
      if (this.messages.some(match)) {
        return;
      }
      if (this.socket.destroyed) {
        throw new Error("socket closed");
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, Math.min(500, deadline - Date.now()));
      });
      this.waiter = null;
    }
    throw new Error("websocket terminal missing");
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.send(0x8, Buffer.alloc(0));
      this.socket.end();
    }
  }

  private send(opcode: number, data: Buffer): void {
    const mask = randomBytes(4);
    const header = Buffer.alloc(data.length < 126 ? 6 : 8);
    header[0] = 0x80 | opcode;
    if (data.length < 126) {
      header[1] = 0x80 | data.length;
      header.set(mask, 2);
    } else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
      header.set(mask, 4);
    }
    const masked = Buffer.from(data);
    for (let index = 0; index < masked.length; index += 1) {
      const byte = masked[index] ?? 0;
      const maskByte = mask[index % 4] ?? 0;
      masked[index] = byte ^ maskByte;
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  private readFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0] ?? 0;
      const second = this.buffer[1] ?? 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        throw new Error("websocket frame rejected");
      }
      if (this.buffer.length < offset + length) return;
      const data = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x9) {
        this.send(0xa, data);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        this.messages.push({ kind: opcode === 0x1 ? "text" : "binary", data: Buffer.from(data) });
      }
    }
  }
}

function readHeader(socket: TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let header = "";
    const onData = (chunk: Buffer) => {
      header += bytesToUtf8(chunk);
      const end = header.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.off("data", onData);
        const rest = Buffer.from(header.slice(end + 4));
        if (rest.length > 0) socket.unshift(rest);
        resolve(header.slice(0, end));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}
