import { HttpError } from "../errors";
import {plansForHostname} from "../plans/execution-plans";
import {googleStitchProfile} from "./connectors/google-stitch/profile";
import {larkDocProfile} from "./connectors/lark-doc/profile";

export const RUNTIME_SCOPE="runtime.use";

/** Upstream destinations, protocol and tool policy are reviewed in code. */
export const RUNTIME_PROFILES = {
  "google.stitch": googleStitchProfile,
  "lark.doc": larkDocProfile,
} as const;
export type RuntimeProfileId = keyof typeof RUNTIME_PROFILES;

export interface RuntimeInstallationDeclaration {
  id: string;
  resource: string;
  profile: RuntimeProfileId;
  label: string;
  editablePath?: true;
}

const resourcePath = /^\/[a-z][a-z0-9-]{0,63}$/;
export function isRuntimePath(path: unknown): path is string {
  return typeof path === "string" && resourcePath.test(path) && path !== "/healthz";
}

/** Deployment owns the host. Existing exact declarations remain supported. */
export function runtimeInstallations(env: Env): RuntimeInstallationDeclaration[] {
  try {
    const entries: unknown = JSON.parse(env.RUNTIME_INSTALLATIONS ?? "[]");
    if (!Array.isArray(entries) || entries.length > 16) throw new Error();
    if (env.RUNTIME_MCP_ORIGIN) {
      const origin = new URL(env.RUNTIME_MCP_ORIGIN);
      if (entries.length || origin.protocol !== "https:" || origin.origin !== env.RUNTIME_MCP_ORIGIN
        || !/^[a-z0-9.-]+$/.test(origin.host) || origin.hostname === env.ADMIN_DASHBOARD_HOST
        || plansForHostname(origin.hostname)) throw new Error();
      return [
        {id:"google-stitch",resource:`${origin.origin}/google-stitch`,profile:"google.stitch",label:"Google Stitch",editablePath:true},
        {id:"lark-doc",resource:`${origin.origin}/feishu-docs`,profile:"lark.doc",label:"飞书文档",editablePath:true},
      ];
    }
    const ids = new Set<string>(); const resources = new Set<string>();
    return entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error();
      const row = entry as Record<string,unknown>;
      if (typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id)
        || typeof row.profile !== "string" || !Object.hasOwn(RUNTIME_PROFILES,row.profile)
        || typeof row.resource !== "string" || typeof row.label !== "string"
        || !row.label.trim() || row.label.length > 64 || /[\u0000-\u001f\u007f]/.test(row.label)) throw new Error();
      const uri = new URL(row.resource);
      if (uri.protocol !== "https:" || uri.username || uri.password || uri.port || uri.search || uri.hash
        || !isRuntimePath(uri.pathname) || uri.href !== row.resource
        || uri.hostname===env.ADMIN_DASHBOARD_HOST || plansForHostname(uri.hostname)
        || ids.has(row.id) || resources.has(row.resource)) throw new Error();
      ids.add(row.id); resources.add(row.resource);
      return {id:row.id,resource:row.resource,profile:row.profile as RuntimeInstallationDeclaration["profile"],label:row.label.trim()};
    });
  } catch {
    throw new HttpError(503,"Runtime declaration is unavailable.","server_error","runtime_declaration_invalid");
  }
}

export function resourceMatches(declared: RuntimeInstallationDeclaration, resource: string): boolean {
  if (!declared.editablePath) return resource === declared.resource;
  const origin = new URL(declared.resource).origin;
  return resource.startsWith(`${origin}/`) && isRuntimePath(resource.slice(origin.length));
}

/** Dynamic paths are published only after their configuration commits. */
export async function runtimeResources(env: Env, declarations = runtimeInstallations(env)) {
  if (!env.RUNTIME_MCP_ORIGIN || !declarations.length) return declarations;
  const rows = await env.DB.prepare(`SELECT id,resource,profile,profile_revision FROM runtime_installations
    WHERE state<>'retired' AND id IN (${declarations.map(()=>"?").join(",")})`)
    .bind(...declarations.map(declared=>declared.id))
    .all<{id:string;resource:string;profile:string;profile_revision:number}>();
  return declarations.flatMap(declared => {
    const row = rows.results.find(candidate => candidate.id === declared.id);
    return row && row.profile === declared.profile && row.profile_revision === RUNTIME_PROFILES[declared.profile].revision
      && resourceMatches(declared, row.resource) ? [{...declared, resource:row.resource}] : [];
  });
}

export function requireRuntimeInstallation(env: Env, id: string): RuntimeInstallationDeclaration {
  const declared = runtimeInstallations(env).find(row => row.id === id);
  if (!declared) throw new HttpError(404,"Runtime installation not found.","invalid_request_error","runtime_installation_not_found");
  return declared;
}
