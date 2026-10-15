import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RTCPeerConnection, usePCMU } from "werift";
import { HOST, call, env } from "../support";
import { projectRtcStats } from "./realtime-diagnostics";

const SESSION = JSON.parse(readFileSync(new URL("./fixtures/session.json", import.meta.url), "utf8")) as {
  instructions: string;
  model: string;
  audio: { output: { voice: string } };
  delegation: { type: "client"; ack_filler: false };
};

function wavPcm(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      return bytes.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("wav data missing");
}

function ulaw(sample: number): number {
  const bias = 0x84;
  const clip = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) {
    sample = -sample;
  }
  if (sample > clip) {
    sample = clip;
  }
  sample += bias;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) {
    // Find the highest set bit after the bias.
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function pcmuFrames(bytes: Uint8Array): Buffer[] {
  const pcm = wavPcm(bytes);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples: number[] = [];
  for (let i = 0; i + 1 < pcm.byteLength; i += 6) {
    samples.push(view.getInt16(i, true));
  }
  const frames: Buffer[] = [];
  for (let i = 0; i < samples.length; i += 160) {
    const frame = Buffer.alloc(160, 0xff);
    for (let j = 0; j < 160 && i + j < samples.length; j += 1) {
      frame[j] = ulaw(samples[i + j] ?? 0);
    }
    frames.push(frame);
  }
  for (let n = 0; n < 20; n += 1) {
    frames.push(Buffer.alloc(160, 0xff));
  }
  return frames;
}

function rtp(sequence: number, timestamp: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(1, 8);
  return Buffer.concat([header, payload]);
}

it("completes a Codex realtime call and returns the caller's words plus audio", async () => {
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const wav = readFileSync(new URL("./fixtures/probe.wav", import.meta.url));
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  const messages: string[] = [];
  let audioPackets = 0;
  const startedAt = performance.now();
  const disposers: (() => void)[] = [];
  const transition = (layer: string, state: string) => console.info("realtime_transport", {
    layer, state, elapsed_ms: Math.round(performance.now() - startedAt)
  });
  disposers.push(pc.iceGatheringStateChange.subscribe(state => transition("gathering", state)).unSubscribe);
  disposers.push(pc.iceConnectionStateChange.subscribe(state => transition("ice", state)).unSubscribe);
  disposers.push(pc.connectionStateChange.subscribe(state => transition("connection", state)).unSubscribe);
  try {
    const channel = pc.createDataChannel("oai-events");
    disposers.push(channel.stateChanged.subscribe(state => transition("data_channel", state)).unSubscribe);
    const snapshot = async (phase: string) => {
      let stats: ReturnType<typeof projectRtcStats> | null = null;
      try { stats = projectRtcStats((await pc.getStats()).values()); } catch { /* unavailable is not zero */ }
      console.info("realtime_transport", {
        phase, elapsed_ms: Math.round(performance.now() - startedAt),
        connection: pc.connectionState, gathering: pc.iceGatheringState, ice: pc.iceConnectionState,
        transports: pc.dtlsTransports.map(t => ({ ice: t.iceTransport.state, dtls: t.state })),
        data_channel: channel.readyState, stats
      });
    };
    channel.onmessage = (event) => {
      messages.push(String(event.data));
    };
    pc.ontrack = (event) => {
      event.track.onReceiveRtp.subscribe(() => {
        audioPackets += 1;
      });
    };
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    transceiver.setCodecPreferences([usePCMU()]);
    await pc.setLocalDescription(await pc.createOffer());
    for (const transport of pc.dtlsTransports) {
      disposers.push(transport.onStateChange.subscribe(state => transition("dtls", state)).unSubscribe);
    }
    await snapshot("local_offer");
    const response = await call(
      `${HOST.codex}/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
      key,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OpenAI-Alpha": "quicksilver=v2"
        },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp, session: SESSION })
      }
    );
    console.info("Realtime creation status", response.status);
    expect(response.status).toBe(201);
    const validSdp = response.text.startsWith("v=") && response.text.includes("m=audio")
      && !response.text.toLowerCase().includes("<html");
    console.info("Realtime SDP answer valid", validSdp);
    expect(validSdp).toBe(true);
    const callId = response.headers.get("location")?.split("/").filter(Boolean).at(-1) ?? "";
    expect(/^rtc_[A-Za-z0-9_-]+$/.test(callId)).toBe(true);

    await pc.setRemoteDescription({ type: "answer", sdp: response.text });
    await snapshot("remote_answer");
    await new Promise<void>(resolve => {
      const timer = setTimeout(finish, 12_000);
      const subscriptions = [pc.connectionStateChange.subscribe(check), channel.stateChanged.subscribe(check)];
      function finish() { clearTimeout(timer); subscriptions.forEach(s => s.unSubscribe()); resolve(); }
      function check() { if (pc.connectionState === "connected" && channel.readyState === "open") finish(); }
      check();
    });
    await snapshot("connection_boundary");
    console.info("Realtime connection state", pc.connectionState);
    expect(pc.connectionState).toBe("connected");
    expect(channel.readyState).toBe("open");

    const sender = pc.getTransceivers()[0]?.sender;
    if (!sender) {
      throw new Error("audio sender missing");
    }
    let sequence = 1;
    let timestamp = 0;
    for (const frame of pcmuFrames(wav)) {
      await sender.sendRtp(rtp(sequence, timestamp, frame));
      sequence += 1;
      timestamp += 160;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const heardBy = Date.now() + 8_000;
    while (Date.now() < heardBy) {
      if (/agency relay/i.test(messages.join("\n")) && audioPackets > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const transcript = messages.join("\n");
    const transcriptMatches = /agency relay/i.test(transcript) && !transcript.toLowerCase().includes("<html");
    console.info("Realtime transcript matched", transcriptMatches, "audio packets", audioPackets);
    expect(transcriptMatches).toBe(true);
    expect(audioPackets).toBeGreaterThan(0);
  } finally {
    disposers.forEach(dispose => dispose());
    await pc.close();
  }
}, 60_000);
