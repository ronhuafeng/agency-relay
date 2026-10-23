import {DurableObject} from "cloudflare:workers";
import OAuth2Server from "@node-oauth/oauth2-server";
import {runtimeOAuthMaterialHash,timingSafeEqualHex} from "../crypto";
import {headerMediaType} from "../records";
import {readConsoleSessionPrincipalByHash} from "../auth/console-session";
import type {ConsolePrincipal} from "../auth/principal";
import {readRuntimeAuthority,readRuntimeAuthorityRevision,readRuntimeMemberInstallations,type RuntimeAuthority,type RuntimeMemberInstallation} from "./installations";
import {runtimeInstallations,RUNTIME_SCOPE,RUNTIME_PROFILES} from "./profiles";

type ClientConsentView={id:string;client_id:string;client_name:string;resource:string;scope:string;created_at:string;expires_at:string};
export interface RuntimeMemberModel {
  installations:RuntimeMemberInstallation[];
  consents:Array<ClientConsentView&{installation:string;authority_revision:number;access_revision:number}>;
  activity:Array<RuntimeTransportFacts&{installation:string;authority_revision:number;client_authorization_id:string;started_at:string;finished_at:string}>;
}
type RuntimeMemberReply={status:number;body:RuntimeMemberModel|{error:string}};
export interface OAuthReply {status:number;body:Record<string,string|number|string[]|ClientConsentView[]>;location?:string}
export type RuntimeAdmission=RuntimeAuthority&{client_authorization_id:string;lease_id:string;lease_expires_at:number};
export type RuntimeTransportError="runtime_profile_unavailable"|"upstream_credential_unavailable"|"upstream_redirect_rejected"|"upstream_transport_failed"|"client_request_aborted"|"runtime_transport_unsupported"|"request_too_large"|"stream_idle_timeout"|"lease_expired";
export interface RuntimeTransportFacts {
  attempted:boolean;upstream_status:number|null;terminal:"completed"|"cancelled"|"error";
  error:RuntimeTransportError|null;duration_ms:number;headers_ms:number|null;
  request_bytes_observed:number;response_bytes_observed:number;
}
type RegisteredClient = {id:string;name:string;redirect:string;expires:number};
interface Pending {
  query:Record<string,string>;installation:string;authorityRevision:number;binding:string;
  principal:ConsolePrincipal|null;accessRevision:number|null;expires:number;
}
type Consent = {
  id:string;subject:string;client:string;installation:string;resource:string;
  access_revision:number;authority_revision:number;deadline:number;revoked:number;created:number;
  scope:string;
}
type Code = {hash:string;consent:string;redirect:string;challenge:string;expires:number;used:number};
type Refresh = {hash:string;consent:string;expires:number;spent:number};
const MINUTE=60000;
const FAMILY_MS=30*86400000;
const unavailable=():OAuthReply=>({status:503,body:{error:"temporarily_unavailable"}});
const invalid=(status=400,error="invalid_request"):OAuthReply=>({status,body:{error}});

/** Organization-scoped OAuth coordination. Provider TokenAuthority is separate. */
export class RuntimeOAuth extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_windows (
      bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS consents (id TEXT PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,
        installation TEXT NOT NULL,resource TEXT NOT NULL,access_revision INTEGER NOT NULL,
        authority_revision INTEGER NOT NULL,deadline INTEGER NOT NULL,revoked INTEGER NOT NULL,created INTEGER NOT NULL,scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY,consent TEXT NOT NULL,redirect TEXT NOT NULL,
        challenge TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_tokens (hash TEXT PRIMARY KEY,consent TEXT NOT NULL,expires INTEGER NOT NULL,spent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_tokens (hash TEXT PRIMARY KEY,consent TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS consents_deadline ON consents(deadline);
      CREATE INDEX IF NOT EXISTS codes_consent ON codes(consent);
      CREATE INDEX IF NOT EXISTS refresh_consent ON refresh_tokens(consent);
      CREATE INDEX IF NOT EXISTS access_consent ON access_tokens(consent);
      CREATE INDEX IF NOT EXISTS access_expires ON access_tokens(expires);`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_leases (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,subject TEXT NOT NULL,
      installation TEXT NOT NULL,consent TEXT NOT NULL,authority_revision INTEGER NOT NULL,
      profile TEXT NOT NULL,profile_revision INTEGER NOT NULL,started INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS relay_lease_capacity ON relay_leases(installation,subject);
      CREATE INDEX IF NOT EXISTS relay_lease_expiry ON relay_leases(expires);
      CREATE TABLE IF NOT EXISTS relay_activity (
        subject TEXT NOT NULL,installation TEXT NOT NULL,sequence INTEGER NOT NULL,
        finished INTEGER NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(subject,installation));`);
  }

  async register(body:Record<string,unknown>):Promise<OAuthReply> {
    const result=this.ctx.storage.transactionSync<OAuthReply>(():OAuthReply=>{
      const now=Date.now();
      // RFC 7591 §2: ignore unrecognized self-asserted metadata, never fetch it.
      // Recognized credential-based registration mechanisms are not supported.
      if(["client_secret","jwks","jwks_uri"].some(key=>Object.hasOwn(body,key)) || body.token_endpoint_auth_method!=="none"
        || !Array.isArray(body.redirect_uris) || body.redirect_uris.length!==1
        || typeof body.redirect_uris[0]!=="string"
        || !validRedirect(body.redirect_uris[0])
        || (body.grant_types!==undefined && !sameSet(body.grant_types,["authorization_code","refresh_token"]))
        || (body.response_types!==undefined && !sameSet(body.response_types,["code"]))
        || (body.scope!==undefined&&body.scope!==""&&body.scope!==RUNTIME_SCOPE)
        || (body.client_name!==undefined && (typeof body.client_name!=="string" || !body.client_name.trim()
          || body.client_name.length>100 || /[\u0000-\u001f\u007f]/.test(body.client_name)))) {
        return {status:400,body:{error:"invalid_client_metadata"}};
      }
      this.ctx.storage.sql.exec("DELETE FROM clients WHERE expires<=?",now);
      if(this.ctx.storage.sql.exec<{count:number}>("SELECT count(*) AS count FROM clients").one().count>=100)
        return {status:429,body:{error:"invalid_request"}};
      const client:RegisteredClient={id:crypto.randomUUID(),name:typeof body.client_name==="string"?body.client_name.trim():"MCP client",redirect:body.redirect_uris[0],expires:now+86400000};
      this.ctx.storage.sql.exec("INSERT INTO clients VALUES (?,?,?,?)",client.id,client.name,client.redirect,client.expires);
      return {status:201,body:{client_id:client.id,client_name:client.name,redirect_uris:[client.redirect],
        token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],scope:RUNTIME_SCOPE,client_id_issued_at:Math.floor(now/1000)}};
    });
    await this.scheduleCleanup();
    return result;
  }

  /** Counts public requests before parsing, including malformed/unknown clients. */
  async protocolAttempt(kind:"registration"|"token"):Promise<boolean> {
    const admitted=this.attempt(kind==="registration"?"registration":"token:organization",kind==="registration"?100:300,kind==="registration"?3600000:MINUTE);
    await this.scheduleCleanup();return admitted;
  }

  async begin(query:Record<string,string>,binding:string,session:string|null):Promise<OAuthReply> {
    return this.gate(async(deadline)=>{
      if(!this.attempt("authorization:organization",300,MINUTE))return invalid(429);
      const client=this.client(query.client_id??"");
      const installation=runtimeInstallations(this.env).find(item=>item.resource===query.resource);
      if(!client||!installation||query.response_type!=="code"||!redirectMatches(client.redirect,query.redirect_uri??"")
        ||query.scope!==RUNTIME_SCOPE||query.code_challenge_method!=="S256"||! /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge??"")
        ||!query.state||query.state.length>512||/[^\x21-\x7e]/.test(query.state))return invalid();
      if(!this.attempt(`authorization:${client.id}`,30,MINUTE))return invalid(429);
      const principal=await this.consolePrincipal(session,deadline);
      const authority=principal?await this.bounded(readRuntimeAuthority(this.env,principal.id,installation.id,new Date(),{hash:session!,email:principal.email,epoch:principal.sessionEpoch}),deadline):null;
      const revision=principal?authority?.authority_revision:await this.bounded(readRuntimeAuthorityRevision(this.env,installation.id),deadline);
      if(revision==null)return invalid(403,"access_denied");
      this.ctx.storage.sql.exec("DELETE FROM pending WHERE expires<=?",Date.now());
      if(this.ctx.storage.sql.exec<{count:number}>("SELECT count(*) AS count FROM pending").one().count>=300)return invalid(429);
      const id=crypto.randomUUID();
      const pending:Pending={query,installation:installation.id,authorityRevision:revision,binding,principal,accessRevision:authority?.access_revision??null,expires:Date.now()+10*MINUTE};
      this.ctx.storage.sql.exec("INSERT INTO pending VALUES (?,?,?)",id,JSON.stringify(pending),pending.expires);
      return {status:303,body:{id},location:`/runtime/consent/${id}`};
    },unavailable());
  }

  async consent(id:string,binding:string,session:string|null,decision?:"allow"|"deny"):Promise<OAuthReply> {
    return this.gate(async(deadline)=>{
      const stored=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM pending WHERE id=? AND expires>?",id,Date.now()).toArray()[0];
      if(!stored)return invalid();
      const pending=JSON.parse(stored.data) as Pending;
      if(!timingSafeEqualHex(pending.binding,binding))return invalid(403,"access_denied");
      const principal=await this.consolePrincipal(session,deadline);
      if(!principal)return {status:303,body:{},location:`/login?return=${encodeURIComponent(`/runtime/consent/${id}`)}`};
      if(pending.principal&&(principal.id!==pending.principal.id||principal.email!==pending.principal.email||principal.sessionEpoch!==pending.principal.sessionEpoch))return invalid(403,"access_denied");
      const authority=await this.bounded(readRuntimeAuthority(this.env,principal.id,pending.installation,new Date(),{hash:session!,email:principal.email,epoch:principal.sessionEpoch}),deadline);
      if(!authority||authority.authority_revision!==pending.authorityRevision||(pending.accessRevision!==null&&authority.access_revision!==pending.accessRevision))return invalid(403,"access_denied");
      const client=this.client(pending.query.client_id!);
      if(!client)return invalid();
      if(!pending.principal) {
        pending.principal=principal;pending.accessRevision=authority.access_revision;
        this.ctx.storage.sql.exec("UPDATE pending SET data=? WHERE id=?",JSON.stringify(pending),id);
      }
      if(!decision)return {status:200,body:{id,client_name:client.name,resource:authority.resource,scope:RUNTIME_SCOPE,email:principal.email,redirect_uri:pending.query.redirect_uri!}};
      return this.ctx.storage.transaction(async()=>{
        this.ctx.storage.sql.exec("DELETE FROM pending WHERE id=?",id);
        this.ctx.storage.sql.exec(`UPDATE consents SET revoked=1 WHERE subject=? AND installation=?
          AND (access_revision<>? OR authority_revision<>?)`,principal.id,pending.installation,authority.access_revision,authority.authority_revision);
        const consent:Consent={id:crypto.randomUUID(),subject:principal.id,client:client.id,installation:pending.installation,
          resource:authority.resource,access_revision:authority.access_revision,authority_revision:authority.authority_revision,
          deadline:Date.now()+FAMILY_MS,revoked:0,created:Date.now(),scope:RUNTIME_SCOPE};
        const count=this.ctx.storage.sql.exec<{count:number}>(`SELECT count(*) AS count FROM consents
          WHERE subject=? AND installation=? AND client<>? AND revoked=0 AND deadline>?
            AND access_revision=? AND authority_revision=?`,principal.id,pending.installation,client.id,Date.now(),authority.access_revision,authority.authority_revision).one().count;
        if(decision==="allow"&&count>=5)return invalid(429);
        const model=this.model(client,consent,deadline);
        const server=new OAuth2Server({model,authorizationCodeLifetime:120,authenticateHandler:{handle:async()=>({id:principal.id})}});
        const response=new OAuth2Server.Response();
        try {
          await server.authorize(new OAuth2Server.Request({method:"GET",headers:{},query:{...pending.query,allowed:decision==="deny"?"false":"true"},body:{}}),response);
        } catch(error) {
          if(!(error instanceof OAuth2Server.OAuthError)||error.code>=500)throw error;
          // Redirect only a fixed protocol error, never the library's description.
          const target=new URL(pending.query.redirect_uri!);target.searchParams.set("error",error.name);target.searchParams.set("state",pending.query.state!);
          return {status:303,body:{},location:target.href};
        }
        return {status:303,body:{},location:response.headers?.location};
      });
    },unavailable());
  }

  async token(encoded:string,contentType:string|null,hasAuthorization:boolean):Promise<OAuthReply> {
    return this.gate(async(deadline)=>{
      const form=new URLSearchParams(encoded);
      const client=this.client(form.getAll("client_id").length===1?form.get("client_id")!:"");
      if(client&&!this.attempt(`token:${client.id}`,30,MINUTE))return invalid(429);
      if(hasAuthorization||headerMediaType(contentType)!=="application/x-www-form-urlencoded")return invalid();
      const allowed=["grant_type","client_id","code","redirect_uri","code_verifier","refresh_token","resource","scope"];
      if([...form].some(([key,value])=>!allowed.includes(key)||form.getAll(key).length!==1||value.length>2048))return invalid();
      const body=Object.fromEntries(form);
      if(!client)return invalid(400,"invalid_client");
      if(body.grant_type!=="authorization_code"&&body.grant_type!=="refresh_token")return invalid(400,"unsupported_grant_type");
      if(body.grant_type==="authorization_code"&&! /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier??""))return invalid();
      const hash=await this.hash(body.grant_type==="authorization_code"?body.code??"":body.refresh_token??"");
      const row=body.grant_type==="authorization_code"
        ?this.ctx.storage.sql.exec<Code>("SELECT * FROM codes WHERE hash=?",hash).toArray()[0]
        :this.ctx.storage.sql.exec<Refresh>("SELECT * FROM refresh_tokens WHERE hash=?",hash).toArray()[0];
      const consent=row?this.currentConsent(row.consent):null;
      if(!consent||consent.client!==client.id||consent.resource!==body.resource)return invalid(400,"invalid_grant");
      if(consent.scope!==RUNTIME_SCOPE)return invalid(400,"invalid_scope");
      return this.ctx.storage.transaction(async()=>{
        const server=new OAuth2Server({model:this.model(client,consent,deadline,hash,row),accessTokenLifetime:600,refreshTokenLifetime:FAMILY_MS/1000,
          requireClientAuthentication:{authorization_code:false,refresh_token:false},alwaysIssueNewRefreshToken:true});
        const response=new OAuth2Server.Response();
        try {
          await server.token(new OAuth2Server.Request({method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","content-length":String(new TextEncoder().encode(encoded).byteLength)},query:{},body}),response);
          return {status:200,body:response.body as OAuthReply["body"]};
        } catch(error) {
          // Expected rejection commits spent credentials/replay invalidation.
          if(!(error instanceof OAuth2Server.OAuthError)||error.code>=500)throw error;
          return invalid(error.code,error.name);
        }
      });
    },unavailable());
  }

  async admit(token:string,resource:string):Promise<RuntimeAdmission|OAuthReply> {
    return this.gate(async(deadline)=>{
      const row=this.ctx.storage.sql.exec<{consent:string;expires:number}>("SELECT consent,expires FROM access_tokens WHERE hash=?",await this.hash(token)).toArray()[0];
      const consent=row&&row.expires>Date.now()?this.currentConsent(row.consent):null;
      if(!consent||consent.resource!==resource)return invalid(401,"invalid_token");
      if(!consent.scope.split(" ").includes(RUNTIME_SCOPE))return invalid(403,"insufficient_scope");
      const authority=await this.bounded(readRuntimeAuthority(this.env,consent.subject,consent.installation),deadline);
      if(!matchesAuthority(consent,authority))return invalid(403,"access_denied");
      const installation=runtimeInstallations(this.env).find(item=>item.id===authority.installation_id)!;
      const profile=RUNTIME_PROFILES[installation.profile];
      return this.ctx.storage.transactionSync<RuntimeAdmission|OAuthReply>(()=>{
        const now=Date.now();
        // At most 16 declarations x 16 leases. Expiry is checked at admission;
        // a delayed alarm or lost release never creates unbounded capacity.
        this.ctx.storage.sql.exec("DELETE FROM relay_leases WHERE expires<=?",now);
        const count=this.ctx.storage.sql.exec<{installation:number;member:number}>(`SELECT count(*) AS installation,
          coalesce(sum(subject=?),0) AS member FROM relay_leases WHERE installation=?`,authority.subject,authority.installation_id).one();
        if(count.installation>=16||count.member>=4)return invalid(429,"runtime_capacity_exceeded");
        const lease={id:crypto.randomUUID(),expires:now+10*MINUTE};
        this.ctx.storage.sql.exec("INSERT INTO relay_leases(id,subject,installation,consent,authority_revision,profile,profile_revision,started,expires) VALUES(?,?,?,?,?,?,?,?,?)",
          lease.id,authority.subject,authority.installation_id,consent.id,authority.authority_revision,installation.profile,profile.revision,now,lease.expires);
        return {...authority,client_authorization_id:consent.id,lease_id:lease.id,lease_expires_at:lease.expires};
      });
    },unavailable());
  }

  /** No upstream I/O. Terminal recording/release cannot hold a response stream.
   * A lost result is safe: the unique lease is deleted at most once. */
  async completeLease(id:string,facts:RuntimeTransportFacts):Promise<void> {
    this.ctx.storage.transactionSync(()=>{
      const lease=this.ctx.storage.sql.exec<{subject:string;installation:string;consent:string;sequence:number;profile:string;profile_revision:number;authority_revision:number;started:number}>("SELECT * FROM relay_leases WHERE id=?",id).toArray()[0];
      if(!lease)return;
      const record={subject:lease.subject,installation:lease.installation,client_authorization_id:lease.consent,
        profile:lease.profile,profile_revision:lease.profile_revision,authority_revision:lease.authority_revision,
        started_at:new Date(lease.started).toISOString(),finished_at:new Date().toISOString(),
        attempted:facts.attempted,upstream_status:facts.upstream_status,terminal:facts.terminal,error:facts.error,
        duration_ms:facts.duration_ms,headers_ms:facts.headers_ms,request_bytes_observed:facts.request_bytes_observed,response_bytes_observed:facts.response_bytes_observed};
      this.ctx.storage.sql.exec("DELETE FROM relay_leases WHERE id=?",id);
      // A delayed completion cannot replace a newer admitted request's facts.
      this.ctx.storage.sql.exec(`INSERT INTO relay_activity VALUES(?,?,?,?,?) ON CONFLICT(subject,installation)
        DO UPDATE SET sequence=excluded.sequence,finished=excluded.finished,facts=excluded.facts
        WHERE excluded.sequence>relay_activity.sequence`,lease.subject,lease.installation,lease.sequence,Date.now(),JSON.stringify(record));
    });
  }

  async clientConsents(session:string|null,revokeId?:string):Promise<OAuthReply> {
    return this.gate(async(deadline)=>{
      const principal=await this.consolePrincipal(session,deadline);
      if(!principal)return invalid(401,"access_denied");
      if(revokeId!==undefined) {
        const row=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM consents WHERE id=? AND subject=?",revokeId,principal.id).toArray()[0];
        if(!row)return invalid(404,"not_found");
        this.ctx.storage.sql.exec("UPDATE consents SET revoked=1 WHERE id=? AND subject=?",revokeId,principal.id);
        return {status:200,body:{revoked:revokeId}};
      }
      // Recorded consent is not a cached entitlement. Admission checks D1 again.
      const rows=this.ctx.storage.sql.exec<{id:string;client_id:string;client_name:string;resource:string;scope:string;created:number;deadline:number}>(`SELECT c.id,c.client AS client_id,r.name AS client_name,c.resource,c.scope,c.created,c.deadline
        FROM consents c JOIN clients r ON r.id=c.client WHERE c.subject=? AND c.revoked=0 AND c.deadline>?
        ORDER BY c.created,c.id LIMIT 81`,principal.id,Date.now()).toArray();
      if(rows.length>80)return unavailable();
      return {status:200,body:{consents:rows.map(({created,deadline,...row})=>({...row,created_at:new Date(created).toISOString(),expires_at:new Date(deadline).toISOString()}))}};
    },unavailable());
  }

  async memberData(session:string|null):Promise<RuntimeMemberReply> {
    return this.gate<RuntimeMemberReply>(async(deadline)=>{
      const principal=await this.consolePrincipal(session,deadline);
      if(!principal)return {status:401,body:{error:"access_denied"}};
      const installations=await this.bounded(readRuntimeMemberInstallations(this.env,principal.id),deadline);
      const rows=this.ctx.storage.sql.exec<{id:string;client_id:string;client_name:string;installation:string;resource:string;scope:string;authority_revision:number;access_revision:number;created:number;deadline:number}>(`
        SELECT c.id,c.client AS client_id,r.name AS client_name,c.installation,c.resource,c.scope,c.authority_revision,c.access_revision,c.created,c.deadline
        FROM consents c JOIN clients r ON r.id=c.client
        WHERE c.subject=? AND c.revoked=0 AND c.deadline>? ORDER BY c.created,c.id LIMIT 81`,principal.id,Date.now()).toArray();
      if(rows.length>80)return {status:503,body:{error:"temporarily_unavailable"}};
      const activity:RuntimeMemberModel["activity"]=[];
      if(installations.length)for(const row of this.ctx.storage.sql.exec<{installation:string;facts:string}>(`
        SELECT installation,facts FROM relay_activity WHERE subject=? AND installation IN (${installations.map(()=>"?").join(",")})
        ORDER BY installation LIMIT 17`,principal.id,...installations.map(item=>item.id)).toArray()) {
        const fact=JSON.parse(row.facts) as RuntimeTransportFacts&{authority_revision:number;client_authorization_id:string;started_at:string;finished_at:string};
        activity.push({installation:row.installation,authority_revision:fact.authority_revision,client_authorization_id:fact.client_authorization_id,
          started_at:fact.started_at,finished_at:fact.finished_at,attempted:fact.attempted,upstream_status:fact.upstream_status,
          terminal:fact.terminal,error:fact.error,duration_ms:fact.duration_ms,headers_ms:fact.headers_ms,
          request_bytes_observed:fact.request_bytes_observed,response_bytes_observed:fact.response_bytes_observed});
      }
      const current=await this.bounded(readConsoleSessionPrincipalByHash(this.env,session!),deadline);
      if(!current||current.id!==principal.id||current.email!==principal.email||current.role!==principal.role||current.sessionEpoch!==principal.sessionEpoch)
        return {status:401,body:{error:"access_denied"}};
      return {status:200,body:{installations,consents:rows.map(({created,deadline,...row})=>({...row,created_at:new Date(created).toISOString(),expires_at:new Date(deadline).toISOString()})),activity}};
    },{status:503,body:{error:"temporarily_unavailable"}});
  }

  private model(client:RegisteredClient,consent:Consent,deadline:number,hash?:string,row?:Code|Refresh):OAuth2Server.AuthorizationCodeModel&OAuth2Server.RefreshTokenModel {
    const wire:OAuth2Server.Client={id:client.id,redirectUris:[client.redirect],grants:["authorization_code","refresh_token"]};
    const user={id:consent.subject};
    const hasCurrentAuthority=async()=>matchesAuthority(consent,await this.bounded(readRuntimeAuthority(this.env,consent.subject,consent.installation),deadline));
    return {
      getClient:async(id,secret)=>id===client.id&&!secret?wire:false,
      validateRedirectUri:async(uri)=>redirectMatches(client.redirect,uri),
      validateScope:async(_user,_client,scope)=>!scope||scope.length===0||sameSet(scope,[RUNTIME_SCOPE])?[RUNTIME_SCOPE]:false,
      getAccessToken:async()=>false,
      saveAuthorizationCode:async(code)=>{
        const codeHash=await this.hash(code.authorizationCode);
        if(performance.now()>=deadline)throw new Error();
        this.ctx.storage.sql.exec("UPDATE consents SET revoked=1 WHERE subject=? AND installation=? AND client=?",consent.subject,consent.installation,client.id);
        this.ctx.storage.sql.exec("INSERT INTO consents VALUES (?,?,?,?,?,?,?,?,?,?,?)",consent.id,consent.subject,consent.client,consent.installation,consent.resource,consent.access_revision,consent.authority_revision,consent.deadline,0,consent.created,(code.scope??[]).join(" "));
        this.ctx.storage.sql.exec("UPDATE clients SET expires=max(expires,?) WHERE id=?",consent.deadline,client.id);
        this.ctx.storage.sql.exec("INSERT INTO codes VALUES (?,?,?,?,?,0)",codeHash,consent.id,code.redirectUri,code.codeChallenge!,code.expiresAt.getTime());
        return {...code,client:wire,user};
      },
      getAuthorizationCode:async(code)=>{
        if(!row||!("used" in row)||await this.hash(code)!==hash)return false;
        if(row.used){this.ctx.storage.sql.exec("UPDATE consents SET revoked=1 WHERE id=?",consent.id);return false;}
        if(!await hasCurrentAuthority())return false;
        return {authorizationCode:code,expiresAt:new Date(row.expires),redirectUri:row.redirect,codeChallenge:row.challenge,codeChallengeMethod:"S256",scope:[RUNTIME_SCOPE],client:wire,user};
      },
      revokeAuthorizationCode:async()=>{this.ctx.storage.sql.exec("UPDATE codes SET used=1 WHERE hash=?",hash!);return true;},
      getRefreshToken:async(refresh)=>{
        if(!row||!("spent" in row)||await this.hash(refresh)!==hash)return false;
        if(row.spent){this.ctx.storage.sql.exec("UPDATE consents SET revoked=1 WHERE id=?",consent.id);return false;}
        if(!await hasCurrentAuthority())return false;
        return {refreshToken:refresh,refreshTokenExpiresAt:new Date(row.expires),scope:[RUNTIME_SCOPE],client:wire,user};
      },
      revokeToken:async()=>{this.ctx.storage.sql.exec("UPDATE refresh_tokens SET spent=1 WHERE hash=?",hash!);return true;},
      saveToken:async(token)=>{
        if(!token.accessTokenExpiresAt||!token.refreshToken||!token.refreshTokenExpiresAt)throw new Error();
        token.accessTokenExpiresAt=new Date(Math.min(token.accessTokenExpiresAt.getTime(),consent.deadline));
        token.refreshTokenExpiresAt=new Date(consent.deadline);
        const accessHash=await this.hash(token.accessToken),refreshHash=await this.hash(token.refreshToken);
        if(performance.now()>=deadline)throw new Error();
        this.ctx.storage.sql.exec("INSERT INTO access_tokens VALUES (?,?,?)",accessHash,consent.id,token.accessTokenExpiresAt.getTime());
        this.ctx.storage.sql.exec("INSERT INTO refresh_tokens VALUES (?,?,?,0)",refreshHash,consent.id,consent.deadline);
        // The library omits client/user from its input type; keep the required token field explicit.
        return {...token,accessToken:token.accessToken,client:wire,user};
      }
    };
  }

  private client(id:string):RegisteredClient|null {return this.ctx.storage.sql.exec<RegisteredClient>("SELECT * FROM clients WHERE id=? AND expires>?",id,Date.now()).toArray()[0]??null;}
  private currentConsent(id:string):Consent|null {return this.ctx.storage.sql.exec<Consent>("SELECT * FROM consents WHERE id=? AND revoked=0 AND deadline>?",id,Date.now()).toArray()[0]??null;}
  private hash(value:string):Promise<string> {return runtimeOAuthMaterialHash(this.env.API_KEY_HASH_PEPPER,value);}
  private attempt(bucket:string,limit:number,window:number):boolean {
    this.ctx.storage.sql.exec("DELETE FROM rate_windows WHERE bucket IN (SELECT bucket FROM rate_windows WHERE expires<=? LIMIT 256)",Date.now());
    const period=Math.floor(Date.now()/window);
    return this.ctx.storage.sql.exec<{attempts:number}>(`INSERT INTO rate_windows VALUES (?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,`${bucket}:${period}`,(period+1)*window).one().attempts<=limit;
  }
  private async gate<T>(work:(deadline:number)=>Promise<T>,failure:T):Promise<T> {
    return this.ctx.blockConcurrencyWhile(async()=>{try {
      const deadline=performance.now()+5000;
      const result=await work(deadline);return performance.now()<deadline?result:failure;
    }catch{
      console.error(JSON.stringify({event:"runtime_oauth_authority_unavailable"}));return failure;
    }});
  }
  private consolePrincipal(session:string|null,deadline:number):Promise<ConsolePrincipal|null> {
    return session?this.bounded(readConsoleSessionPrincipalByHash(this.env,session),deadline):Promise.resolve(null);
  }

  private async bounded<T>(work:Promise<T>,deadline:number):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error()),Math.max(0,deadline-performance.now()));})]);
      if(performance.now()>=deadline)throw new Error();return result;
    }
    finally {if(timer!==undefined)clearTimeout(timer);}
  }
  private async scheduleCleanup():Promise<void> {
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+10*MINUTE);
  }

  async alarm():Promise<void> {
    const now=Date.now();
    this.ctx.storage.transactionSync(()=>{
      const ended=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM consents WHERE deadline<=? LIMIT 128",now-10*MINUTE).toArray().map(row=>row.id);
      if(ended.length) {
        const ids=JSON.stringify(ended);
        for(const table of ["codes","refresh_tokens","access_tokens"])this.ctx.storage.sql.exec(`DELETE FROM ${table}
          WHERE hash IN (SELECT hash FROM ${table} WHERE consent IN (SELECT value FROM json_each(?)) LIMIT 256)`,ids);
        // Partial cleanup retains the family identity; later alarms continue.
        this.ctx.storage.sql.exec(`DELETE FROM consents WHERE id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS(SELECT 1 FROM codes WHERE consent=consents.id)
          AND NOT EXISTS(SELECT 1 FROM refresh_tokens WHERE consent=consents.id)
          AND NOT EXISTS(SELECT 1 FROM access_tokens WHERE consent=consents.id)`,ids);
      }
      this.ctx.storage.sql.exec("DELETE FROM pending WHERE id IN (SELECT id FROM pending WHERE expires<=? LIMIT 300)",now);
      this.ctx.storage.sql.exec("DELETE FROM access_tokens WHERE hash IN (SELECT hash FROM access_tokens WHERE expires<=? LIMIT 256)",now-10*MINUTE);
      this.ctx.storage.sql.exec("DELETE FROM rate_windows WHERE bucket IN (SELECT bucket FROM rate_windows WHERE expires<=? LIMIT 256)",now);
      this.ctx.storage.sql.exec("DELETE FROM clients WHERE id IN (SELECT id FROM clients WHERE expires<=? LIMIT 100)",now);
      this.ctx.storage.sql.exec("DELETE FROM relay_leases WHERE expires<=?",now);
      this.ctx.storage.sql.exec("DELETE FROM relay_activity WHERE rowid IN (SELECT rowid FROM relay_activity WHERE finished<=? LIMIT 256)",now-FAMILY_MS);
    });
    const retained=this.ctx.storage.sql.exec<{count:number}>(`SELECT (SELECT count(*) FROM clients)
      +(SELECT count(*) FROM pending)+(SELECT count(*) FROM consents)+(SELECT count(*) FROM rate_windows)
      +(SELECT count(*) FROM relay_leases)+(SELECT count(*) FROM relay_activity) AS count`).one().count;
    if(retained)await this.ctx.storage.setAlarm(now+10*MINUTE);
  }
}

function matchesAuthority(consent:Consent,authority:RuntimeAuthority|null):authority is RuntimeAuthority {
  return !!authority&&authority.resource===consent.resource&&authority.access_revision===consent.access_revision&&authority.authority_revision===consent.authority_revision;
}
function redirectMatches(registered:string,requested:string):boolean {
  if(registered===requested)return true;
  try {
    const expected=new URL(registered),actual=new URL(requested);
    if(expected.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(expected.hostname))return false;
    actual.port=expected.port;return actual.href===expected.href;
  } catch {return false;}
}

function sameSet(value:unknown,expected:string[]):boolean {
  return Array.isArray(value)&&value.length===expected.length&&expected.every(item=>value.includes(item));
}
function validRedirect(value:string):boolean {
  if(value.length>2048)return false;
  try {
    const uri=new URL(value);
    return uri.href===value&&!uri.username&&!uri.password&&!uri.hash
      &&(uri.protocol==="https:" || uri.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(uri.hostname));
  } catch {return false;}
}
