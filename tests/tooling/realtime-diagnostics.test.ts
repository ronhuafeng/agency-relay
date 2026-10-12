import { expect, it } from "vitest";
import { projectRtcStats } from "../live/codex/realtime-diagnostics";

it("projects only candidate types, protocols and connectivity counters", () => {
  const privateValue = "SYNTHETIC_PRIVATE_RTC_VALUE";
  const result = projectRtcStats([
    { type: "local-candidate", candidateType: "host", protocol: "udp", address: privateValue, usernameFragment: privateValue },
    { type: "remote-candidate", candidateType: "srflx", protocol: "udp", url: privateValue, port: 12345 },
    { type: "candidate-pair", state: "succeeded", nominated: true, requestsSent: 4, responsesReceived: 3, localCandidateId: privateValue },
    { type: "certificate", fingerprint: privateValue }
  ]);
  expect(result.local_candidates.host).toBe(1);
  expect(result.remote_candidates.srflx).toBe(1);
  expect(result.pair_states.succeeded).toBe(1);
  expect(result.nominated_pairs).toBe(1);
  expect(result.requests_sent).toBe(4);
  expect(result.responses_received).toBe(3);
  expect(JSON.stringify(result).includes(privateValue)).toBe(false);
  expect(JSON.stringify(result).includes("12345")).toBe(false);
});

it("keeps absent counters unknown rather than inventing zero measurements", () => {
  expect(projectRtcStats([]).requests_sent).toBeNull();
  expect(projectRtcStats([{ type: "candidate-pair", state: "waiting" }]).responses_received).toBeNull();
  const result = projectRtcStats([{ type: "candidate-pair", state: "failed", requestsSent: 0, responsesReceived: 0 }]);
  expect(result.requests_sent).toBe(0);
  expect(result.responses_received).toBe(0);
});
