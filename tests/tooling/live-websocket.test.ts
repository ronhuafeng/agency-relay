import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { StorySocket, type SocketMessage } from "../live/websocket";

const tls = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:tls", () => ({ connect: tls.connect }));

class UpgradeSocket extends Duplex {
  constructor(private readonly chunks: Buffer[]) { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (chunk.toString("ascii").startsWith("GET ")) {
      queueMicrotask(() => { for (const part of this.chunks) this.push(part); });
    }
    done();
  }
}

describe("Live WebSocket handshake", () => {
  it("preserves the first frame bytes whether the upgrade and frames arrive together or in parts", async () => {
    const header = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", "ascii");
    const binary = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x80, 0xe2, 0x82, 0xac, 0x0d, 0x0a]);
    const text = Buffer.from("synthetic-event", "utf8");
    const frames = Buffer.concat([Buffer.from([0x82, binary.length]), binary, Buffer.from([0x81, text.length]), text]);
    const wire = Buffer.concat([header, frames]);
    const partitions = [
      [wire],
      [header, frames],
      [wire.subarray(0, header.length - 1), wire.subarray(header.length - 1, header.length + 3), wire.subarray(header.length + 3)]
    ];
    for (const chunks of partitions) {
      const transport = new UpgradeSocket(chunks);
      tls.connect.mockImplementationOnce(() => {
        queueMicrotask(() => transport.emit("secureConnect"));
        return transport;
      });
      let socket: StorySocket | undefined;
      try {
        socket = await StorySocket.connect("wss://example.invalid/v1/synthetic", {});
        const messages: SocketMessage[] = [];
        await socket.waitFor(message => { messages.push(message); return messages.length === 2; }, 100);
        expect(messages).toEqual([{ kind: "binary", data: binary }, { kind: "text", data: text }]);
      } finally {
        socket?.close();
        transport.destroy();
      }
    }
  });
});
