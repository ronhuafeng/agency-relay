import { isRecord } from "../runtime";

/** Allowlisted local diagnostics; never serialize full RTC stats or SDP. */
export function projectRtcStats(input: Iterable<unknown>) {
  const rows = [...input].filter(isRecord);
  const candidateTypes = ["host", "srflx", "prflx", "relay"] as const;
  const pairStates = ["frozen", "waiting", "in-progress", "failed", "succeeded"] as const;
  const candidates = (side: string) => Object.fromEntries(candidateTypes.map(type => [type,
    rows.filter(row => row.type === side && row.candidateType === type).length])) as Record<typeof candidateTypes[number], number>;
  const pairs = rows.filter(row => row.type === "candidate-pair");
  const sum = (field: string): number | null => pairs.length > 0
    && pairs.every(row => typeof row[field] === "number" && Number.isFinite(row[field]) && (row[field] as number) >= 0)
    ? pairs.reduce((total, row) => total + (row[field] as number), 0) : null;
  return {
    local_candidates: candidates("local-candidate"),
    remote_candidates: candidates("remote-candidate"),
    protocols: { udp: rows.filter(row => typeof row.type === "string" && row.type.endsWith("-candidate") && row.protocol === "udp").length,
      tcp: rows.filter(row => typeof row.type === "string" && row.type.endsWith("-candidate") && row.protocol === "tcp").length },
    pair_states: Object.fromEntries(pairStates.map(state => [state, pairs.filter(row => row.state === state).length])) as Record<typeof pairStates[number], number>,
    nominated_pairs: pairs.filter(row => row.nominated === true).length,
    requests_sent: sum("requestsSent"),
    responses_received: sum("responsesReceived")
  };
}
