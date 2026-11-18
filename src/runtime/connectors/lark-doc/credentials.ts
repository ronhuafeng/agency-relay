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

interface TenantToken { value: string; expiresAt: number; scopes: string[] }

/** One cache per encrypted credential version. The object can discard it at any time. */
export class LarkTenantTokenCache {
  private token?: TenantToken;
  private nextAttemptAt = 0;
  private pending?: Promise<TenantToken | null>;

  constructor(private readonly scoped=false) {}

  read(credential: LarkAppCredential, send: (request: Request) => Promise<Response>, now = Date.now): Promise<TenantToken | null> {
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

  private current(now: number): TenantToken | null {
    return this.token && this.token.expiresAt > now ? this.token : null;
  }

  private async exchange(credential: LarkAppCredential, send: (request: Request) => Promise<Response>, started: number): Promise<TenantToken> {
    const url=this.scoped?"https://accounts.feishu.cn/oauth/v3/token":"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    const response = await send(new Request(url, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(this.scoped
        ?{grant_type:"client_credentials",client_id:credential.appId,client_secret:credential.appSecret}
        :{app_id:credential.appId,app_secret:credential.appSecret}),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    }));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Feishu token exchange unavailable");
    }
    const result = await response.json<{code?:unknown;tenant_access_token?:unknown;expire?:unknown;access_token?:unknown;expires_in?:unknown;scope?:unknown}>();
    const value=this.scoped?result.access_token:result.tenant_access_token;
    const expire=this.scoped?result.expires_in:result.expire;
    if (result.code !== 0 || typeof value !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value)
      || typeof expire !== "number" || !Number.isSafeInteger(expire) || expire <= 0) {
      throw new Error("Feishu token exchange unavailable");
    }
    const scopes=this.scoped&&typeof result.scope==="string"?result.scope.split(/\s+/).filter(Boolean):[];
    return {value,expiresAt:started+Math.min(expire,7200)*1000,scopes};
  }
}
