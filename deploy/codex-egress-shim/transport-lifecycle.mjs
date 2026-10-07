// Generated from transport-lifecycle.ts by pnpm run egress:build. Do not edit directly.
import egressProtocol from "./egress-protocol.json" with { type: "json" };
const { outcomes, stages } = egressProtocol.transportTrace;
const TERMINAL_SIGNALS = Object.freeze({
    completed: () => Object.freeze({ outcome: outcomes.completed, stage: stages.responseWrite }),
    upstream_error: ({ state }) => state === "pending"
        ? Object.freeze({ outcome: outcomes.upstreamRequestFailed, stage: stages.upstreamConnect })
        : Object.freeze({ outcome: outcomes.upstreamReadFailed, stage: stages.responseRead }),
    request_abort: ({ requestUploadComplete }) => requestUploadComplete
        ? Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown })
        : Object.freeze({ outcome: outcomes.requestUploadAborted, stage: stages.requestUpload }),
    downstream_close: ({ requestUploadComplete }) => requestUploadComplete
        ? Object.freeze({ outcome: outcomes.downstreamClosed, stage: stages.responseWrite })
        : Object.freeze({ outcome: outcomes.requestUploadAborted, stage: stages.requestUpload }),
    downstream_error: ({ requestUploadComplete }) => requestUploadComplete
        ? Object.freeze({ outcome: outcomes.downstreamWriteFailed, stage: stages.responseWrite })
        : Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown }),
    runtime_unknown: () => Object.freeze({ outcome: outcomes.indeterminate, stage: stages.unknown }),
});
export function createTransportLifecycle({ traceMetadata, method, path, now = () => performance.now(), onFinish, }) {
    const startedAt = now();
    let lifecycleState = "pending";
    let finalOutcome = null;
    let status = null;
    let firstRequestUploadByteMs = null;
    let requestUploadCompleteMs = null;
    let requestUploadBytes = 0;
    let requestUploadChunks = 0;
    let requestUploadComplete = false;
    let upstreamHeadersMs = null;
    let firstUpstreamByteMs = null;
    let firstDownstreamSubmitMs = null;
    let upstreamReadBytes = 0;
    let upstreamReadChunks = 0;
    let downstreamSubmitBytes = 0;
    let downstreamSubmitChunks = 0;
    const elapsed = () => Math.max(0, Math.trunc(now() - startedAt));
    const startStreaming = () => {
        if (lifecycleState === "pending")
            lifecycleState = "streaming";
    };
    return {
        get state() {
            return lifecycleState;
        },
        recordRequestUpload(byteLength) {
            if (lifecycleState === "finished" || requestUploadComplete)
                return;
            firstRequestUploadByteMs ??= elapsed();
            requestUploadBytes += byteLength;
            requestUploadChunks += 1;
        },
        recordRequestUploadComplete() {
            if (lifecycleState === "finished" || requestUploadComplete)
                return;
            requestUploadComplete = true;
            requestUploadCompleteMs = elapsed();
        },
        recordUpstreamHeaders(upstreamStatus) {
            if (lifecycleState === "finished")
                return;
            startStreaming();
            status ??= upstreamStatus;
            upstreamHeadersMs ??= elapsed();
        },
        recordUpstreamRead(byteLength) {
            if (lifecycleState === "finished")
                return;
            startStreaming();
            firstUpstreamByteMs ??= elapsed();
            upstreamReadBytes += byteLength;
            upstreamReadChunks += 1;
        },
        recordDownstreamSubmit(byteLength) {
            if (lifecycleState === "finished")
                return;
            startStreaming();
            firstDownstreamSubmitMs ??= elapsed();
            downstreamSubmitBytes += byteLength;
            downstreamSubmitChunks += 1;
        },
        finish(signal) {
            if (finalOutcome)
                return finalOutcome;
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
            }
            catch {
                // Outcome sinks are outside the transport lifecycle contract.
            }
            return finalOutcome;
        },
    };
}
