// Generated from node-transport-adapter.ts by pnpm run egress:build. Do not edit directly.
export function attachRequestRuntime({ request, lifecycle, cancelUpstream, }) {
    const detachUploadObservers = () => {
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("aborted", onAborted);
    };
    const detachAll = () => {
        detachUploadObservers();
        request.off("error", onError);
        request.off("close", onClose);
    };
    const abortUpload = (signal) => {
        if (lifecycle.state !== "finished") {
            lifecycle.finish(signal);
            cancelUpstream();
        }
    };
    const onData = (chunk) => lifecycle.recordRequestUpload(chunk.length);
    const onEnd = () => lifecycle.recordRequestUploadComplete();
    const onAborted = () => {
        abortUpload("request_abort");
        detachUploadObservers();
    };
    const onError = () => {
        if (request.complete)
            lifecycle.recordRequestUploadComplete();
        abortUpload(request.complete ? "runtime_unknown" : "request_abort");
        detachUploadObservers();
    };
    const onClose = () => detachAll();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.on("error", onError);
    request.once("close", onClose);
}
export function attachDownstreamRuntime({ response, lifecycle, onPrematureClose, cancelUpstream, }) {
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
