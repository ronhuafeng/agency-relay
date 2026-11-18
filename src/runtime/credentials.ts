import { DurableObject } from "cloudflare:workers";
import { decryptJson,encryptJson,hmacSha256Hex } from "../crypto";
import { isLarkAppCredential,LarkTenantTokenCache,type LarkAppCredential } from "./connectors/lark-doc/credentials";
import {fingerprint,LarkUserGrants,type LarkUserAuthority} from "./connectors/lark-doc/user-grants";
import {larkUserAuthority,readRuntimeAuthority} from "./installations";
import type {LarkUserAccess} from "./connectors/lark-doc/user-oauth";

export type RuntimeCredentialMaterial = string | LarkAppCredential;

/** Internal RPC only. One object per installation, separate from TokenAuthority.
 * Finalization keeps a durable fence even when all encrypted versions are gone. */
export class RuntimeCredentials extends DurableObject<Env> {
  private readonly larkTokens = new Map<string,{revision:number;cache:LarkTenantTokenCache;scoped:LarkTenantTokenCache}>();
  private larkUsers?:LarkUserGrants;

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

  async put(id:string,ref:string,revision:number,material:RuntimeCredentialMaterial):Promise<void> {
    if(!Number.isSafeInteger(revision)||revision<1||!/^[A-Za-z0-9_-]{1,96}$/.test(ref)
      || !(typeof material==="string" ? /^[\x21-\x7e]{1,4096}$/.test(material) : isLarkAppCredential(material))) throw new Error("Invalid Runtime credential");
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
    const cleaned=this.ctx.storage.transactionSync(()=>{
      const fence=this.identity(id);
      if(revision<fence.revision) return false;
      if(revision===fence.revision && keep!==fence.keep_ref) throw new Error("Conflicting Runtime cleanup");
      this.ctx.storage.sql.exec("DELETE FROM versions WHERE revision<=? AND (? IS NULL OR ref<>?)",revision,keep,keep);
      if(this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lark_user_grants'").toArray().length) {
        // Cleanup also fences callbacks and rotations for credentials that were removed.
        const version=this.ctx.storage.sql.exec<{revision:number}>("SELECT revision FROM versions WHERE ref=?",keep).toArray()[0];
        this.personal().clean(revision,version?.revision??null);
      }
      this.ctx.storage.sql.exec("UPDATE fence SET revision=?,keep_ref=? WHERE singleton=1",revision,keep);
      return true;
    });
    if(!cleaned)return;
    for(const [ref,entry] of this.larkTokens) {
      if(entry.revision<=revision&&ref!==keep)this.larkTokens.delete(ref);
    }
  }

  protected fetchLarkToken(request:Request):Promise<Response> {
    return fetch(request);
  }

  private async loadMaterial(id:string,ref:string,revision:number):Promise<RuntimeCredentialMaterial|null> {
    this.identity(id);
    const row=this.ctx.storage.sql.exec<{iv:string;ciphertext:string}>("SELECT iv,ciphertext FROM versions WHERE ref=? AND revision=?",ref,revision).toArray()[0];
    return row?decryptJson<RuntimeCredentialMaterial>(await this.contextKey(id,ref),row):null;
  }

  private versionPresent(ref:string,revision:number):boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM versions WHERE ref=? AND revision=?",ref,revision).toArray().length>0;
  }

  async read(id:string,ref:string,revision:number):Promise<string|null> {
    const material=await this.loadMaterial(id,ref,revision);
    if(typeof material==="string")return material;
    if(!isLarkAppCredential(material)||!this.versionPresent(ref,revision))return null;
    return (await this.readLarkTenant(ref,revision,material,false))?.value??null;
  }

  async readLarkOpenApiTenant(authority:LarkUserAuthority) {
    const app=await this.larkApp(authority);
    return app?this.readLarkTenant(authority.credential,authority.credentialRevision,app,true):null;
  }

  private async readLarkTenant(ref:string,revision:number,material:LarkAppCredential,scoped:boolean) {
    if(!this.versionPresent(ref,revision))return null;
    let entry=this.larkTokens.get(ref);
    if(!entry) {
      entry={revision,cache:new LarkTenantTokenCache(),scoped:new LarkTenantTokenCache(true)};
      this.larkTokens.set(ref,entry);
    }
    const token=await (scoped?entry.scoped:entry.cache).read(material,request=>this.fetchLarkToken(request));
    return this.larkTokens.get(ref)===entry?token:null;
  }

  private personal():LarkUserGrants {
    return this.larkUsers??=new LarkUserGrants(this.ctx.storage,this.env.TOKEN_ENCRYPTION_KEY_V1,
      authority=>this.larkApp(authority),request=>this.fetchLarkToken(request));
  }

  private async larkApp(authority:LarkUserAuthority):Promise<LarkAppCredential|null> {
    const material=await this.loadMaterial(authority.installation,authority.credential,authority.credentialRevision);
    return isLarkAppCredential(material)&&this.versionPresent(authority.credential,authority.credentialRevision)?material:null;
  }

  async beginLarkUser(authority:LarkUserAuthority,browser:{sessionHash:string;email:string},callback:string,scopes:readonly string[]):Promise<string|null> {
    this.identity(authority.installation);
    return this.personal().begin(authority,browser,callback,scopes);
  }

  async finishLarkUser(authority:LarkUserAuthority,browser:{sessionHash:string;email:string},callback:string,state:string,code:string):Promise<boolean> {
    this.identity(authority.installation);
    return this.personal().finish(authority,browser,callback,state,code,async()=>{
      const current=await readRuntimeAuthority(this.env,authority.subject,authority.installation,new Date(),
        {hash:browser.sessionHash,email:browser.email,epoch:authority.epoch});
      return current?.profile==="lark.doc"&&fingerprint(larkUserAuthority(current))===fingerprint(authority);
    });
  }

  async disconnectLarkUser(id:string,subject:string):Promise<void> {
    this.identity(id);
    this.personal().disconnect(subject);
  }

  async readLarkUser(authority:LarkUserAuthority):Promise<LarkUserAccess|null> {
    this.identity(authority.installation);
    return this.personal().read(authority);
  }

  async larkUserStatus(authority:LarkUserAuthority):Promise<"connected"|"required"|"app_required"> {
    this.identity(authority.installation);
    if(this.personal().connected(authority))return "connected";
    return await this.larkApp(authority)?"required":"app_required";
  }
}
