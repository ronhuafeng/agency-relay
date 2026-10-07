/**
 * Accounts Auth management projection.
 * Product: docs/product/experience.md
 *
 * Pure seam: raw auth/subscription rows + optional oauth-started flash
 * → one management state + allowed actions for render and tests.
 */

/** Matches auto-refresh lead in TokenAuthority (near-expiry window). */
export const AUTH_EXPIRING_LEAD_MS = 10 * 60 * 1000;

export type AuthManagementState =
  | "absent"
  | "active"
  | "expiring_soon"
  | "expired"
  | "degraded"
  | "reauth_required"
  | "revoked"
  | "authorizing";

/** Steady + authorizing operator actions (product language). */
export type AuthManagementAction =
  | "connect"
  | "refresh"
  | "reauth"
  | "logout"
  | "continue_authorize"
  | "save_redirect"
  | "cancel";

export interface OAuthPendingInput {
  session_id: string;
  authorize_url: string;
}

export interface AuthManagementProjection {
  state: AuthManagementState;
  /** Actions shown as primary (filled) controls, left-to-right. */
  primaryActions: AuthManagementAction[];
  /** Secondary / outline controls. */
  secondaryActions: AuthManagementAction[];
  statusLabel: string;
  email: string | null;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  label: string | null;
  /** Present only when state === authorizing. */
  authorizeUrl: string | null;
  sessionId: string | null;
  /** True when Re-auth replaces an existing bound identity (confirm copy). */
  reauthReplacesActive: boolean;
}

export interface CodexAuthProjectionInput {
  auth: {
    status: string;
    expires_at: string | null;
    last_refresh_at: string | null;
    upstream_email: string | null;
  } | null;
  oauthPending?: OAuthPendingInput | null;
  nowMs: number;
}

export interface GrokAccountProjectionInput {
  account: {
    status: string;
    expires_at: string | null;
    last_refresh_at: string | null;
    label: string;
  };
  oauthPending?: OAuthPendingInput | null;
  nowMs: number;
}

/**
 * Project one ChatGPT credential account into management state + actions (doc §3–4).
 */
export function projectCodexIdentity(input: CodexAuthProjectionInput): AuthManagementProjection {
  if (input.oauthPending?.session_id && input.oauthPending.authorize_url) {
    return authorizingProjection(input.oauthPending, observeFromCodex(input.auth), boundForReauth(input.auth));
  }
  const base = observeFromCodex(input.auth);
  const state = projectStoredState(input.auth?.status ?? null, input.auth?.expires_at ?? null, input.nowMs);
  return withActions(state, base, boundForReauth(input.auth));
}

/**
 * Project one Grok subscription account into management state + actions.
 */
export function projectGrokIdentity(input: GrokAccountProjectionInput): AuthManagementProjection {
  if (input.oauthPending?.session_id && input.oauthPending.authorize_url) {
    return authorizingProjection(
      input.oauthPending,
      observeFromGrok(input.account),
      boundForReauthGrok(input.account.status)
    );
  }
  const base = observeFromGrok(input.account);
  const state = projectStoredState(input.account.status, input.account.expires_at, input.nowMs);
  return withActions(state, base, boundForReauthGrok(input.account.status));
}

/** Actions allowed for a steady (non-authorizing) management state — doc §4. */
export function actionsForState(state: AuthManagementState): {
  primaryActions: AuthManagementAction[];
  secondaryActions: AuthManagementAction[];
} {
  switch (state) {
    case "absent":
    case "revoked":
      return { primaryActions: ["connect"], secondaryActions: [] };
    case "active":
    case "expiring_soon":
    case "expired":
    case "degraded":
      return { primaryActions: ["refresh"], secondaryActions: ["reauth", "logout"] };
    case "reauth_required":
      return { primaryActions: ["reauth"], secondaryActions: ["logout"] };
    case "authorizing":
      return {
        primaryActions: ["continue_authorize", "save_redirect"],
        secondaryActions: ["cancel"]
      };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function projectStoredState(
  status: string | null,
  expiresAt: string | null,
  nowMs: number
): AuthManagementState {
  if (!status || status === "pending_credential") {
    return "absent";
  }
  if (status === "revoked" || status === "disabled") {
    return "revoked";
  }
  if (status === "reauth_required") {
    return "reauth_required";
  }
  if (status === "degraded") {
    return "degraded";
  }
  if (status === "active") {
    const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(expiry)) {
      if (expiry <= nowMs) return "expired";
      if (expiry - nowMs <= AUTH_EXPIRING_LEAD_MS) return "expiring_soon";
    }
    return "active";
  }
  // Unknown non-empty statuses (e.g. legacy refresh_error): still bound → maintainable.
  return "degraded";
}

function observeFromCodex(auth: CodexAuthProjectionInput["auth"]): Pick<
  AuthManagementProjection,
  "email" | "expiresAt" | "lastRefreshAt" | "label" | "statusLabel"
> {
  if (!auth) {
    return {
      email: null,
      expiresAt: null,
      lastRefreshAt: null,
      label: null,
      statusLabel: "未连接"
    };
  }
  return {
    email: auth.upstream_email,
    expiresAt: auth.expires_at,
    lastRefreshAt: auth.last_refresh_at,
    label: null,
    statusLabel: auth.status
  };
}

function observeFromGrok(account: GrokAccountProjectionInput["account"]): Pick<
  AuthManagementProjection,
  "email" | "expiresAt" | "lastRefreshAt" | "label" | "statusLabel"
> {
  return {
    email: null,
    expiresAt: account.expires_at,
    lastRefreshAt: account.last_refresh_at,
    label: account.label,
    statusLabel: account.status
  };
}

function boundForReauth(auth: CodexAuthProjectionInput["auth"]): boolean {
  if (!auth) {
    return false;
  }
  return auth.status === "active" || auth.status === "degraded" || auth.status === "reauth_required";
}

function boundForReauthGrok(status: string): boolean {
  return status === "active" || status === "degraded" || status === "reauth_required";
}

function authorizingProjection(
  pending: OAuthPendingInput,
  observe: Pick<AuthManagementProjection, "email" | "expiresAt" | "lastRefreshAt" | "label" | "statusLabel">,
  reauthReplacesActive: boolean
): AuthManagementProjection {
  const actions = actionsForState("authorizing");
  const rawLabel = reauthReplacesActive ? "re-authorizing" : "connecting";
  return {
    state: "authorizing",
    primaryActions: actions.primaryActions,
    secondaryActions: actions.secondaryActions,
    statusLabel: humanStatusLabel("authorizing", rawLabel),
    email: observe.email,
    expiresAt: observe.expiresAt,
    lastRefreshAt: observe.lastRefreshAt,
    label: observe.label,
    authorizeUrl: pending.authorize_url,
    sessionId: pending.session_id,
    reauthReplacesActive
  };
}

function withActions(
  state: AuthManagementState,
  observe: Pick<AuthManagementProjection, "email" | "expiresAt" | "lastRefreshAt" | "label" | "statusLabel">,
  reauthReplacesActive: boolean
): AuthManagementProjection {
  const actions = actionsForState(state);
  return {
    state,
    primaryActions: actions.primaryActions,
    secondaryActions: actions.secondaryActions,
    statusLabel: humanStatusLabel(state, observe.statusLabel),
    email: observe.email,
    expiresAt: observe.expiresAt,
    lastRefreshAt: observe.lastRefreshAt,
    label: observe.label,
    authorizeUrl: null,
    sessionId: null,
    reauthReplacesActive
  };
}

export function humanStatusLabel(state: AuthManagementState, raw: string = state): string {
  switch (state) {
    case "absent":
      return "未连接";
    case "active":
      return "已连接";
    case "expiring_soon":
      return "即将过期";
    case "expired":
      return "访问已过期";
    case "degraded":
      return "需要处理";
    case "reauth_required":
      return "需要重新连接";
    case "revoked":
      return "已断开";
    case "authorizing":
      return raw === "re-authorizing" ? "正在完成重新连接" : "等待登录";
    default:
      return raw || state;
  }
}

/** Operator-facing button labels (product language only). */
export function actionButtonLabel(action: AuthManagementAction): string {
  switch (action) {
    case "connect":
      return "连接";
    case "refresh":
      return "刷新账号";
    case "reauth":
      return "重新连接";
    case "logout":
      return "断开";
    case "continue_authorize":
      return "打开登录";
    case "save_redirect":
      return "保存回调地址";
    case "cancel":
      return "取消";
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Operator guidance only for states that need action (shown as card body callout).
 * Steady connection/expiry states rely on status, date and primary button.
 * Authorizing is guided by the OAuth strip, not a separate callout.
 */
export function operatorHintForState(state: AuthManagementState): string | null {
  switch (state) {
    case "absent":
    case "revoked":
    case "active":
    case "expiring_soon":
    case "expired":
    case "authorizing":
      return null;
    case "degraded":
      return "先刷新账号。刷新失败时，再重新连接。";
    case "reauth_required":
      return "请重新登录。登录完成前，客户端不能使用这个账号。";
    default:
      return null;
  }
}

/** Status text tone classes. Warning is not a failure. */
export type StatusTone = "ok" | "warn" | "bad" | "neutral";

export function statusToneForState(state: AuthManagementState): StatusTone {
  switch (state) {
    case "active":
      return "ok";
    case "expiring_soon":
      return "warn";
    case "reauth_required":
    case "degraded":
    case "expired":
      return "bad";
    case "absent":
    case "revoked":
    case "authorizing":
      return "neutral";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
