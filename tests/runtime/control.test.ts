import {expect,it} from "vitest";
import {handleRequest} from "../../src/router";
import {admin,consoleCookie,makeFixture} from "../router/fixture";

// Same admin operation on bearer and browser surfaces. A member, Provider key,
// or cross-origin browser must not gain it. The consumer is the protected read.
it("protects Runtime control with the current administrator and same-origin boundary",async()=>{
  const fixture=makeFixture({env:{RUNTIME_INSTALLATIONS:JSON.stringify([{id:"design",profile:"google.stitch",resource:"https://design.example.test/mcp",label:"Design"}])}});
  const api="https://api.trustedtunnel.app/admin/runtime-installations/design";
  const consoleUrl="https://admin.example.test/admin/runtime-installations/design";
  const call=(url:string,method:string,headers:Record<string,string>,body?:unknown)=>handleRequest(new Request(url,{method,headers:{"Content-Type":"application/json",...headers},...(body?{body:JSON.stringify(body)}:{})}),fixture.env,fixture.ctx,fixture.deps);
  expect((await call(api,"POST",{Authorization:"Bearer cfwd_synthetic_provider_key"},{action:"configure"})).status).toBe(403);
  expect((await admin(fixture,api,{method:"POST",body:{action:"configure"}})).status).toBe(200);
  expect(await (await admin(fixture,api,{method:"GET"})).json()).toMatchObject({state:"disabled",revision:1,credential_ready:false});
  // Seed the established admin session through the existing fixture path.
  expect((await admin(fixture,consoleUrl,{method:"GET"})).status).toBe(200);
  const cookie=`__Host-mini-console=${await consoleCookie(fixture,"admin@example.com")}`;
  const change={action:"rename",label:"Browser label",expectedRevision:1,operationId:"browser-rename"};
  for(const origin of [undefined,"https://foreign.example.test"]) {
    expect((await call(consoleUrl,"POST",{Cookie:cookie,...(origin?{Origin:origin}:{})},change)).status).toBe(403);
  }
  const member=`__Host-mini-console=${await consoleCookie(fixture,"member@example.com")}`;
  expect((await call(consoleUrl,"POST",{Cookie:member,Origin:"https://admin.example.test"},change)).status).toBe(403);
  expect((await call(consoleUrl,"GET",{Cookie:member})).status).toBe(403);
  expect((await admin(fixture,consoleUrl,{method:"POST",body:change})).status).toBe(200);
  expect(await (await admin(fixture,api,{method:"GET"})).json()).toMatchObject({label:"Browser label",revision:2,resource:"https://design.example.test/mcp"});
  expect(fixture.fetchCalls).toHaveLength(0);
});
