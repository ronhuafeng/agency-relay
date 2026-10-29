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
  type CredentialKind
} from "../auth/credential-defaults";
import { surfaceGrantForCreditId } from "../auth/credits";
import type { OperatorMutationContext } from "./operator-mutations";
import { HttpError, jsonObjectRequired, jsonResponse, methodNotAllowed, requiredTrimmedString } from "../errors";
import { isConfirmValue, isRecord } from "../records";

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
    await commitCredentialDefault(env, credentialActor(operator), {
      surface_grant: surfaceGrantForCreditId(setDefault[1]!),
      credential_account_id: requiredTrimmedString(body, "credential_account_id")
    }, operator.now);
    return jsonResponse({
      surface_grant: surfaceGrantForCreditId(setDefault[1]!),
      provider_resources_not_migrated: PROVIDER_RESOURCE_BOUNDARY
    });
  }
  const uiDefault = /^\/admin\/ui\/credential-defaults\/(codex|grok|xai)$/.exec(url.pathname);
  if (uiDefault && request.method === "POST") {
    const body = await readBody(request);
    requireConfirm(body);
    await commitCredentialDefault(env, credentialActor(operator), {
      surface_grant: surfaceGrantForCreditId(uiDefault[1]!),
      credential_account_id: requiredTrimmedString(body, "credential_account_id")
    }, operator.now);
    return jsonResponse({ ok: true, surface_grant: surfaceGrantForCreditId(uiDefault[1]!) });
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
    throw methodNotAllowed();
  }
  const actor = credentialActor(operator);
  const cleanup = () => revokeStoredCredential(env, kind, accountId);
  if (action === "migrate") {
    const body = await readBody(request);
    return jsonResponse(await migrateCredentialBindings(env, actor, {
      kind,
      account_id: accountId,
      replacement_account_id: requiredTrimmedString(body, "replacement_account_id"),
      key_ids: stringArray(body, "key_ids"),
      default_surfaces: stringArray(body, "default_surfaces").map(surfaceGrantForCreditId)
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

async function revokeStoredCredential(env: Env, kind: CredentialKind, accountId: string): Promise<void> {
  if (kind === "codex") {
    await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(accountId)).revoke();
    return;
  }
  await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`)).revokeSubscription();
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
  if (!isRecord(parsed)) {
    throw jsonObjectRequired();
  }
  return parsed as Record<string, unknown>;
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
  if (!isConfirmValue(body.confirm)) {
    throw new HttpError(400, "Default change requires confirm=1", "invalid_request_error", "confirm_required");
  }
}
