import { createRequire } from "node:module";
import { build } from "esbuild";

const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.resolve("wrangler/package.json"))("miniflare");

/** Test-only transport to the unchanged production RPC owner in workerd. */
export async function credentialFixture(persist?: string) {
  const compiled = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: "runtime-credential-fixture.ts", contents: `
      export { RuntimeCredentials } from "./src/runtime/credentials";
      export default { async fetch(request, env) {
        const {id,method,args} = await request.json();
        const owner = env.RUNTIME_CREDENTIALS.getByName(id);
        try {
          if (!['put','clean','read'].includes(method)) return new Response(null,{status:404});
          const value = await owner[method](id,...args);
          return Response.json({value:value ?? null});
        } catch { return new Response(null,{status:409}); }
      }};` },
    bundle:true,write:false,format:"esm",platform:"node",external:["cloudflare:workers"],logLevel:"silent"
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules:true,script:compiled.outputFiles[0]!.text,compatibilityDate:"2026-06-24",
    bindings:{TOKEN_ENCRYPTION_KEY_V1:"synthetic-runtime-encryption-key"},
    durableObjects:{RUNTIME_CREDENTIALS:{className:"RuntimeCredentials",useSQLite:true}},
    ...(persist ? {resourcePersistencePath:persist} : {})
  }));
  const call = async (id:string,method:string,args:unknown[]) => {
    const response = await runtime.dispatchFetch("https://fixture.test/rpc",{method:"POST",body:JSON.stringify({id,method,args})});
    if (!response.ok) throw new Error("Runtime credential RPC rejected");
    return (await response.json() as {value:unknown}).value;
  };
  const namespace = {getByName:(id:string) => ({
    put:(_id:string,ref:string,revision:number,material:string) => call(id,"put",[ref,revision,material]),
    clean:(_id:string,revision:number,keep:string|null) => call(id,"clean",[revision,keep]),
    read:(_id:string,ref:string,revision:number) => call(id,"read",[ref,revision])
  })} as unknown as Env["RUNTIME_CREDENTIALS"];
  return {namespace,dispose:() => runtime.dispose() as Promise<void>};
}
