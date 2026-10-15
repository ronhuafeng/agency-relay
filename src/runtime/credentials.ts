import { DurableObject } from "cloudflare:workers";
import { decryptJson,encryptJson,hmacSha256Hex } from "../crypto";

/** Internal RPC only. One object per installation, separate from TokenAuthority.
 * Finalization keeps a durable fence even when all encrypted versions are gone. */
export class RuntimeCredentials extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fence (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation TEXT NOT NULL,
        revision INTEGER NOT NULL, keep_ref TEXT);
        CREATE TABLE IF NOT EXISTS versions (ref TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, iv TEXT NOT NULL, ciphertext TEXT NOT NULL);`);
    });
  }

  private identity(id:string) {
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid Runtime installation");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO fence VALUES(1,?,0,NULL)",id);
    const row=this.ctx.storage.sql.exec<{installation:string;revision:number;keep_ref:string|null}>("SELECT installation,revision,keep_ref FROM fence").one();
    if(row.installation!==id) throw new Error("Runtime installation mismatch");
    return row;
  }

  private async contextKey(id:string,ref:string):Promise<string> {
    if(!this.env.TOKEN_ENCRYPTION_KEY_V1) throw new Error("Runtime encryption unavailable");
    // Domain-separated subkey; Provider ciphertext and its storage never change.
    return hmacSha256Hex(this.env.TOKEN_ENCRYPTION_KEY_V1,JSON.stringify(["agency-relay/runtime-credential/v1",id,ref]));
  }

  async put(id:string,ref:string,revision:number,material:string):Promise<void> {
    if(!Number.isSafeInteger(revision)||revision<1||!/^[A-Za-z0-9_-]{1,96}$/.test(ref)
      || typeof material!=="string" || !/^[\x21-\x7e]{1,4096}$/.test(material)) throw new Error("Invalid Runtime credential");
    this.identity(id);
    const encrypted=await encryptJson(await this.contextKey(id,ref),material);
    this.ctx.storage.transactionSync(()=>{
      // Recheck after crypto awaits: a later cleanup may already have committed.
      if(revision<=this.identity(id).revision) throw new Error("Stale Runtime credential");
      this.ctx.storage.sql.exec("INSERT INTO versions(ref,revision,iv,ciphertext) VALUES(?,?,?,?)",ref,revision,encrypted.iv,encrypted.ciphertext);
    });
  }

  async clean(id:string,revision:number,keep:string|null):Promise<void> {
    if(!Number.isSafeInteger(revision)||revision<1) throw new Error("Invalid Runtime revision");
    this.ctx.storage.transactionSync(()=>{
      const fence=this.identity(id);
      if(revision<fence.revision) return;
      if(revision===fence.revision && keep!==fence.keep_ref) throw new Error("Conflicting Runtime cleanup");
      this.ctx.storage.sql.exec("DELETE FROM versions WHERE revision<=? AND (? IS NULL OR ref<>?)",revision,keep,keep);
      this.ctx.storage.sql.exec("UPDATE fence SET revision=?,keep_ref=? WHERE singleton=1",revision,keep);
    });
  }

  async read(id:string,ref:string,revision:number):Promise<string|null> {
    this.identity(id);
    const row=this.ctx.storage.sql.exec<{iv:string;ciphertext:string}>("SELECT iv,ciphertext FROM versions WHERE ref=? AND revision=?",ref,revision).toArray()[0];
    if(!row) return null;
    return decryptJson<string>(await this.contextKey(id,ref),row);
  }
}
