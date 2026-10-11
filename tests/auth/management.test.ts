import { describe, expect, it } from "vitest";
import {
  AUTH_EXPIRING_LEAD_MS,
  actionButtonLabel,
  actionsForState,
  operatorHintForState,
  projectCodexIdentity,
  projectGrokIdentity,
  statusToneForState,
  type AuthManagementAction,
  type AuthManagementState
} from "../../src/admin/auth-management";

describe("account auth-management projection", () => {
  const nowMs = Date.parse("2026-07-28T12:00:00.000Z");

  it("maps doc §4 action table for every steady state", () => {
    const table: Record<AuthManagementState, { primary: string[]; secondary: string[] }> = {
      absent: { primary: ["connect"], secondary: [] },
      revoked: { primary: ["connect"], secondary: [] },
      active: { primary: ["refresh"], secondary: ["reauth", "logout"] },
      expiring_soon: { primary: ["refresh"], secondary: ["reauth", "logout"] },
      expired: { primary: ["refresh"], secondary: ["reauth", "logout"] },
      degraded: { primary: ["refresh"], secondary: ["reauth", "logout"] },
      reauth_required: { primary: ["reauth"], secondary: ["logout"] },
      authorizing: {
        primary: ["continue_authorize", "save_redirect"],
        secondary: ["cancel"]
      }
    };
    for (const [state, expected] of Object.entries(table)) {
      const actions = actionsForState(state as AuthManagementState);
      expect(actions.primaryActions).toEqual(expected.primary);
      expect(actions.secondaryActions).toEqual(expected.secondary);
    }
  });

  it("projects absent ChatGPT when no auth row", () => {
    const p = projectCodexIdentity({ auth: null, nowMs });
    expect(p.state).toBe("absent");
    expect(p.primaryActions).toEqual(["connect"]);
    expect(p.secondaryActions).toEqual([]);
    expect(p.authorizeUrl).toBeNull();
  });

  it("projects active ChatGPT with refresh + reauth + logout", () => {
    const p = projectCodexIdentity({
      auth: {
        admission_state: "enabled",
        status: "active",
        expires_at: "2026-08-01T06:08:02.000Z",
        last_refresh_at: "2026-07-22T06:08:00.000Z",
        upstream_email: "op@example.com"
      },
      nowMs
    });
    expect(p.state).toBe("active");
    expect(p.primaryActions).toEqual(["refresh"]);
    expect(p.secondaryActions).toEqual(["reauth", "logout"]);
    expect(p.email).toBe("op@example.com");
    expect(p.reauthReplacesActive).toBe(true);
  });

  it("projects expiring_soon within lead window", () => {
    const expires = new Date(nowMs + AUTH_EXPIRING_LEAD_MS - 60_000).toISOString();
    const p = projectCodexIdentity({
      auth: {
        admission_state: "enabled",
        status: "active",
        expires_at: expires,
        last_refresh_at: null,
        upstream_email: null
      },
      nowMs
    });
    expect(p.state).toBe("expiring_soon");
    expect(p.primaryActions).toContain("refresh");
  });

  it("projects reauth_required with Re-auth primary", () => {
    const p = projectCodexIdentity({
      auth: {
        admission_state: "enabled",
        status: "reauth_required",
        expires_at: null,
        last_refresh_at: null,
        upstream_email: "x@y.z"
      },
      nowMs
    });
    expect(p.state).toBe("reauth_required");
    expect(p.primaryActions).toEqual(["reauth"]);
    expect(p.secondaryActions).toEqual(["logout"]);
  });

  describe.each(["ChatGPT", "Grok"])("%s expiry observation", (client) => {
    const project = (status: string, expires_at: string | null, pending = false) => {
      const common = { status, expires_at, last_refresh_at: null };
      const oauthPending = pending ? { session_id: "pending", authorize_url: "https://example.test/login" } : null;
      return client === "ChatGPT"
        ? projectCodexIdentity({ auth: { ...common, admission_state: "enabled", upstream_email: null }, oauthPending, nowMs })
        : projectGrokIdentity({ account: { ...common, label: "Team" }, oauthPending, nowMs });
    };

    it.each([
      [-1, "expired"],
      [0, "expired"],
      [1, "expiring_soon"],
      [AUTH_EXPIRING_LEAD_MS, "expiring_soon"],
      [AUTH_EXPIRING_LEAD_MS + 1, "active"]
    ] as const)("distinguishes an expiry %i ms from observation as %s", (offset, state) => {
      const expiry = new Date(nowMs + offset).toISOString();
      const p = project("active", expiry);
      expect(p.state).toBe(state);
      expect(p.expiresAt).toBe(expiry);
      expect(p.primaryActions).toEqual(["refresh"]);
      expect(p.secondaryActions).toEqual(["reauth", "logout"]);
      expect(p.reauthReplacesActive).toBe(true);
      if (state === "expired") {
        expect(p.statusLabel).toBe("访问已过期");
        expect(operatorHintForState(p.state)).toBeNull();
        expect(statusToneForState(p.state)).toBe("bad");
      }
    });

    it.each([null, "not-a-date"])("does not invent an expiry from %s", (expiry) => {
      expect(project("active", expiry).state).toBe("active");
    });

    it.each([
      ["pending_credential", "absent"], ["revoked", "revoked"], ["disabled", "revoked"],
      ["degraded", "degraded"], ["reauth_required", "reauth_required"], ["refresh_error", "degraded"]
    ] as const)("keeps %s authoritative over a past expiry", (status, state) => {
      expect(project(status, new Date(nowMs - 1000).toISOString()).state).toBe(state);
    });

    it("keeps an in-progress sign-in above an expired observation", () => {
      const p = project("active", new Date(nowMs - 1000).toISOString(), true);
      expect(p.state).toBe("authorizing");
      expect(p.primaryActions).toEqual(["continue_authorize", "save_redirect"]);
    });
  });

  it("oauth pending forces authorizing over stored active", () => {
    const p = projectCodexIdentity({
      auth: {
        admission_state: "enabled",
        status: "active",
        expires_at: "2026-08-01T00:00:00.000Z",
        last_refresh_at: null,
        upstream_email: "op@example.com"
      },
      oauthPending: {
        session_id: "oauth_abc",
        authorize_url: "https://auth.openai.com/oauth/authorize?x=1"
      },
      nowMs
    });
    expect(p.state).toBe("authorizing");
    expect(p.primaryActions).toEqual(["continue_authorize", "save_redirect"]);
    expect(p.secondaryActions).toEqual(["cancel"]);
    expect(p.sessionId).toBe("oauth_abc");
    expect(p.authorizeUrl).toContain("auth.openai.com");
    expect(p.email).toBe("op@example.com");
    expect(p.reauthReplacesActive).toBe(true);
    expect(p.statusLabel).toBe("正在完成重新连接");
  });

  it("projects Grok revoked as Connect only", () => {
    const p = projectGrokIdentity({
      account: {
        status: "revoked",
        expires_at: null,
        last_refresh_at: null,
        label: "grok-production"
      },
      nowMs
    });
    expect(p.state).toBe("revoked");
    expect(p.primaryActions).toEqual(["connect"]);
    expect(p.label).toBe("grok-production");
  });

  it("projects Grok authorizing with pending only for that account flash", () => {
    const p = projectGrokIdentity({
      account: {
        status: "active",
        expires_at: "2026-08-01T00:00:00.000Z",
        last_refresh_at: "2026-07-20T00:00:00.000Z",
        label: "grok-production"
      },
      oauthPending: {
        session_id: "oauth_g",
        authorize_url: "https://auth.x.ai/oauth2/authorize?c=1"
      },
      nowMs
    });
    expect(p.state).toBe("authorizing");
    expect(p.authorizeUrl).toContain("auth.x.ai");
  });

  it("exposes product-language status labels for every steady state", () => {
    expect(projectCodexIdentity({ auth: null, nowMs }).statusLabel).toBe("未连接");
    expect(
      projectCodexIdentity({
        auth: {
        admission_state: "enabled",
          status: "active",
          expires_at: "2026-08-01T00:00:00.000Z",
          last_refresh_at: null,
          upstream_email: null
        },
        nowMs
      }).statusLabel
    ).toBe("已连接");
    expect(
      projectCodexIdentity({
        auth: {
        admission_state: "enabled",
          status: "degraded",
          expires_at: null,
          last_refresh_at: null,
          upstream_email: null
        },
        nowMs
      }).statusLabel
    ).toBe("需要处理");
    expect(
      projectCodexIdentity({
        auth: {
        admission_state: "enabled",
          status: "reauth_required",
          expires_at: null,
          last_refresh_at: null,
          upstream_email: null
        },
        nowMs
      }).statusLabel
    ).toBe("需要重新连接");
    expect(
      projectGrokIdentity({
        account: {
          status: "revoked",
          expires_at: null,
          last_refresh_at: null,
          label: "g"
        },
        nowMs
      }).statusLabel
    ).toBe("已断开");
  });

  it("maps every action to a short operator button label", () => {
    const labels: Record<AuthManagementAction, string> = {
      connect: "连接",
      refresh: "刷新账号",
      reauth: "重新连接",
      logout: "断开",
      continue_authorize: "打开登录",
      save_redirect: "保存回调地址",
      cancel: "取消"
    };
    for (const [action, label] of Object.entries(labels)) {
      expect(actionButtonLabel(action as AuthManagementAction)).toBe(label);
    }
  });

  it("returns operator hints only for action-needed steady states", () => {
    expect(operatorHintForState("absent")).toBeNull();
    expect(operatorHintForState("revoked")).toBeNull();
    expect(operatorHintForState("active")).toBeNull();
    expect(operatorHintForState("authorizing")).toBeNull();
    expect(operatorHintForState("expiring_soon")).toBeNull();
    expect(operatorHintForState("expired")).toBeNull();
    expect(operatorHintForState("degraded")).toMatch(/刷新账号/);
    expect(operatorHintForState("reauth_required")).toMatch(/重新登录/);
  });

  it("maps status tones to existing token classes only", () => {
    expect(statusToneForState("active")).toBe("ok");
    expect(statusToneForState("reauth_required")).toBe("bad");
    expect(statusToneForState("degraded")).toBe("bad");
    expect(statusToneForState("expiring_soon")).toBe("warn");
    expect(statusToneForState("absent")).toBe("neutral");
    expect(statusToneForState("revoked")).toBe("neutral");
    expect(statusToneForState("authorizing")).toBe("neutral");
  });
});


it.each(["active", "reauth_required", "revoked"])("keeps %s credential health and recovery independent from admission pause", status => {
  const auth = {status,admission_state:"paused" as const,expires_at:null,last_refresh_at:null,upstream_email:null};
  const input = {auth,nowMs:Date.parse("2026-07-28T12:00:00.000Z")};
  const paused = projectCodexIdentity(input);
  const enabled = projectCodexIdentity({...input,auth:{...auth,admission_state:"enabled"}});
  expect(paused.admissionState).toBe("paused"); expect(enabled.admissionState).toBe("enabled");
  expect(paused.state).toBe(status); expect(enabled.state).toBe(status);
  expect(paused.primaryActions).toEqual(enabled.primaryActions); expect(paused.secondaryActions).toEqual(enabled.secondaryActions);
  const pending = projectCodexIdentity({...input,oauthPending:{session_id:"synthetic",authorize_url:"https://example.test/login"}});
  expect(pending.state).toBe("authorizing"); expect(pending.admissionState).toBe("paused");
});
