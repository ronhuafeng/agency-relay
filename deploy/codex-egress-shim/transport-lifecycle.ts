import egressProtocol from "./egress-protocol.json" with { type: "json" };

const { outcomes, stages } = egressProtocol.transportTrace;

export type TransportLifecycleState = "pending" | "streaming" | "finished";
export type TransportTerminalSignal =
  | "completed"
  | "upstream_error"
  | "request_abort"
  | "downstream_close"
  | "downstream_error"
  | "runtime_unknown";

type TraceMetadata = Readonly<Record<string, unknown>>;
type TerminalClassification = Readonly<{ outcome: string; stage: string }>;
type LifecycleSnapshot = Readonly<{
  state: TransportLifecycleState;
  requestUploadComplete: boolean;
}>;

export type TransportOutcome = Readonly<
  TraceMetadata & {
    method: string;
    path: string;
    status: number | null;
    transport_outcome: string;
    transport_stage: string;
    duration_ms: number;
    first_request_upload_byte_ms: number | null;
    request_upload_complete_ms: number | null;
    request_upload_bytes: number;
    request_upload_chunks: number;
    request_upload_complete: boolean;
    upstream_headers_ms: number | null;
    first_upstream_byte_ms: number | null;
    first_downstream_submit_ms: number | null;
    upstream_read_bytes: number;
    upstream_read_chunks: number;
    downstream_submit_bytes: number;
    downstream_submit_chunks: number;
  }
>;

export interface TransportLifecycle {
  readonly state: TransportLifecycleState;
  recordRequestUpload(byteLength: number): void;
  recordRequestUploadComplete(): void;
  recordUpstreamHeaders(upstreamStatus: number): void;
  recordUpstreamRead(byteLength: number): void;
  recordDownstreamSubmit(byteLength: number): void;
  finish(signal: TransportTerminalSignal): TransportOutcome;
}

export interface CreateTransportLifecycleOptions {
  traceMetadata: TraceMetadata;
  method: string;
  path: string;
  now?: () => number;
  onFinish?: (outcome: TransportOutcome) => void;
}

const TERMINAL_SIGNALS: Readonly<
  Record<TransportTerminalSignal, (snapshot: LifecycleSnapshot) => TerminalClassification>
> = Object.freeze({
  completed: () => Object.freeze({ outcome: outcomes.completed, stage: stages.responseWrite }),
  upstream_error: ({ state }) =>
    state === "pending"
      ? Object.freeze({ outcome: outcomes.upstreamRequestFailed, stage: stages.upstreamConnect })
      : Object.freeze({ outcome: outcomes.upstreamReadFailed, stage: stages.responseRead }),
  request_abort: ({ requestUploadComplete }) =>
    requestUploadComplete
      ? Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown })
      : Object.freeze({ outcome: outcomes.requestUploadAborted, stage: stages.requestUpload }),
  downstream_close: ({ requestUploadComplete }) =>
    requestUploadComplete
      ? Object.freeze({ outcome: outcomes.downstreamClosed, stage: stages.responseWrite })
      : Object.freeze({ outcome: outcomes.requestUploadAborted, stage: stages.requestUpload }),
  downstream_error: ({ requestUploadComplete }) =>
    requestUploadComplete
      ? Object.freeze({ outcome: outcomes.downstreamWriteFailed, stage: stages.responseWrite })
      : Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown }),
  runtime_unknown: () =>
    Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown }),
});

export function createTransportLifecycle({
  traceMetadata,
  method,
  path,
  now = () => performance.now(),
  onFinish,
}: CreateTransportLifecycleOptions): TransportLifecycle {
  const startedAt = now();
  let lifecycleState: TransportLifecycleState = "pending";
  let finalOutcome: TransportOutcome | null = null;
  let status: number | null = null;
  let firstRequestUploadByteMs: number | null = null;
  let requestUploadCompleteMs: number | null = null;
  let requestUploadBytes = 0;
  let requestUploadChunks = 0;
  let requestUploadComplete = false;
  let upstreamHeadersMs: number | null = null;
  let firstUpstreamByteMs: number | null = null;
  let firstDownstreamSubmitMs: number | null = null;
  let upstreamReadBytes = 0;
  let upstreamReadChunks = 0;
  let downstreamSubmitBytes = 0;
  let downstreamSubmitChunks = 0;

  const elapsed = (): number => Math.max(0, Math.trunc(now() - startedAt));
  const startStreaming = (): void => {
    if (lifecycleState === "pending") lifecycleState = "streaming";
  };

  return {
    get state() {
      return lifecycleState;
    },

    recordRequestUpload(byteLength) {
      if (lifecycleState === "finished" || requestUploadComplete) return;
      firstRequestUploadByteMs ??= elapsed();
      requestUploadBytes += byteLength;
      requestUploadChunks += 1;
    },

    recordRequestUploadComplete() {
      if (lifecycleState === "finished" || requestUploadComplete) return;
      requestUploadComplete = true;
      requestUploadCompleteMs = elapsed();
    },

    recordUpstreamHeaders(upstreamStatus) {
      if (lifecycleState === "finished") return;
      startStreaming();
      status ??= upstreamStatus;
      upstreamHeadersMs ??= elapsed();
    },

    recordUpstreamRead(byteLength) {
      if (lifecycleState === "finished") return;
      startStreaming();
      firstUpstreamByteMs ??= elapsed();
      upstreamReadBytes += byteLength;
      upstreamReadChunks += 1;
    },

    recordDownstreamSubmit(byteLength) {
      if (lifecycleState === "finished") return;
      startStreaming();
      firstDownstreamSubmitMs ??= elapsed();
      downstreamSubmitBytes += byteLength;
      downstreamSubmitChunks += 1;
    },

    finish(signal) {
      if (finalOutcome) return finalOutcome;
      const classify = TERMINAL_SIGNALS[signal];
      if (!classify) {
        throw new TypeError(`Unknown transport terminal signal: ${String(signal)}`);
      }
      const terminal = classify({ state: lifecycleState, requestUploadComplete });
      lifecycleState = "finished";
      finalOutcome = Object.freeze({
        ...traceMetadata,
        method,
        path,
        status,
        transport_outcome: terminal.outcome,
        transport_stage: terminal.stage,
        duration_ms: elapsed(),
        first_request_upload_byte_ms: firstRequestUploadByteMs,
        request_upload_complete_ms: requestUploadCompleteMs,
        request_upload_bytes: requestUploadBytes,
        request_upload_chunks: requestUploadChunks,
        request_upload_complete: requestUploadComplete,
        upstream_headers_ms: upstreamHeadersMs,
        first_upstream_byte_ms: firstUpstreamByteMs,
        first_downstream_submit_ms: firstDownstreamSubmitMs,
        upstream_read_bytes: upstreamReadBytes,
        upstream_read_chunks: upstreamReadChunks,
        downstream_submit_bytes: downstreamSubmitBytes,
        downstream_submit_chunks: downstreamSubmitChunks,
      });
      try {
        onFinish?.(finalOutcome);
      } catch {
        // Outcome sinks are outside the transport lifecycle contract.
      }
      return finalOutcome;
    },
  };
}
