import { admin, isRecord, parseJson, send } from "./runtime";

export interface OwnedCreditKey {
  id: string;
  token?: string;
}

interface CleanupDependencies {
  admin: typeof admin;
  send: typeof send;
}

export async function withCreditCleanup(
  userId: string,
  keys: readonly OwnedCreditKey[],
  task: () => Promise<void>,
  deps: CleanupDependencies = { admin, send }
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await task();
  } catch (error) {
    failures.push(error);
  }
  // Each owned effect and its independent readback must still run if another fails.
  const check = async (message: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch {
      failures.push(new Error(message));
    }
  };
  for (const key of keys) {
    await check("owned credit key revocation failed", async () => {
      const result = await deps.admin("DELETE", `/admin/keys/${key.id}`);
      if (result.status !== 200) throw new Error();
    });
    await check("owned credit key revocation readback failed", async () => {
      if (!key.token) throw new Error();
      // GET is not an admitted Responses operation, even if revocation did not commit.
      const result = await deps.send("https://api.trustedtunnel.app/backend-api/codex/responses", key.token);
      const body = parseJson(result.text);
      if (result.status !== 401 || !isRecord(body) || !isRecord(body.error) || body.error.code !== "invalid_api_key") {
        throw new Error();
      }
    });
  }
  for (const surface of ["codex", "grok"]) {
    await check(`owned ${surface} credit policy removal failed`, async () => {
      const result = await deps.admin("DELETE", `/admin/users/${userId}/credits/${surface}`);
      if (result.status !== 200) throw new Error();
    });
  }
  await check("owned credit policy readback failed", async () => {
    const result = await deps.admin("GET", `/admin/users/${userId}/credits`);
    if (result.status !== 200 || !isRecord(result.json) || !Array.isArray(result.json.states)) throw new Error();
    for (const surface of ["codex", "grok"]) {
      const state = result.json.states.find((row) => isRecord(row) && row.surface_grant === `surface:${surface}:production`);
      if (!isRecord(state) || (state.source !== "organization" && state.source !== "unconfigured")) throw new Error();
    }
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "live credit task or owned cleanup failed");
  }
}
