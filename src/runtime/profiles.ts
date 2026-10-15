import { HttpError } from "../errors";
import {plansForHostname} from "../plans/execution-plans";

export const RUNTIME_SCOPE="runtime.use";

/** Only reviewed code can introduce an upstream or credential header. */
export const RUNTIME_PROFILES = {
  "google.stitch": {revision:1,upstream:"https://stitch.googleapis.com/mcp",credentialHeader:"X-Goog-Api-Key",transport:"request-scoped"}
} as const;

export interface RuntimeInstallationDeclaration {
  id: string;
  resource: string;
  profile: keyof typeof RUNTIME_PROFILES;
  label: string;
}

/** Deployment input, never a console-supplied URL. Empty means no installations. */
export function runtimeInstallations(env: Env): RuntimeInstallationDeclaration[] {
  try {
    const entries: unknown = JSON.parse(env.RUNTIME_INSTALLATIONS ?? "[]");
    if (!Array.isArray(entries) || entries.length > 16) throw new Error();
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
        || !/^\/[a-z][a-z0-9-]{0,63}$/.test(uri.pathname) || uri.href !== row.resource
        || uri.hostname===env.ADMIN_DASHBOARD_HOST || plansForHostname(uri.hostname)
        || ids.has(row.id) || resources.has(row.resource)) throw new Error();
      ids.add(row.id); resources.add(row.resource);
      return {id:row.id,resource:row.resource,profile:row.profile as RuntimeInstallationDeclaration["profile"],label:row.label.trim()};
    });
  } catch {
    throw new HttpError(503,"Runtime declaration is unavailable.","server_error","runtime_declaration_invalid");
  }
}

export function requireRuntimeInstallation(env: Env, id: string): RuntimeInstallationDeclaration {
  const declared = runtimeInstallations(env).find(row => row.id === id);
  if (!declared) throw new HttpError(404,"Runtime installation not found.","invalid_request_error","runtime_installation_not_found");
  return declared;
}
