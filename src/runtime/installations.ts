import { generateId } from "../crypto";
import { d1ChangeCount, OPERATOR_MUTATION_AUDIT_COLUMNS } from "../db";
import { HttpError } from "../errors";
import { isOrganizationLoginUser, organizationDomain, type LifecycleActor } from "../auth/principal";
import { serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "../auth/service-accounts";
import { requireRuntimeInstallation, runtimeInstallations, RUNTIME_PROFILES, type RuntimeInstallationDeclaration } from "./profiles";

interface InstallationRow {
  id:string; resource:string; profile:string; profile_revision:number; label:string;
  state:"disabled"|"enabled"|"retired"; revision:number; authority_revision:number;
  credential_ref:string|null; credential_revision:number|null; operation_id:string|null;
  phase:"ready"|"writing"|"cleaning"; created_at:string; updated_at:string;
}

function declarationMismatch(row: {resource: string; profile: string; profile_revision: number}, declared: RuntimeInstallationDeclaration): void {
  if (row.resource !== declared.resource || row.profile !== declared.profile || row.profile_revision !== RUNTIME_PROFILES[declared.profile].revision) {
    throw new HttpError(503, "Runtime declaration does not match stored authority.", "server_error", "runtime_declaration_changed");
  }
}

function changed(): HttpError {
  return new HttpError(409,"Runtime state changed. Read its current state before retrying.","invalid_request_error","runtime_changed");
}

async function assertAdmin(env:Env,actor:LifecycleActor):Promise<void> {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${serviceAdminAuthoritySql}`).bind(...serviceAdminAuthorityBindings(env,actor)).first()) {
    throw new HttpError(403,"Admin authentication required.","authentication_error","admin_required");
  }
}

function audit(env:Env,actor:LifecycleActor,id:string,action:string,at:string,meta:Record<string,unknown>):D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO operator_mutation_audit
    (${OPERATOR_MUTATION_AUDIT_COLUMNS})
    SELECT ?,?,?,?,?,?,?,?,'runtime_installation',?,'ok',?,?,? WHERE changes() = 1`)
    .bind(generateId("oma"),at,actor.kind,actor.email,actor.subject,actor.userId,actor.role,action,id,actor.requestId,JSON.stringify(meta),at);
}

async function rowFor(env:Env,id:string):Promise<InstallationRow|null> {
  const declared=requireRuntimeInstallation(env,id);
  const row=await env.DB.prepare("SELECT * FROM runtime_installations WHERE id = ?").bind(id).first<InstallationRow>();
  if (row) declarationMismatch(row, declared);
  return row;
}

export async function readRuntimeInstallation(env:Env,actor:LifecycleActor,id:string) {
  await assertAdmin(env,actor);
  const declared=requireRuntimeInstallation(env,id); const row=await rowFor(env,id);
  await assertAdmin(env,actor);
  return {id,resource:declared.resource,profile:declared.profile,label:row?.label??declared.label,
    state:row?.state??("unconfigured" as const),revision:row?.revision??0,authority_revision:row?.authority_revision??0,
    credential_ready:Boolean(row?.credential_ref && row.phase==="ready"),phase:row?.phase??"ready",operation_id:row?.operation_id??null};
}

type InstallationChange = {expectedRevision:number;operationId:string} & (
  | {action:"supply";material:string;authority:"same"|"rebind"}
  | {action:"rename";label:string}
  | {action:"enable"|"disable"|"retire"|"recover"}
);

export function invalidRuntimeOperation(): HttpError {
  return new HttpError(400,"Invalid Runtime operation.","invalid_request_error","runtime_invalid_operation");
}

async function update(env:Env,actor:LifecycleActor,id:string,revision:number,set:string,values:unknown[],condition:string,action:string,operationId:string,at:string) {
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE runtime_installations SET ${set},updated_at=? WHERE id=? AND revision=? AND (${condition}) AND ${serviceAdminAuthoritySql}`)
      .bind(...values,at,id,revision,...serviceAdminAuthorityBindings(env,actor)),
    audit(env,actor,id,action,at,{operation_id:operationId,expected_revision:revision})
  ]);
  if(d1ChangeCount(results[1])!==1) throw changed();
}

async function finishCleanup(env:Env,actor:LifecycleActor,row:InstallationRow,at:string) {
  try {
    await env.RUNTIME_CREDENTIALS.getByName(row.id).clean(row.id,row.revision,row.credential_ref);
  } catch {
    throw new HttpError(503,"Runtime cleanup is pending. Read the operation before recovery.","server_error","runtime_cleanup_pending");
  }
  await update(env,actor,row.id,row.revision,"phase='ready'",[],"phase='cleaning'",
    "runtime.cleanup.completed",row.operation_id!,at);
}

/** Owns the cross-store sequence. Callers never commit a secret binding or retry
 * an unknown write themselves. A pending phase denies admission. */
export async function changeRuntimeInstallation(env:Env,actor:LifecycleActor,id:string,input:InstallationChange,now=new Date()) {
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||typeof input.operationId!=="string"||!/^[A-Za-z0-9_-]{1,96}$/.test(input.operationId)) throw invalidRuntimeOperation();
  await assertAdmin(env,actor);
  const row=await rowFor(env,id); const at=now.toISOString();
  if(!row||row.revision!==input.expectedRevision) throw changed();
  if(input.action==="recover") {
    if(input.operationId!==row.operation_id)throw changed();
  } else if(await env.DB.prepare("SELECT 1 FROM operator_mutation_audit WHERE target_type='runtime_installation' AND target_id=? AND json_extract(meta,'$.operation_id')=? LIMIT 1").bind(id,input.operationId).first())throw changed();
  if(input.action==="recover" && row.phase==="cleaning") {
    if(input.operationId!==row.operation_id) throw changed();
    await finishCleanup(env,actor,row,at);
  } else if(input.action==="supply") {
    if((input.authority!=="same"&&input.authority!=="rebind")||typeof input.material!=="string"||!/^[\x21-\x7e]{1,4096}$/.test(input.material)) throw invalidRuntimeOperation();
    if(row.state==="retired"||row.phase!=="ready"||(input.authority==="same"&&!row.credential_ref)) throw changed();
    const revision=row.revision+1; const ref=generateId("rtc");
    await update(env,actor,id,row.revision,"revision=?,authority_revision=authority_revision+?,operation_id=?,phase='writing'",
      [revision,input.authority==="rebind"?1:0,input.operationId],"state<>'retired' AND phase='ready'","runtime.credential.staged",input.operationId,at);
    try { await env.RUNTIME_CREDENTIALS.getByName(id).put(id,ref,revision,input.material); }
    catch { throw new HttpError(503,"Runtime credential operation is pending. Read its state before recovery.","server_error","runtime_credential_pending"); }
    await update(env,actor,id,revision,"credential_ref=?,credential_revision=?,phase='cleaning'",[ref,revision],
      "state<>'retired' AND phase='writing'","runtime.credential.bound",input.operationId,at);
    await finishCleanup(env,actor,{...row,revision,credential_ref:ref,credential_revision:revision,operation_id:input.operationId,phase:"cleaning"},at);
  } else if(input.action==="disable"||input.action==="retire"||(input.action==="recover"&&row.phase==="writing")) {
    // Aborting an unknown candidate is destructive and explicit: remain disabled,
    // invalidate consent and clean every version. It never repeats the supply.
    const abort=input.action==="recover"; const remove=input.action==="retire"||abort;
    const revision=row.revision+1; const state=input.action==="retire"?"retired":"disabled";
    await update(env,actor,id,row.revision,`state=?,revision=?,authority_revision=authority_revision+1,operation_id=?,phase='cleaning'${remove?",credential_ref=NULL,credential_revision=NULL":""}`,
      [state,revision,input.operationId],"state<>'retired'","runtime."+(abort?"credential.aborted":input.action),input.operationId,at);
    await finishCleanup(env,actor,{...row,state,revision,credential_ref:remove?null:row.credential_ref,operation_id:input.operationId,phase:"cleaning"},at);
  } else if(input.action==="enable") {
    await update(env,actor,id,row.revision,"state='enabled',revision=revision+1,operation_id=?",[input.operationId],
      "state='disabled' AND phase='ready' AND credential_ref IS NOT NULL","runtime.enable",input.operationId,at);
  } else if(input.action==="rename") {
    if(typeof input.label!=="string"||!input.label.trim()||input.label.length>64||/[\u0000-\u001f\u007f]/.test(input.label)) throw invalidRuntimeOperation();
    await update(env,actor,id,row.revision,"label=?,revision=revision+1,operation_id=?",[input.label.trim(),input.operationId],
      "state<>'retired' AND phase='ready'","runtime.rename",input.operationId,at);
  } else throw changed();
  return readRuntimeInstallation(env,actor,id);
}

export async function setRuntimeAccess(env:Env,actor:LifecycleActor,id:string,subject:string,input:{state:"granted"|"revoked";expectedRevision:number;expiresAt:string|null},now=new Date()) {
  const declared=requireRuntimeInstallation(env,id); const at=now.toISOString();
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!["granted","revoked"].includes(input.state)
    ||(input.expiresAt!==null&&(!Number.isFinite(Date.parse(input.expiresAt))||new Date(input.expiresAt).toISOString()!==input.expiresAt||input.expiresAt<=at))) throw invalidRuntimeOperation();
  await assertAdmin(env,actor);
  const target=await env.DB.prepare("SELECT canonical_email,account_kind,login_capable,status FROM users WHERE id=?").bind(subject)
    .first<{canonical_email:string|null;account_kind:string;login_capable:number;status:string}>();
  if(!target||(input.state==="granted"&&(!isOrganizationLoginUser(env,target)||target.status!=="active")))throw changed();
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO runtime_installation_access(installation_id,user_id,revision,state,expires_at,updated_at)
      SELECT ?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM runtime_installations WHERE id=? AND resource=? AND profile=? AND state<>'retired')
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND (?='revoked' OR (account_kind='human' AND status='active' AND login_capable=1 AND canonical_email=? AND substr(canonical_email,instr(canonical_email,'@')+1)=?)))
        AND COALESCE((SELECT revision FROM runtime_installation_access WHERE installation_id=? AND user_id=?),0)=?
        AND ${serviceAdminAuthoritySql}
      ON CONFLICT(installation_id,user_id) DO UPDATE SET revision=runtime_installation_access.revision+1,state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .bind(id,subject,input.state,input.expiresAt,at,id,declared.resource,declared.profile,subject,input.state,target.canonical_email,organizationDomain(env)??"",id,subject,input.expectedRevision,...serviceAdminAuthorityBindings(env,actor)),
    audit(env,actor,id,"runtime.access."+input.state,at,{user_id:subject,revision:input.expectedRevision+1})
  ]);
  if(d1ChangeCount(results[1])!==1) throw changed();
  return readRuntimeAccess(env,actor,id,subject);
}

export async function readRuntimeAccess(env:Env,actor:LifecycleActor,id:string,subject:string) {
  requireRuntimeInstallation(env,id);
  await assertAdmin(env,actor);
  const row=await env.DB.prepare("SELECT user_id,revision,state,expires_at FROM runtime_installation_access WHERE installation_id=? AND user_id=?").bind(id,subject).first<{user_id:string;revision:number;state:string;expires_at:string|null}>();
  await assertAdmin(env,actor);
  return row??{user_id:subject,revision:0,state:"absent",expires_at:null};
}

/** Metadata-only stages reconcile an unknown result even after a later operation.
 * The operator must read the current installation before starting another write. */
export async function readRuntimeOperation(env:Env,actor:LifecycleActor,id:string,operationId:string) {
  requireRuntimeInstallation(env,id);await assertAdmin(env,actor);
  const rows=await env.DB.prepare(`SELECT action,at FROM operator_mutation_audit
    WHERE target_type='runtime_installation' AND target_id=? AND json_extract(meta,'$.operation_id')=? ORDER BY rowid LIMIT 8`)
    .bind(id,operationId).all<{action:string;at:string}>();
  await assertAdmin(env,actor);return rows.results;
}

export async function configureRuntimeInstallation(env:Env,actor:LifecycleActor,id:string,now=new Date()) {
  const declared=requireRuntimeInstallation(env,id); const at=now.toISOString();
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO runtime_installations
      (id,resource,profile,profile_revision,label,state,revision,authority_revision,created_at,updated_at)
      SELECT ?,?,?,?,?,'disabled',1,1,?,? WHERE NOT EXISTS (SELECT 1 FROM runtime_installations WHERE id = ? OR resource = ?)
        AND ${serviceAdminAuthoritySql}`).bind(id,declared.resource,declared.profile,RUNTIME_PROFILES[declared.profile].revision,declared.label,at,at,id,declared.resource,...serviceAdminAuthorityBindings(env,actor)),
    audit(env,actor,id,"runtime.configure",at,{profile:declared.profile})
  ]);
  if(d1ChangeCount(results[1])!==1) throw changed();
  return readRuntimeInstallation(env,actor,id);
}

/** The first/current D1 primary read is the authority snapshot. No allow cache.
 * The OAuth owner compares captured revisions while holding its own short gate. */
export async function readRuntimeAuthority(env:Env,subject:string,id:string,now=new Date(),browser?:{hash:string;email:string;epoch:number}) {
  const declared=requireRuntimeInstallation(env,id);
  const row=await env.DB.prepare(`SELECT i.id AS installation_id,i.resource,i.authority_revision,
      i.credential_ref,i.credential_revision,i.profile,i.profile_revision,a.revision AS access_revision,u.id AS subject
      ,u.canonical_email,u.login_capable,u.account_kind
    FROM runtime_installations i JOIN runtime_installation_access a ON a.installation_id=i.id
      JOIN users u ON u.id=a.user_id
    WHERE i.id=? AND i.resource=? AND i.profile=? AND i.profile_revision=?
      AND i.state='enabled' AND i.phase='ready' AND i.credential_ref IS NOT NULL
      AND a.state='granted' AND (a.expires_at IS NULL OR a.expires_at>?)
      AND u.id=? AND u.account_kind='human' AND u.status='active' AND u.login_capable=1
      AND substr(u.canonical_email,instr(u.canonical_email,'@')+1)=?
      ${browser?`AND u.canonical_email=? AND u.console_session_epoch=? AND EXISTS
        (SELECT 1 FROM console_sessions s WHERE s.user_id=u.id AND s.token_hash=?
          AND s.session_epoch=u.console_session_epoch AND s.expires_at>?)`:""}`)
    .bind(id,declared.resource,declared.profile,RUNTIME_PROFILES[declared.profile].revision,now.toISOString(),subject,organizationDomain(env)??"",
      ...(browser?[browser.email,browser.epoch,browser.hash,now.toISOString()]:[]))
    .first<{installation_id:string;resource:string;authority_revision:number;credential_ref:string;credential_revision:number;profile:string;profile_revision:number;access_revision:number;subject:string;canonical_email:string;login_capable:number;account_kind:string}>();
  if(!row||!isOrganizationLoginUser(env,row))return null;
  const {canonical_email:_email,login_capable:_login,account_kind:_kind,...authority}=row;
  return authority;
}

/** Pre-login transaction captures installation authority, not member entitlement. */
export async function readRuntimeAuthorityRevision(env:Env,id:string):Promise<number|null> {
  const declared=requireRuntimeInstallation(env,id);
  const row=await env.DB.prepare(`SELECT authority_revision FROM runtime_installations
    WHERE id=? AND resource=? AND profile=? AND profile_revision=? AND state='enabled'
      AND phase='ready' AND credential_ref IS NOT NULL`)
    .bind(id,declared.resource,declared.profile,RUNTIME_PROFILES[declared.profile].revision)
    .first<{authority_revision:number}>();
  return row?.authority_revision??null;
}

export type RuntimeAuthority=NonNullable<Awaited<ReturnType<typeof readRuntimeAuthority>>>;

export interface RuntimeMemberInstallation {
  id:string;label:string;resource:string;state:"enabled"|"disabled"|"retired";
  phase:"ready"|"writing"|"cleaning";credential_ready:boolean;
  authority_revision:number;access_revision:number;access_expires_at:string|null;
}

/** One primary, own-subject permission read. Stored material and references never
 * enter this projection. Credential metadata is not an upstream health probe. */
export async function readRuntimeMemberInstallations(env:Env,subject:string,now=new Date()):Promise<RuntimeMemberInstallation[]> {
  const declared=runtimeInstallations(env);
  if(!declared.length)return [];
  const rows=await env.DB.prepare(`SELECT i.id,i.label,i.resource,i.profile,i.profile_revision,i.state,i.phase,i.authority_revision,
      (i.credential_ref IS NOT NULL AND i.phase='ready') AS credential_ready,
      a.revision AS access_revision,a.expires_at AS access_expires_at
    FROM runtime_installations i JOIN runtime_installation_access a ON a.installation_id=i.id
      JOIN users u ON u.id=a.user_id
    WHERE i.id IN (${declared.map(()=>"?").join(",")}) AND u.id=?
      AND u.account_kind='human' AND u.status='active' AND u.login_capable=1
      AND u.role IN ('admin','user') AND substr(u.canonical_email,instr(u.canonical_email,'@')+1)=?
      AND a.state='granted' AND (a.expires_at IS NULL OR a.expires_at>?) ORDER BY i.id LIMIT 17`)
    .bind(...declared.map(row=>row.id),subject,organizationDomain(env)??"",now.toISOString())
    .all<Omit<RuntimeMemberInstallation,"credential_ready">&{profile:string;profile_revision:number;credential_ready:number}>();
  if(rows.results.length>16)throw new HttpError(503,"Runtime state is unavailable.","server_error","runtime_state_unavailable");
  return rows.results.map(row=>{
    const declaration=declared.find(candidate=>candidate.id===row.id)!;
    declarationMismatch(row, declaration);
    return {id:row.id,label:row.label,resource:row.resource,state:row.state,phase:row.phase,
      credential_ready:Boolean(row.credential_ready),authority_revision:row.authority_revision,
      access_revision:row.access_revision,access_expires_at:row.access_expires_at};
  });
}
