import {expect,it,vi} from "vitest";
import {clientDrivenStream} from "../../src/proxy/byte-stream";

it("rejects an oversize upload without buffering or forwarding the crossing chunk",async()=>{
  let pulls=0,cancelled=false;
  const input=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array([1,2]));},cancel(){cancelled=true;}},{highWaterMark:0});
  const output=clientDrivenStream(input,new AbortController().signal,{maxBytes:3});
  expect(pulls).toBe(0);
  const reader=output.getReader();
  try{
    expect((await reader.read()).value).toEqual(new Uint8Array([1,2]));
    await expect(reader.read()).rejects.toMatchObject({code:"byte_limit_exceeded"});
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  }finally{await reader.cancel().catch(()=>undefined);}
});

it("times out a held read, cancels its source, and does not time out downstream backpressure",async()=>{
  vi.useFakeTimers();
  let cancelled=false;
  const input=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}},{highWaterMark:0});
  const reader=clientDrivenStream(input,new AbortController().signal,{idleMs:60000}).getReader();
  try{
    await vi.advanceTimersByTimeAsync(120000);
    expect(cancelled).toBe(false); // no pull, no read timer
    const read=reader.read();
    const result=expect(read).rejects.toMatchObject({code:"stream_idle_timeout"});
    await vi.advanceTimersByTimeAsync(60000);
    await result;
    expect(cancelled).toBe(true);
  }finally{await reader.cancel().catch(()=>undefined);vi.useRealTimers();}
});
