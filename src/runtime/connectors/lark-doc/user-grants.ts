import {base64UrlEncode,decryptJson,encryptJson,hmacSha256Hex} from "../../../crypto";
import type {LarkAppCredential} from "./credentials";
import {larkAuthorizeUrl,larkUserToken,logLarkUserFailure,verifyLarkMember,type LarkUserAccess,type LarkUserTokens} from "./user-oauth";

export interface LarkUserAuthority {
  installation: string;
  subject: string;
  epoch: number;
  access: number;
  authority: number;
  credential: string;
  credentialRevision: number;
}

interface Browser { sessionHash:string; email:string }
type Grant = {
  generation:string;
  fingerprint:string;
  access_expires:number;
  refresh_expires:number;
  refreshing:number;
  iv:string;
  ciphertext:string;
};

/** Stored with the installation owner. The refresh fence survives instance eviction. */
export class LarkUserGrants {
  private readonly pending = new Map<string,Promise<LarkUserAccess|null>>();

  constructor(private readonly storage:DurableObjectStorage, private readonly key:string,
    private readonly loadApp:(authority:LarkUserAuthority)=>Promise<LarkAppCredential|null>,
    private readonly send:(request:Request)=>Promise<Response>) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS lark_user_flows (
      subject TEXT PRIMARY KEY, state_hash TEXT NOT NULL, session_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
      app_revision INTEGER NOT NULL, expires INTEGER NOT NULL, exchanging INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS lark_user_grants (
      subject TEXT PRIMARY KEY, generation TEXT NOT NULL, fingerprint TEXT NOT NULL, app_revision INTEGER NOT NULL,
      access_expires INTEGER NOT NULL, refresh_expires INTEGER NOT NULL, refreshing INTEGER NOT NULL DEFAULT 0,
      iv TEXT NOT NULL, ciphertext TEXT NOT NULL
    );`);
  }

  async begin(authority:LarkUserAuthority,browser:Browser,callback:string,scopes:readonly string[]):Promise<string|null> {
    const app=await this.loadApp(authority);
    if(!app)return null;
    const state=`${authority.installation}.${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
    const [hash,verifier]=await Promise.all([this.derive("state",state),this.derive("pkce",state,browser.sessionHash)]);
    const destination=await larkAuthorizeUrl(app.appId,callback,state,verifier,scopes);
    const now=Date.now();
    this.storage.sql.exec("DELETE FROM lark_user_flows WHERE expires<=?",now);
    this.storage.sql.exec(`INSERT OR REPLACE INTO lark_user_flows(subject,state_hash,session_hash,fingerprint,app_revision,expires)
      VALUES (?,?,?,?,?,?)`,authority.subject,hash,browser.sessionHash,fingerprint(authority),authority.credentialRevision,now+600_000);
    return destination;
  }

  async finish(authority:LarkUserAuthority,browser:Browser,callback:string,state:string,code:string,stillAuthorized:()=>Promise<boolean>):Promise<boolean> {
    const [hash,verifier]=await Promise.all([this.derive("state",state),this.derive("pkce",state,browser.sessionHash)]);
    const fingerprintValue=fingerprint(authority);
    const reserved=this.storage.sql.exec(`UPDATE lark_user_flows SET exchanging=1
      WHERE subject=? AND state_hash=? AND session_hash=? AND fingerprint=? AND expires>? AND exchanging=0 RETURNING subject`,
    authority.subject,hash,browser.sessionHash,fingerprintValue,Date.now()).toArray();
    if(!reserved.length)return logLarkUserFailure("state");
    let stage:"app_credential"|"token"|"identity"|"grant"="app_credential";
    try {
      const app=await this.loadApp(authority);
      if(!app)return logLarkUserFailure(stage);
      stage="token";
      const material=await larkUserToken(app,{grant_type:"authorization_code",code,redirect_uri:callback,code_verifier:verifier},this.send);
      stage="identity";
      if(!await verifyLarkMember(material.accessToken,browser.email,this.send))return logLarkUserFailure(stage);
      stage="grant";
      const encrypted=await this.seal(authority,hash,material);
      if(!await stillAuthorized())return logLarkUserFailure("authority");
      const saved=this.storage.sql.exec(`INSERT INTO lark_user_grants
        (subject,generation,fingerprint,app_revision,access_expires,refresh_expires,iv,ciphertext)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM lark_user_flows WHERE subject=? AND state_hash=? AND expires>?)
        ON CONFLICT(subject) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint,app_revision=excluded.app_revision,
          access_expires=excluded.access_expires,refresh_expires=excluded.refresh_expires,refreshing=0,iv=excluded.iv,ciphertext=excluded.ciphertext
        RETURNING subject`,authority.subject,hash,fingerprintValue,authority.credentialRevision,material.accessExpiresAt,material.refreshExpiresAt,
      encrypted.iv,encrypted.ciphertext,authority.subject,hash,Date.now()).toArray();
      return saved.length===1||logLarkUserFailure(stage);
    } catch(error) {
      return logLarkUserFailure(stage,error);
    } finally {
      this.storage.sql.exec("DELETE FROM lark_user_flows WHERE subject=? AND state_hash=?",authority.subject,hash);
    }
  }

  disconnect(subject:string):void {
    this.storage.transactionSync(()=>{
      this.storage.sql.exec("DELETE FROM lark_user_flows WHERE subject=?",subject);
      this.storage.sql.exec("DELETE FROM lark_user_grants WHERE subject=?",subject);
    });
  }

  clean(upTo:number,keepRevision:number|null):void {
    for(const table of ["lark_user_flows","lark_user_grants"]) {
      this.storage.sql.exec(`DELETE FROM ${table} WHERE app_revision<=? AND (? IS NULL OR app_revision<>?)`,upTo,keepRevision,keepRevision);
    }
  }

  connected(authority:LarkUserAuthority):boolean {
    const grant=this.grant(authority);
    return !!grant && (grant.refreshing===1 ? this.pending.has(grant.generation)
      : Math.max(grant.access_expires,grant.refresh_expires)>Date.now());
  }

  async read(authority:LarkUserAuthority):Promise<LarkUserAccess|null> {
    const grant=this.grant(authority);
    if(!grant)return null;
    if(grant.refreshing)return this.pending.get(grant.generation)??null;
    const now=Date.now();
    if(grant.access_expires>now+60_000 || grant.refresh_expires<=now) {
      if(grant.access_expires<=now)return null;
      const {accessToken,scopes}=await this.open(authority,grant);
      return this.current(authority,grant)&&grant.access_expires>Date.now()&&Array.isArray(scopes)?{accessToken,scopes}:null;
    }
    const reserved=this.storage.sql.exec(`UPDATE lark_user_grants SET refreshing=1
      WHERE subject=? AND generation=? AND refreshing=0 RETURNING subject`,authority.subject,grant.generation).toArray();
    if(!reserved.length)return null;
    const next=this.refresh(authority,grant).finally(()=>this.pending.delete(grant.generation));
    this.pending.set(grant.generation,next);
    return next;
  }

  private async refresh(authority:LarkUserAuthority,grant:Grant):Promise<LarkUserAccess|null> {
    try {
      const [app,prior]=await Promise.all([this.loadApp(authority),this.open(authority,grant)]);
      if(!app||!this.current(authority,grant)||grant.refresh_expires<=Date.now())return null;
      const fresh=await larkUserToken(app,{grant_type:"refresh_token",refresh_token:prior.refreshToken},this.send);
      const sealed=await this.seal(authority,grant.generation,fresh);
      const saved=this.storage.sql.exec(`UPDATE lark_user_grants SET access_expires=?,refresh_expires=?,iv=?,ciphertext=?,refreshing=0
        WHERE subject=? AND generation=? AND refreshing=1 RETURNING subject`,fresh.accessExpiresAt,fresh.refreshExpiresAt,sealed.iv,
      sealed.ciphertext,authority.subject,grant.generation).toArray();
      return saved.length&&fresh.accessExpiresAt>Date.now()?{accessToken:fresh.accessToken,scopes:fresh.scopes}:null;
    } catch {
      // The provider may have spent the old refresh token. Require new consent.
      return null;
    } finally {
      this.storage.sql.exec("DELETE FROM lark_user_grants WHERE subject=? AND generation=? AND refreshing=1",authority.subject,grant.generation);
    }
  }

  private grant(authority:LarkUserAuthority):Grant|undefined {
    return this.storage.sql.exec<Grant>("SELECT * FROM lark_user_grants WHERE subject=? AND fingerprint=?",authority.subject,fingerprint(authority)).toArray()[0];
  }

  private current(authority:LarkUserAuthority,grant:Grant):boolean {
    return this.grant(authority)?.generation===grant.generation;
  }

  private derive(purpose:string,...parts:string[]):Promise<string> {
    if(!this.key)throw new Error("Runtime encryption unavailable");
    return hmacSha256Hex(this.key,JSON.stringify(["agency-relay/lark-user/v1",purpose,...parts]));
  }

  private async seal(authority:LarkUserAuthority,generation:string,tokens:LarkUserTokens) {
    return encryptJson(await this.derive("grant",authority.installation,authority.subject,generation),tokens);
  }

  private async open(authority:LarkUserAuthority,grant:Grant):Promise<LarkUserTokens> {
    return decryptJson(await this.derive("grant",authority.installation,authority.subject,grant.generation),grant);
  }
}

export function fingerprint(authority:LarkUserAuthority):string {
  return JSON.stringify([authority.epoch,authority.access,authority.authority,authority.credential,authority.credentialRevision]);
}
