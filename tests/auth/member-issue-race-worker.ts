import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { createTestD1 } from "../support/sqlite-d1";
import { pathToFileURL } from "node:url";
const data=workerData as {file:string;token:string;path:string;body:Record<string,string>;holdFile:string;delay:number;entry:string};
const {handleRequest} = await import(pathToFileURL(data.entry).href) as typeof import("../../src/router");
const db=createTestD1({file:data.file,migrations:"none",timeout:8000,beforeRun:async sql=>{
  if(data.delay&&sql.startsWith("INSERT INTO api_keys")){writeFileSync(data.holdFile,"entered");await new Promise(resolve=>setTimeout(resolve,data.delay));}
}});
const env={DB:db.binding,ADMIN_DASHBOARD_HOST:"admin.example.test",CONSOLE_EMAIL_DOMAIN:"example.com",API_KEY_HASH_PEPPER:"synthetic-race-pepper",TOKEN_AUTHORITY:{idFromName:(name:string)=>name,get:()=>({getFreshAccessToken:async()=>({ok:true,value:{access_token:"synthetic-never-sent"}})})}} as unknown as Env;
try{
  const response=await handleRequest(new Request("https://admin.example.test"+data.path,{method:"POST",headers:{Cookie:`__Host-mini-console=${data.token}`,Origin:"https://admin.example.test",Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(data.body)}),env,{waitUntil:()=>{}},{now:()=>new Date("2026-10-02T00:00:00.000Z"),fetch:async()=>{throw Error("provider forbidden");}});
  const html=await response.text();
  parentPort?.postMessage({status:response.status,oneTime:html.includes('data-one-time-key="true"'),acknowledged:html.includes('data-member-result="confirmed"')});
}catch{parentPort?.postMessage({failed:true});}finally{db.close();}
