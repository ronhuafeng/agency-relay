import type { IncomingMessage, ServerResponse } from "node:http";

type RuntimeSignal =
  | "request_abort"
  | "runtime_unknown"
  | "downstream_close"
  | "downstream_error";

interface RuntimeLifecycle {
  readonly state: "pending" | "streaming" | "finished";
  recordRequestUpload(byteLength: number): void;
  recordRequestUploadComplete(): void;
  finish(signal: RuntimeSignal): unknown;
}

interface AttachRequestRuntimeOptions {
  request: IncomingMessage;
  lifecycle: RuntimeLifecycle;
  cancelUpstream: () => void;
}

interface AttachDownstreamRuntimeOptions {
  response: ServerResponse;
  lifecycle: RuntimeLifecycle;
  onPrematureClose?: () => void;
  cancelUpstream: () => void;
}

export function attachRequestRuntime({
  request,
  lifecycle,
  cancelUpstream,
}: AttachRequestRuntimeOptions): void {
  const detachUploadObservers = (): void => {
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("aborted", onAborted);
  };
  const detachAll = (): void => {
    detachUploadObservers();
    request.off("error", onError);
    request.off("close", onClose);
  };
  const abortUpload = (signal: RuntimeSignal): void => {
    if (lifecycle.state !== "finished") {
      lifecycle.finish(signal);
      cancelUpstream();
    }
  };
  const onData = (chunk: Buffer): void => lifecycle.recordRequestUpload(chunk.length);
  const onEnd = (): void => lifecycle.recordRequestUploadComplete();
  const onAborted = (): void => {
    abortUpload("request_abort");
    detachUploadObservers();
  };
  const onError = (): void => {
    if (request.complete) lifecycle.recordRequestUploadComplete();
    abortUpload(request.complete ? "runtime_unknown" : "request_abort");
    detachUploadObservers();
  };
  const onClose = (): void => detachAll();
  request.on("data", onData);
  request.once("end", onEnd);
  request.once("aborted", onAborted);
  request.on("error", onError);
  request.once("close", onClose);
}

export function attachDownstreamRuntime({
  response,
  lifecycle,
  onPrematureClose,
  cancelUpstream,
}: AttachDownstreamRuntimeOptions): void {
  response.once("close", () => {
    if (!response.writableFinished && lifecycle.state !== "finished") {
      onPrematureClose?.();
      lifecycle.finish("downstream_close");
      cancelUpstream();
    }
  });
  response.once("error", () => {
    if (lifecycle.state !== "finished") {
      lifecycle.finish("downstream_error");
      cancelUpstream();
    }
  });
}
