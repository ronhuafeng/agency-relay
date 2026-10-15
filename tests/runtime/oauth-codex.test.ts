import {execFile,execFileSync,spawn} from "node:child_process";
import {promisify} from "node:util";
import {once} from "node:events";
import {createServer as httpServer,type IncomingMessage} from "node:http";
import {createServer as httpsServer} from "node:https";
import {connect} from "node:net";
import type {Duplex} from "node:stream";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {oauthFixture,ISSUER,RESOURCE} from "./oauth-fixture";

// Actual pinned client consumes production metadata/authorize/model/token and
// protected admission. Only the identity and remote MCP task are synthetic.
it("lets Codex 0.156.1 complete production OAuth consent and read the protected catalogue",async()=>{
  const bin=process.env.CODEX_TEST_BIN??"/tmp/codex-cli/node_modules/.bin/codex";
  const version=await promisify(execFile)(bin,["--version"],{timeout:10000,maxBuffer:1024});
  if(version.stdout.trim()!=="codex-cli 0.156.1")throw new Error("Pinned Codex client is not prepared");
  const directory=await mkdtemp(join(tmpdir(),"relay-oauth-client-"));
  const sockets=new Set<Duplex>();
  const servers:ReturnType<typeof httpServer>[]=[];
  let f:Awaited<ReturnType<typeof oauthFixture>>|undefined;
  const unexpected:string[]=[];
  try {
    f=await oauthFixture();
    const cert=join(directory,"root.pem"),key=join(directory,"key.pem"),leaf=join(directory,"certificate.pem");
    execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=Runtime fixture root","-keyout",join(directory,"root.key"),"-out",cert],{stdio:"ignore"});
    execFileSync("openssl",["req","-new","-newkey","rsa:2048","-nodes","-subj","/CN=console.example.test","-keyout",key,"-out",join(directory,"leaf.csr")],{stdio:"ignore"});
    await writeFile(join(directory,"leaf.ext"),"basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:console.example.test,DNS:design.example.test\n");
    execFileSync("openssl",["x509","-req","-in",join(directory,"leaf.csr"),"-CA",cert,"-CAkey",join(directory,"root.key"),"-CAcreateserial","-days","1","-extfile",join(directory,"leaf.ext"),"-out",leaf],{stdio:"ignore"});
    const tls=httpsServer({key:await readFile(key),cert:await readFile(leaf)},async(incoming,outgoing)=>{
      try {
        const origin=`https://${incoming.headers.host}`;
        if(![ISSUER,new URL(RESOURCE).origin].includes(origin)){outgoing.writeHead(421).end();return;}
        const headers=new Headers();for(const [name,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(", "):value);
        const bytes=await body(incoming);
        const response=await f!.runtime.dispatchFetch(new URL(incoming.url??"/",origin).href,{method:incoming.method,headers,body:bytes.length?bytes:undefined,redirect:"manual"});
        outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {unexpected.push("transport_failure");outgoing.writeHead(500).end();}
    });
    await listen(tls);servers.push(tls);
    const proxy=httpServer((_request,response)=>{unexpected.push("non_tls_target");response.writeHead(403).end();});
    proxy.on("connect",(request,client,head)=>{
      // Own rejected CONNECT sockets too. Native child shutdown can reset a
      // rejected startup/update connection after the 403 has been sent.
      sockets.add(client);client.on("close",()=>sockets.delete(client));
      client.on("error",()=>client.destroy());
      if(!["console.example.test:443","design.example.test:443"].includes(request.url??"")){
        // Codex startup/update traffic is outside Agency Relay's OAuth contract.
        // Block it all; do not make this test an external-client QA gate.
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");return;
      }
      const upstream=connect(port(tls),"127.0.0.1",()=>{client.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
      sockets.add(upstream);upstream.on("close",()=>sockets.delete(upstream));upstream.on("error",()=>client.destroy());client.on("error",()=>upstream.destroy());
    });
    await listen(proxy);servers.push(proxy);
    // A synthetic human makes the explicit decision through unchanged browser
    // endpoints. No production handler auto-approves a native client's request.
    const browser=httpServer(async(request,response)=>{
      try {
        if(request.method!=="POST"||request.url!=="/decision"){response.writeHead(404).end();return;}
        const target=new URL((await body(request)).toString());
        if(target.origin!==ISSUER||target.pathname!=="/runtime/authorize"){response.writeHead(403).end();return;}
        const begun=await f!.runtime.dispatchFetch(target.href,{headers:{Cookie:f!.cookies.get("member")!},redirect:"manual"});
        if(begun.status!==303)throw new Error();
        const consent=new URL(begun.headers.get("Location")!,ISSUER);
        const cookie=`${f!.cookies.get("member")}; ${begun.headers.get("Set-Cookie")!.split(";",1)[0]}`;
        const shown=await f!.runtime.dispatchFetch(consent.href,{headers:{Cookie:cookie}});
        if(shown.status!==200)throw new Error();
        const allowed=await f!.runtime.dispatchFetch(consent.href,{method:"POST",headers:{Cookie:cookie,Origin:ISSUER,"Content-Type":"application/x-www-form-urlencoded"},body:"decision=allow",redirect:"manual"});
        if(allowed.status!==303)throw new Error();
        response.writeHead(200,{"Content-Type":"text/plain"}).end(allowed.headers.get("Location"));
      } catch {unexpected.push("consent_failure");response.writeHead(500).end();}
    });
    await listen(browser);servers.push(browser);
    await writeFile(join(directory,"config.toml"),`mcp_oauth_credentials_store = "file"\n[mcp_servers.probe]\nurl = "${RESOURCE}"\n`);
    const env:NodeJS.ProcessEnv={...process.env,HOME:directory,CODEX_HOME:directory,HTTPS_PROXY:`http://127.0.0.1:${port(proxy)}`,HTTP_PROXY:`http://127.0.0.1:${port(proxy)}`,NO_PROXY:"localhost,127.0.0.1,::1",CODEX_CA_CERTIFICATE:cert,SSL_CERT_FILE:cert};
    // Do not inherit operator/provider credentials, user config or global proxies.
    const allowed=new Set(["PATH","HOME","CODEX_HOME","HTTPS_PROXY","HTTP_PROXY","NO_PROXY","CODEX_CA_CERTIFICATE","SSL_CERT_FILE"]);
    for(const name of Object.keys(env))if(!allowed.has(name))delete env[name];
    const child=spawn("python3",["-c",LOGIN,bin,`http://127.0.0.1:${port(browser)}/decision`],{env,detached:true,stdio:["ignore","pipe","ignore"]});
    const closed=once(child,"close");let output="";child.stdout.on("data",chunk=>{output+=String(chunk);});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Native OAuth login exceeded its bounded test")),25000);})]);
      expect(output.trim()==="success").toBe(true);
    } finally {if(timer!==undefined)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null&&child.pid)process.kill(-child.pid,"SIGKILL");await closed;}
    const status=await catalogue(bin,env);
    expect(status.authenticated).toBe(true);expect(status.tools).toContain("synthetic_probe");
    const inventory=await f.runtime.dispatchFetch(`${ISSUER}/runtime/clients`,{headers:{Cookie:f.cookies.get("member")!}});
    const grants=await inventory.json() as {consents:{id:string}[]};
    expect(grants.consents.length).toBe(1);
    const revoked=await f.runtime.dispatchFetch(`${ISSUER}/runtime/clients/${grants.consents[0]!.id}`,{method:"DELETE",headers:{Cookie:f.cookies.get("member")!,Origin:ISSUER}});
    expect(revoked.status).toBe(200);
    expect((await catalogue(bin,env)).tools).not.toContain("synthetic_probe");
    expect(unexpected).toEqual([]);
  } finally {
    for(const socket of sockets)socket.destroy();
    for(const server of servers){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    await f?.dispose();await rm(directory,{recursive:true,force:true});
  }
},60000);

async function listen(server:ReturnType<typeof httpServer>):Promise<void> {await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});}
function port(server:ReturnType<typeof httpServer>):number {const address=server.address();if(!address||typeof address==="string")throw new Error("Fixture has no port");return address.port;}
async function body(request:IncomingMessage):Promise<Buffer> {const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>16384)throw new Error();chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}

async function catalogue(bin:string,env:NodeJS.ProcessEnv):Promise<{authenticated:boolean;tools:string[]}> {
  const child=spawn(bin,["app-server"],{cwd:tmpdir(),env,stdio:["pipe","pipe","ignore"]});
  const closed=once(child,"close");let pending="";
  const messages=new Map<number,(value:Record<string,unknown>)=>void>();
  const onData=(chunk:Buffer)=>{pending+=String(chunk);const lines=pending.split("\n");pending=lines.pop()??"";for(const line of lines){const value=JSON.parse(line) as Record<string,unknown>;if(typeof value.id==="number")messages.get(value.id)?.(value);}};
  child.stdout.on("data",onData);
  const call=(id:number,method:string,params:unknown)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer=setTimeout(()=>{messages.delete(id);reject(new Error("Native MCP status exceeded its bounded test"));},15000);
    messages.set(id,value=>{clearTimeout(timer);messages.delete(id);resolve(value);});
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`);
  });
  try {
    await call(1,"initialize",{clientInfo:{name:"probe",version:"0"},capabilities:{experimentalApi:true}});
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",method:"initialized"})}\n`);
    const result=await call(2,"mcpServerStatus/list",{detail:"toolsAndAuthOnly",limit:5});
    if(result.error||!result.result)throw new Error("Native MCP status failed");
    let authenticated=false;const tools:string[]=[];
    const walk=(value:unknown)=>{if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==="object")for(const [key,item] of Object.entries(value)){if(key==="authStatus"&&item==="oAuth")authenticated=true;if(key==="name"&&typeof item==="string")tools.push(item);else walk(item);}};
    walk(result.result);return {authenticated,tools};
  } finally {child.stdout.off("data",onData);child.kill("SIGKILL");await closed;}
}

const LOGIN=String.raw`
import os, pty, select, subprocess, sys, time
from urllib.request import Request, urlopen
bin, decision = sys.argv[1:]
master, slave = pty.openpty()
login = subprocess.Popen([bin,"mcp","login","probe","--no-browser","--oauth-client-registration","dcr"],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
buf = b""
url = None
deadline = time.time()+15
try:
    while time.time()<deadline and url is None and login.poll() is None:
        ready,_,_ = select.select([master],[],[],1)
        if ready:
            try: buf += os.read(master,4096)
            except OSError: break
            text = buf.decode("utf-8","replace")
            marker = "https://console.example.test/runtime/authorize?"
            if marker in text: url = text[text.index(marker):].split()[0].strip()
    if url:
        callback = urlopen(Request(decision,data=url.encode(),method="POST"),timeout=8).read().decode()
        urlopen(callback,timeout=5).read()
    deadline = time.time()+8
    while time.time()<deadline and login.poll() is None and b"Successfully logged in" not in buf:
        ready,_,_ = select.select([master],[],[],1)
        if ready:
            try: buf += os.read(master,4096)
            except OSError: break
    if b"Successfully logged in" in buf: print("success")
    else: print("failed")
finally:
    if login.poll() is None: login.kill()
    login.wait()
    os.close(master)
`;
