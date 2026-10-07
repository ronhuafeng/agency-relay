import {
  commitCredentialDefault,
  credentialActor,
  defaultCredentialProbe,
  disconnectCredential,
  migrateCredentialBindings,
  previewCredentialRetirement,
  PROVIDER_RESOURCE_BOUNDARY,
  readAdminCredentialDefaults,
  readServiceAvailability,
  retryCredentialCleanup,
  type CredentialActor,
  type CredentialKind,
  type OrganizationSurface
} from "../auth/credential-defaults";
import type { OperatorMutationContext } from "./operator-mutations";
import { HttpError, jsonResponse } from "../errors";

export async function credentialControlResponse(
  request: Request,
  env: Env,
  url: URL,
  operator: OperatorMutationContext
): Promise<Response | null> {
  if (url.pathname === "/admin/credential-defaults" && request.method === "GET") {
    return jsonResponse({
      defaults: await readAdminCredentialDefaults(env, defaultCredentialProbe(env), operator.now)
    }, { headers: { "Cache-Control": "no-store" } });
  }
  const setDefault = /^\/admin\/credential-defaults\/(codex|grok|xai)$/.exec(url.pathname);
  if (setDefault && request.method === "PUT") {
    const body = await readBody(request);
    await commitCredentialDefault(env, actorOf(operator), {
      surface_grant: surfaceGrant(setDefault[1]!),
      credential_account_id: requiredString(body, "credential_account_id")
    }, operator.now);
    return jsonResponse({
      surface_grant: surfaceGrant(setDefault[1]!),
      provider_resources_not_migrated: PROVIDER_RESOURCE_BOUNDARY
    });
  }
  const uiDefault = /^\/admin\/ui\/credential-defaults\/(codex|grok|xai)$/.exec(url.pathname);
  if (uiDefault && request.method === "POST") {
    const body = await readBody(request);
    requireConfirm(body);
    await commitCredentialDefault(env, actorOf(operator), {
      surface_grant: surfaceGrant(uiDefault[1]!),
      credential_account_id: requiredString(body, "credential_account_id")
    }, operator.now);
    return jsonResponse({ ok: true, surface_grant: surfaceGrant(uiDefault[1]!) });
  }
  const retirement = /^\/admin\/(?:ui\/)?(codex-auths|subscriptions)\/([^/]+)\/(retirement|migrate|disconnect|cleanup)$/.exec(url.pathname)
    ?? (url.pathname.includes("/admin/ui/")
      ? null
      : /^\/admin\/(codex-auths|subscriptions)\/([^/]+)\/(force-disconnect)$/.exec(url.pathname))
  if (!retirement) return null;
  const kind: CredentialKind = retirement[1] === "codex-auths" ? "codex" : "grok";
  const accountId = decodeURIComponent(retirement[2]!);
  const action = retirement[3]!;
  if (action === "retirement" && request.method === "GET") {
    return jsonResponse(await previewCredentialRetirement(env, kind, accountId), { headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") {
    throw new HttpError(405, "Method not allowed", "invalid_request_error", "method_not_allowed");
  }
  const actor = actorOf(operator);
  const cleanup = () => revokeStoredCredential(env, kind, accountId);
  if (action === "migrate") {
    const body = await readBody(request);
    return jsonResponse(await migrateCredentialBindings(env, actor, {
      kind,
      account_id: accountId,
      replacement_account_id: requiredString(body, "replacement_account_id"),
      key_ids: stringArray(body, "key_ids"),
      default_surfaces: stringArray(body, "default_surfaces").map(surfaceGrant)
    }, operator.now));
  }
  if (action === "disconnect" || action === "force-disconnect") {
    return jsonResponse(await disconnectCredential(env, actor, {
      kind,
      account_id: accountId,
      force: action === "force-disconnect"
    }, cleanup, operator.now));
  }
  return jsonResponse(await retryCredentialCleanup(env, actor, { kind, account_id: accountId }, cleanup, operator.now));
}

export async function serviceAvailabilityResponse(env: Env, now: Date): Promise<Response> {
  return jsonResponse({
    services: await readServiceAvailability(env, defaultCredentialProbe(env), now)
  }, { headers: { "Cache-Control": "no-store" } });
}

function actorOf(operator: OperatorMutationContext): CredentialActor {
  return credentialActor(operator);
}

async function revokeStoredCredential(env: Env, kind: CredentialKind, accountId: string): Promise<void> {
  if (kind === "codex") {
    await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(accountId)).revoke();
    return;
  }
  await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`)).revokeSubscription();
}

function surfaceGrant(value: string): OrganizationSurface {
  if (value === "codex") return "surface:codex:production";
  if (value === "grok") return "surface:grok:production";
  if (value === "xai") return "surface:xai:production";
  throw new HttpError(400, "Surface must be codex, grok, or xai", "invalid_request_error", "invalid_surface");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await request.text());
    const body: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      if (key.endsWith("[]")) {
        const name = key.slice(0, -2);
        const existing = body[name];
        body[name] = Array.isArray(existing) ? [...existing, value] : [value];
      } else {
        body[key] = value;
      }
    }
    return body;
  }
  const parsed = await request.json() as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON object required", "invalid_request_error", "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`, "invalid_request_error", `missing_${field}`);
  }
  return value.trim();
}

function stringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === "string" && item.trim())) {
    throw new HttpError(400, `${field} must be strings`, "invalid_request_error", `invalid_${field}`);
  }
  return values.map((item) => item.trim());
}

function requireConfirm(body: Record<string, unknown>): void {
  const raw = body.confirm;
  if (raw !== true && raw !== 1 && raw !== "1" && raw !== "true" && raw !== "on" && raw !== "yes") {
    throw new HttpError(400, "Default change requires confirm=1", "invalid_request_error", "confirm_required");
  }
}
