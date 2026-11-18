export interface LarkAppCredential {
  kind: "lark-app";
  appId: string;
  appSecret: string;
}

export function isLarkAppCredential(value: unknown): value is LarkAppCredential {
  if (!value || typeof value !== "object") return false;
  const {kind, appId, appSecret} = value as Partial<LarkAppCredential>;
  return kind === "lark-app" && typeof appId === "string" && /^cli_[a-z0-9]{1,124}$/i.test(appId)
    && typeof appSecret === "string" && /^[\x21-\x7e]{1,256}$/.test(appSecret);
}

interface TenantToken { value: string; expiresAt: number }

/** One cache per encrypted credential version. The object can discard it at any time. */
export class LarkTenantTokenCache {
  private token?: TenantToken;
  private nextAttemptAt = 0;
  private pending?: Promise<string | null>;

  read(credential: LarkAppCredential, send: (request: Request) => Promise<Response>, now = Date.now): Promise<string | null> {
    if (this.pending) return this.pending;
    const started = now();
    if (started < this.nextAttemptAt) return Promise.resolve(this.current(started));

    this.pending = this.exchange(credential, send, started).then(token => {
      this.token = token;
      const lifetime = token.expiresAt - started;
      this.nextAttemptAt = token.expiresAt - Math.min(60_000, lifetime / 10);
      return this.current(now());
    }, () => {
      const failedAt = now();
      this.nextAttemptAt = failedAt + 5_000;
      return this.current(failedAt);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private current(now: number): string | null {
    return this.token && this.token.expiresAt > now ? this.token.value : null;
  }

  private async exchange(credential: LarkAppCredential, send: (request: Request) => Promise<Response>, started: number): Promise<TenantToken> {
    const response = await send(new Request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({app_id:credential.appId,app_secret:credential.appSecret}),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    }));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Feishu token exchange unavailable");
    }
    const result = await response.json<{code?:unknown;tenant_access_token?:unknown;expire?:unknown}>();
    const {code,tenant_access_token,expire} = result;
    if (code !== 0 || typeof tenant_access_token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(tenant_access_token)
      || typeof expire !== "number" || !Number.isSafeInteger(expire) || expire <= 0) {
      throw new Error("Feishu token exchange unavailable");
    }
    return { value:tenant_access_token, expiresAt:started + Math.min(expire,7200) * 1000 };
  }
}
