export type ByteStreamEnd="completed"|"cancelled"|"error";
export class ByteStreamError extends Error {
  constructor(readonly code:"byte_limit_exceeded"|"stream_idle_timeout") {super(code);}
}

/** One reader, driven only by downstream pulls. Observation cannot own closure;
 * beforeClose is a separate mandatory safety effect, not an observer. */
export function clientDrivenStream(
  body:ReadableStream<Uint8Array>,signal:AbortSignal,
  observer:{onChunk?:(chunk:Uint8Array)=>void;onEnd?:(kind:ByteStreamEnd,error?:unknown)=>void;beforeClose?:()=>Promise<void>;maxBytes?:number;idleMs?:number}={}
):ReadableStream<Uint8Array> {
  const reader=body.getReader();
  let ended=false;
  let bytes=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let output:ReadableStreamDefaultController<Uint8Array>;
  const finish=(kind:ByteStreamEnd,error?:unknown)=>{
    if(ended)return false;
    ended=true;signal.removeEventListener("abort",abort);
    if(timer!==undefined)clearTimeout(timer);
    try{observer.onEnd?.(kind,error);}catch{/* Observation cannot replace transport. */}
    return true;
  };
  const abort=()=>{
    if(!finish("cancelled"))return;
    output.error(new Error("Client request aborted"));
    void reader.cancel().finally(()=>reader.releaseLock()).catch(()=>undefined);
  };
  const fail=(error:unknown)=>{
    if(!finish("error",error))return;
    output.error(error);void reader.cancel().finally(()=>reader.releaseLock()).catch(()=>undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller){output=controller;signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();},
    async pull(controller){
      try{
        if(observer.idleMs!==undefined)timer=setTimeout(()=>fail(new ByteStreamError("stream_idle_timeout")),observer.idleMs);
        const next=await reader.read();
        if(timer!==undefined){clearTimeout(timer);timer=undefined;}
        if(ended)return;
        if(next.done){
          await observer.beforeClose?.();
          if(ended)return;
          finish("completed");reader.releaseLock();controller.close();return;
        }
        if(observer.maxBytes!==undefined&&next.value.byteLength>observer.maxBytes-bytes){fail(new ByteStreamError("byte_limit_exceeded"));return;}
        bytes=Math.min(Number.MAX_SAFE_INTEGER,bytes+next.value.byteLength);
        try{observer.onChunk?.(next.value);}catch{/* Observation cannot replace bytes. */}
        controller.enqueue(next.value);
      }catch(error){if(finish(signal.aborted?"cancelled":"error",error)){reader.releaseLock();controller.error(error);}}
    },
    async cancel(reason){finish("cancelled");try{await reader.cancel(reason);}finally{reader.releaseLock();}}
  },{highWaterMark:0});
}
