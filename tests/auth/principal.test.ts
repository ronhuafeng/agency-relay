import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { HttpError, errorResponse } from "../../src/errors";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";
import {
  admin,
  consoleCookie,
  createKey,
  createUser,
  importSharedAuth,
  makeFixture,
  type Fixture
} from "../router/fixture";

const DASHBOARD = "https://admin.example.test";

async function consoleCall(
  fixture: Fixture,
  url: string,
  input: {
    method?: string;
    email?: string | null;
    subject?: string;
    session?: "none" | "invalid" | "expired";
    origin?: string | null;
    emailHeader?: string;
    body?: unknown;
    bearer?: string;
  } = {}
): Promise<Response> {
  const headers = new Headers();
  if (input.bearer) headers.set("Authorization", `Bearer ${input.bearer}`);
  else if (input.session === "invalid") headers.set("Cookie", "__Host-mini-console=not-a-session");
  else if (input.session === "expired") {
    headers.set("Cookie", `__Host-mini-console=${await consoleCookie(fixture, "expired@example.com", { expired: true })}`);
  } else if (input.session !== "none" && input.email) {
    try {
      headers.set("Cookie", `__Host-mini-console=${await consoleCookie(fixture, input.email, {
        subject: input.subject,
        expired: input.session === "expired"
      })}`);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error);
      throw error;
    }
  }
  if (input.emailHeader) headers.set("Cf-Access-Authenticated-User-Email", input.emailHeader);
  const method = input.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && input.origin !== null) {
    headers.set("Origin", input.origin ?? DASHBOARD);
  }
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return handleRequest(new Request(url, {
    method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  }), fixture.env, fixture.ctx, fixture.deps);
}

it("rejects untrusted console identity before creating an account", async () => {
  const fixture = makeFixture();
  for (const session of ["none", "invalid", "expired"] as const) {
    const response = await consoleCall(makeFixture(), `${DASHBOARD}/me`, { session });
    expect(response.status, session).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "admin_auth_required" } });
  }
  const unsigned = await consoleCall(fixture, `${DASHBOARD}/admin`, {
    session: "none",
    emailHeader: "spoofed@example.com"
  });
  expect(unsigned.status).toBe(403);
  const ignoredHeader = await consoleCall(fixture, `${DASHBOARD}/me`, {
    email: "real@example.com",
    emailHeader: "spoofed@example.com"
  });
  expect(ignoredHeader.status).toBe(200);
  await expect(ignoredHeader.json()).resolves.toMatchObject({ user: { email: "real@example.com", role: "user" } });
  expect([...fixture.db.users.values()].map((user) => user.canonical_email)).toEqual(["real@example.com"]);
  const alternate = await consoleCall(fixture, "https://other.example.test/me", { email: "other-host@example.com" });
  expect(alternate.status).toBe(404);
  expect(fixture.db.users.has("other-host@example.com")).toBe(false);
});

it("creates one ordinary user for a canonical email and never revives a disabled account", async () => {
  const fixture = makeFixture();
  const first = await consoleCall(fixture, `${DASHBOARD}/me`, {
    email: "  Alice+Work@Example.com ",
    subject: "subject-a"
  });
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { user: { id: string; email: string; role: string; status: string } };
  expect(firstBody.user).toEqual({
    id: firstBody.user.id,
    email: "alice+work@example.com",
    role: "user",
    status: "active"
  });
  expect(Object.keys(firstBody.user).sort()).toEqual(["email", "id", "role", "status"]);
  expect(fixture.db.apiKeys.size).toBe(0);
  const repeat = await consoleCall(fixture, `${DASHBOARD}/me?user_id=someone-else`, {
    email: "alice+work@example.com",
    subject: "subject-b"
  });
  await expect(repeat.json()).resolves.toMatchObject({ user: { id: firstBody.user.id, role: "user" } });
  const plain = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "alice@example.com", subject: "subject-a" });
  const plainBody = await plain.json() as { user: { id: string } };
  expect(plainBody.user.id).not.toBe(firstBody.user.id);
  const memberHome = await consoleCall(fixture, `${DASHBOARD}/admin`, { email: "alice+work@example.com" });
  expect(memberHome.status).toBe(200);
  const memberHtml = await memberHome.text();
  expect(memberHtml).toContain('data-member-nav="true"');
  expect(memberHtml).not.toContain("Accounts");
  const memberMutation = await consoleCall(fixture, `${DASHBOARD}/admin/ui/users/${firstBody.user.id}/role`, {
    method: "POST",
    email: "alice+work@example.com",
    body: { role: "admin", confirm: true }
  });
  expect(memberMutation.status).toBe(403);
  expect(fixture.db.users.get(firstBody.user.id)).toMatchObject({ role: "user" });

  fixture.db.seedConsoleUser({
    id: "legacy_case",
    email: "Ada@Example.com",
    canonicalEmail: "ada@example.com",
    loginCapable: false
  });
  fixture.db.seedConsoleUser({
    id: "legacy_space",
    email: " ada@example.com ",
    canonicalEmail: "ada@example.com",
    loginCapable: false
  });
  const ambiguous = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "ada@example.com" });
  expect(ambiguous.status).toBe(403);
  await expect(ambiguous.json()).resolves.toMatchObject({ error: { code: "ambiguous_identity" } });
  expect(fixture.db.users.get("legacy_case")?.login_capable).toBe(0);
  expect([...fixture.db.users.values()].filter((user) => user.canonical_email === "ada@example.com" && user.login_capable === 1)).toHaveLength(0);

  fixture.db.seedConsoleUser({
    id: "disabled_member",
    email: "disabled@example.com",
    status: "disabled"
  });
  const disabled = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "disabled@example.com", subject: "new-subject" });
  expect(disabled.status).toBe(403);
  await expect(disabled.json()).resolves.toMatchObject({ error: { code: "user_inactive" } });
  expect(fixture.db.users.get("disabled_member")).toMatchObject({ status: "disabled", role: "user" });
  expect([...fixture.db.users.values()].filter((user) => user.canonical_email === "disabled@example.com")).toHaveLength(1);
});

it("keeps an administrator's /me personal and keeps admin APIs away from a member", async () => {
  const fixture = makeFixture();
  fixture.db.seedConsoleUser({ id: "member_admin", email: "admin@example.com", role: "admin" });
  fixture.db.seedConsoleUser({ id: "member_user", email: "member@example.com", role: "user" });
  const me = await consoleCall(fixture, `${DASHBOARD}/me?user_id=member_user`, { email: "admin@example.com" });
  expect(me.headers.get("Cache-Control")).toBe("no-store");
  await expect(me.json()).resolves.toEqual({
    user: { id: "member_admin", email: "admin@example.com", role: "admin", status: "active" }
  });

  for (const url of [`${DASHBOARD}/`, `${DASHBOARD}/admin?view=setup`]) {
    const response = await consoleCall(fixture, url, { email: "member@example.com" });
    expect(response.status, url).toBe(200);
    const html = await response.text();
    expect(html, url).toContain('data-member-nav="true"');
    expect(html, url).not.toContain("admin@example.com");
  }
  const memberPaths = [
    `${DASHBOARD}/admin/usage?scope=all&limit=10&user_id=member_admin`,
    `${DASHBOARD}/admin/codex-auths`,
    `${DASHBOARD}/admin/codex-auths/shared_default`,
    `${DASHBOARD}/admin/request-state`,
    `${DASHBOARD}/admin/readiness`
  ];
  const consoleClient = await consoleCall(fixture, `${DASHBOARD}/admin/console.js`, { email: "member@example.com" });
  expect(consoleClient.status).toBe(200);
  expect(consoleClient.headers.get("Content-Type")).toContain("javascript");
  expect(await consoleClient.text()).toContain("createRoot");
  for (const url of memberPaths) {
    const response = await consoleCall(fixture, url, { email: "member@example.com" });
    expect(response.status, url).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "admin_required" } });
  }
  const mutation = await consoleCall(fixture, `${DASHBOARD}/admin/ui/users/member_user/status`, {
    method: "POST",
    email: "member@example.com",
    body: { status: "disabled", confirm: true }
  });
  expect(mutation.status).toBe(403);
  expect(fixture.db.users.get("member_user")).toMatchObject({ role: "user", status: "active" });
  const roleMutation = await consoleCall(fixture, `${DASHBOARD}/admin/ui/users/member_admin/role`, {
    method: "POST",
    email: "member@example.com",
    body: { role: "admin", confirm: true }
  });
  expect(roleMutation.status).toBe(403);
  expect(fixture.db.users.get("member_user")?.role).toBe("user");
  expect(fixture.db.operatorMutationAudit.some((row) => row.result === "ok" && String(row.action).startsWith("user."))).toBe(false);

  const created = await createUser(fixture, "key-owner@example.com");
  const key = await createKey(fixture, created.user.id, ["surface:codex:production"]);
  for (const url of [`${DASHBOARD}/me`, `${DASHBOARD}/admin`, "https://api.trustedtunnel.app/admin/usage?scope=all&limit=1"]) {
    const response = await consoleCall(fixture, url, { bearer: key.api_key, session: "none" });
    expect(response.status, url).toBe(403);
  }
  const accessOnOperator = await consoleCall(fixture, "https://api.trustedtunnel.app/admin/users/member_user/role", {
    method: "POST",
    email: "admin@example.com",
    body: { role: "user" }
  });
  expect(accessOnOperator.status).toBe(403);
  expect(fixture.db.users.get("member_user")?.role).toBe("user");
});

it("preserves the last administrator, email history, and revoked keys", async () => {
  const fixture = makeFixture();
  fixture.db.seedConsoleUser({ id: "life_admin", email: "life-admin@example.com", role: "admin" });
  fixture.db.seedConsoleUser({ id: "life_other", email: "life-other@example.com", role: "admin" });
  const self = await consoleCall(fixture, `${DASHBOARD}/admin/ui/users/life_admin/role`, {
    method: "POST",
    email: "life-admin@example.com",
    body: { role: "user", confirm: true }
  });
  expect(self.status).toBe(200);
  expect(fixture.db.users.get("life_admin")?.role).toBe("user");
  const stale = await consoleCall(fixture, `${DASHBOARD}/admin/usage?scope=all&limit=1`, { email: "life-admin@example.com" });
  expect(stale.status).toBe(403);
  const personal = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "life-admin@example.com" });
  await expect(personal.json()).resolves.toMatchObject({ user: { id: "life_admin", role: "user" } });

  const last = await admin(fixture, "https://api.trustedtunnel.app/admin/users/life_other/role", {
    method: "POST",
    body: { role: "user" }
  });
  expect(last.status).toBe(409);
  await expect(last.json()).resolves.toMatchObject({ error: { code: "last_active_admin" } });
  expect(fixture.db.users.get("life_other")?.role).toBe("admin");
  const lastDisable = await admin(fixture, "https://api.trustedtunnel.app/admin/users/life_other/status", {
    method: "POST",
    body: { status: "disabled" }
  });
  expect(lastDisable.status).toBe(409);
  await expect(lastDisable.json()).resolves.toMatchObject({ error: { code: "last_active_admin" } });
  expect(fixture.db.users.get("life_other")).toMatchObject({ role: "admin", status: "active" });
  expect(fixture.db.operatorMutationAudit.filter((row) => row.action === "user.demote" && row.target_id === "life_other" && row.result === "ok")).toHaveLength(0);
  expect(fixture.db.operatorMutationAudit.filter((row) => row.action === "user.disable" && row.target_id === "life_other" && row.result === "ok")).toHaveLength(0);

  const promoted = await admin(fixture, "https://api.trustedtunnel.app/admin/users/life_admin/role", {
    method: "POST",
    body: { role: "admin" }
  });
  expect(promoted.status).toBe(200);
  const demoted = fixture.db.operatorMutationAudit.find((row) => row.action === "user.demote" && row.target_id === "life_admin");
  expect(demoted).toMatchObject({
    actor_kind: "access",
    actor_user_id: "life_admin",
    actor_role: "admin",
    actor_email: "life-admin@example.com",
    result: "ok"
  });
  expect(JSON.stringify(demoted)).not.toContain("key_hash");

  const owner = await createUser(fixture, "rename-owner@example.com");
  const kept = await createKey(fixture, owner.user.id, ["surface:codex:production"]);
  await importSharedAuth(fixture);
  const allowance = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/credits/codex`, {
    method: "PUT",
    body: { monthly_allowance: 7 }
  });
  expect(allowance.status).toBe(200);
  const renamed = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/email`, {
    method: "POST",
    body: { email: "  Renamed@Example.com " }
  });
  expect(renamed.status).toBe(200);
  await expect(renamed.json()).resolves.toMatchObject({
    id: owner.user.id,
    email: "renamed@example.com",
    previous_email: "rename-owner@example.com"
  });
  expect(fixture.db.apiKeys.get(kept.key.id)?.user_id).toBe(owner.user.id);
  expect(fixture.db.surfaceCreditPolicies.get(`${owner.user.id}:surface:codex:production`)?.monthly_allowance).toBe(7);
  const collision = await admin(fixture, "https://api.trustedtunnel.app/admin/users/life_other/email", {
    method: "POST",
    body: { email: "renamed@example.com" }
  });
  expect(collision.status).toBe(409);
  expect(fixture.db.users.get("life_other")?.canonical_email).toBe("life-other@example.com");
  expect(fixture.db.operatorMutationAudit.filter((row) => row.action === "user.email" && row.target_id === "life_other" && row.result === "ok")).toHaveLength(0);
  const oldLogin = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "rename-owner@example.com" });
  const oldBody = await oldLogin.json() as { user: { id: string; role: string } };
  expect(oldBody.user.id).not.toBe(owner.user.id);
  expect(oldBody.user.role).toBe("user");
  expect(fixture.db.apiKeys.get(kept.key.id)?.user_id).toBe(owner.user.id);
  const newLogin = await consoleCall(fixture, `${DASHBOARD}/me`, { email: "renamed@example.com" });
  await expect(newLogin.json()).resolves.toMatchObject({ user: { id: owner.user.id } });

  const blocked = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/status`, {
    method: "POST",
    body: { status: "disabled" }
  });
  expect(blocked.status).toBe(200);
  const deniedModels = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
    headers: { Authorization: `Bearer ${kept.api_key}` }
  }), fixture.env, fixture.ctx, fixture.deps);
  expect(deniedModels.status).toBe(403);
  await expect(deniedModels.json()).resolves.toMatchObject({ error: { code: "user_inactive" } });
  expect(fixture.db.apiKeys.get(kept.key.id)?.status).toBe("active");
  const enabled = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/status`, {
    method: "POST",
    body: { status: "active" }
  });
  expect(enabled.status).toBe(200);
  const revoked = await admin(fixture, `https://api.trustedtunnel.app/admin/keys/${kept.key.id}`, { method: "DELETE" });
  expect(revoked.status).toBe(200);
  await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/role`, {
    method: "POST",
    body: { role: "admin" }
  });
  await consoleCall(fixture, `${DASHBOARD}/me`, { email: "renamed@example.com" });
  expect(fixture.db.apiKeys.get(kept.key.id)?.status).toBe("revoked");
  const revokedModels = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
    headers: { Authorization: `Bearer ${kept.api_key}` }
  }), fixture.env, fixture.ctx, fixture.deps);
  expect(revokedModels.status).toBe(401);
});

it("lets competing logins and mixed admin demotion/disable commit only one lawful result", async () => {
  const root = mkdtempSync(join(tmpdir(), "mini-principal-"));
  try {
    const roleFile = join(root, "role.sqlite");
    const roleDb = createTestD1({ file: roleFile });
    roleDb.sqlite.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       VALUES
         ('admin_a', 'a@example.com', 'a@example.com', 'admin', 'active', 1, 'human', 't', 't'),
         ('admin_b', 'b@example.com', 'b@example.com', 'admin', 'active', 1, 'human', 't', 't')`
    ).run();
    roleDb.close();
    const roleHold = join(root, "role-hold");
    const slowRole = race({ file: roleFile, mode: "status", delayMs: 4_000, holdFile: roleHold, targetId: "admin_a" });
    await waitFor(roleHold);
    const fastRole = race({ file: roleFile, mode: "role", delayMs: 0, holdFile: join(root, "unused-role"), targetId: "admin_b" });
    const roleResults = await Promise.all([slowRole, fastRole]);
    expect(roleResults.filter((result) => result.ok)).toHaveLength(1);
    expect(roleResults.some((result) => result.code === "last_active_admin")).toBe(true);
    expect(Math.min(...roleResults.map((result) => result.elapsed))).toBeGreaterThan(200);
    const roleRead = createTestD1({ file: roleFile, migrations: "none" });
    const admins = roleRead.sqlite.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
    expect(admins).toHaveLength(1);
    roleRead.close();

    const jitFile = join(root, "jit.sqlite");
    const jitDb = createTestD1({ file: jitFile });
    jitDb.close();
    const jitHold = join(root, "jit-hold");
    const slowJit = race({ file: jitFile, mode: "jit", delayMs: 4_000, holdFile: jitHold, email: "  First@Example.com " });
    await waitFor(jitHold);
    const fastJit = race({ file: jitFile, mode: "jit", delayMs: 0, holdFile: join(root, "unused-jit"), email: "first@example.com" });
    const jitResults = await Promise.all([slowJit, fastJit]);
    expect(jitResults.every((result) => result.ok)).toBe(true);
    expect(new Set(jitResults.map((result) => result.id)).size).toBe(1);
    expect(Math.min(...jitResults.map((result) => result.elapsed))).toBeGreaterThan(200);
    const jitRead = createTestD1({ file: jitFile, migrations: "none" });
    const users = jitRead.sqlite.prepare(
      "SELECT id, role, status, login_capable FROM users WHERE canonical_email = 'first@example.com'"
    ).all() as Array<{ id: string; role: string; status: string; login_capable: number }>;
    expect(users).toEqual([{ id: jitResults[0]?.id, role: "user", status: "active", login_capable: 1 }]);
    const audits = jitRead.sqlite.prepare("SELECT action FROM operator_mutation_audit").all();
    expect(audits).toEqual([{ action: "user.jit" }]);
    jitRead.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

interface RaceResult {
  ok: boolean;
  elapsed: number;
  id?: string;
  role?: string;
  status?: number;
  code?: string;
}

function race(workerData: {
  file: string;
  mode: "role" | "status" | "jit";
  delayMs: number;
  holdFile: string;
  targetId?: string;
  email?: string;
}): Promise<RaceResult> {
  const worker = new Worker(new URL("./principal-race-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.once("message", (message: RaceResult) => {
      settled = true;
      worker.once("exit", () => resolve(message));
    });
    worker.once("error", (error) => {
      if (!settled) reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`Race worker exited ${code} before reporting a result`));
    });
  });
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      statSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
