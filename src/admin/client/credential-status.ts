import type { AuthManagementState, StatusTone } from "../auth-management";
import { formatOperatorInstant } from "../format";
import { consoleActorId } from "./authority";

interface CredentialStatus {
  key: string;
  state: AuthManagementState;
  statusLabel: string;
  tone: StatusTone;
  hint: string | null;
  expiresAt: string | null;
  lastRefreshAt: string | null;
}

const states = new Set<AuthManagementState>(["absent", "active", "expiring_soon", "expired", "degraded", "reauth_required", "revoked", "authorizing"]);
const tones = ["ok", "warn", "bad", "neutral"] as const;
const refreshable = new Set<AuthManagementState>(["active", "expiring_soon", "expired", "degraded"]);
const nullableText = (value: unknown, limit: number): boolean => value === null || typeof value === "string" && value.length <= limit;

function readStatuses(value: unknown): Map<string, CredentialStatus> | null {
  if (!value || typeof value !== "object" || !("revision" in value) || typeof value.revision !== "string" || value.revision.length > 256
    || !("accounts" in value) || !Array.isArray(value.accounts) || value.accounts.length > 1000) return null;
  const result = new Map<string, CredentialStatus>();
  for (const item of value.accounts) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !/^(codex|grok):[^\s]{1,200}$/.test(item.key)
      || result.has(item.key) || !states.has(item.state) || !tones.includes(item.tone)
      || typeof item.statusLabel !== "string" || item.statusLabel.length > 200
      || !nullableText(item.hint, 1000) || !nullableText(item.expiresAt, 200) || !nullableText(item.lastRefreshAt, 200)) return null;
    result.set(item.key, item as CredentialStatus);
  }
  return result;
}

/** Pushes are invalidations only. Read local metadata before changing the current
 * actor's status; never replace a task, restore authority or probe a provider. */
export function initializeCredentialStatus(): () => void {
  const actor = consoleActorId();
  const admin = (): boolean => document.querySelector<HTMLElement>("[data-console-role]")?.dataset.consoleRole === "admin"
    && Boolean(document.querySelector(".shell[data-dashboard-nav]"));
  if (!actor || !admin()) return () => {};
  const listeners = new AbortController();
  const disabledByStatus = new WeakSet<HTMLButtonElement | HTMLInputElement>();
  const pendingHints = new WeakMap<HTMLElement, string>();
  let latest = new Map<string, CredentialStatus>();
  let observedMain = document.querySelector("main#content");
  let observedCredentials = Boolean(observedMain?.querySelector("[data-credential-key]"));
  let disposed = false;
  let generation = 0;
  let request: AbortController | null = null;
  let queued = false;
  let socket: WebSocket | null = null;
  let reconnect: number | undefined;
  let connecting: number | undefined;
  let backoff = 1000;
  const writing = (): boolean => Boolean(document.querySelector('main[data-mutation-pending="true"],main[aria-busy="true"],main form[aria-busy="true"]'));
  const ready = (): boolean => !disposed && admin() && consoleActorId() === actor && document.visibilityState === "visible"
    && Boolean(document.querySelector("main#content [data-credential-key]")) && navigator.onLine
    && !document.documentElement.hasAttribute("data-console-authority-pending") && !writing();
  const authorityChanged = (changed = false): void => {
    stop();
    document.dispatchEvent(new CustomEvent("console:actor-changed", {detail: {outcome: "read", changed, reason: "authority"}}));
  };
  const submits = (form: HTMLFormElement): Array<HTMLButtonElement | HTMLInputElement> => Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button[type="submit"],button:not([type]),input[type="submit"]'));
  const restrictRefresh = (root: HTMLElement, blocked: boolean): void => {
    root.querySelectorAll<HTMLFormElement>("form[data-credential-refresh]").forEach(form => {
      if (blocked) form.dataset.credentialRefreshBlocked = "true";
      else delete form.dataset.credentialRefreshBlocked;
      submits(form).forEach(button => {
        if (blocked) {
          if (!button.disabled) disabledByStatus.add(button);
          button.disabled = true;
        } else if (disabledByStatus.has(button) && !document.querySelector('main[data-dashboard-mutation-blocked="true"]')) {
          button.disabled = false;
          disabledByStatus.delete(button);
        }
      });
    });
    const missingRefresh = root.hasAttribute("data-mgmt-state") && root.dataset.oauthPending !== "true"
      && !root.querySelector("form[data-credential-refresh]");
    root.querySelectorAll<HTMLElement>("[data-credential-read-current]").forEach(link => { link.hidden = !blocked && !missingRefresh; });
  };
  const updateAttention = (root: HTMLElement, status: CredentialStatus): void => {
    if (!root.hasAttribute("data-home-account")) return;
    const queue = root.closest("[data-has-attention]")?.querySelector<HTMLElement>("[data-attention-queue]");
    if (!queue) return;
    let item = Array.from(queue.querySelectorAll<HTMLElement>("[data-attention-account]"))
      .find(candidate => candidate.dataset.attentionAccount === status.key);
    if (status.tone !== "warn" && status.tone !== "bad") {
      if (item?.contains(document.activeElement)) document.querySelector<HTMLAnchorElement>(".home-resource-summary a[href*='view=credentials']")?.focus({preventScroll: true});
      item?.remove();
      return;
    }
    if (!item) {
      const template = root.querySelector<HTMLTemplateElement>("[data-credential-attention-item]");
      const content = template?.content.firstElementChild;
      if (!content) return;
      item = content.cloneNode(true) as HTMLElement;
      queue.append(item);
    }
    item.dataset.tone = status.tone;
    const detail = item.querySelector<HTMLElement>("[data-credential-status]");
    if (detail) detail.textContent = status.statusLabel;
  };
  const apply = (accounts: Map<string, CredentialStatus>): void => {
    latest = accounts;
    document.querySelectorAll<HTMLElement>("[data-credential-key]").forEach(root => {
      const status = accounts.get(root.dataset.credentialKey ?? "");
      restrictRefresh(root, !status || !refreshable.has(status.state));
      if (!status) return;
      updateAttention(root, status);
      const authorizing = root.dataset.oauthPending === "true";
      if (root.hasAttribute("data-mgmt-state") && !authorizing) root.dataset.mgmtState = status.state;
      if (!authorizing) root.querySelectorAll<HTMLElement>("[data-credential-status]").forEach(badge => {
        if (badge.textContent !== status.statusLabel) badge.textContent = status.statusLabel;
        badge.classList.remove(...tones.map(tone => `tone-${tone}`));
        badge.classList.add(`tone-${status.tone}`);
      });
      if (!authorizing) {
        root.querySelectorAll<HTMLElement>("[data-credential-expiry]").forEach(row => {
          row.hidden = !status.expiresAt;
          const label = row.querySelector("dt"); if (label) label.textContent = status.state === "expired" ? "已过期" : "到期时间";
          const value = row.querySelector("dd"); if (value) value.textContent = status.expiresAt ? formatOperatorInstant(status.expiresAt) : "";
        });
        root.querySelectorAll<HTMLElement>("[data-credential-last-refresh]").forEach(row => {
          row.hidden = !status.lastRefreshAt;
          const value = row.querySelector("dd"); if (value) value.textContent = status.lastRefreshAt ? formatOperatorInstant(status.lastRefreshAt) : "";
        });
        root.querySelectorAll<HTMLElement>("[data-credential-dates]").forEach(list => { list.hidden = Array.from(list.children).every(row => row.hasAttribute("hidden")); });
      }
      root.querySelectorAll<HTMLElement>("[data-credential-hint]").forEach(hint => {
        let message = status.hint ?? "";
        if (authorizing) {
          if (["reauth_required", "revoked", "degraded"].includes(status.state)) {
            if (!pendingHints.has(hint)) pendingHints.set(hint, hint.textContent ?? "");
            message = `当前连接：${status.statusLabel}。${message}`;
          } else if (pendingHints.has(hint)) {
            message = pendingHints.get(hint)!; pendingHints.delete(hint);
          } else return;
        }
        if (hint.textContent !== message) hint.textContent = message;
        hint.hidden = !message;
      });
    });
    document.querySelectorAll<HTMLElement>("[data-attention-queue]").forEach(queue => {
      const count = queue.children.length;
      const panel = queue.closest<HTMLElement>('[data-panel="attention"]');
      if (panel) {
        panel.hidden = count === 0;
        const total = panel.querySelector<HTMLElement>("[data-attention-count]");
        if (total) total.textContent = `${count} 项`;
      }
      const grid = queue.closest<HTMLElement>("[data-has-attention]");
      if (grid) grid.dataset.hasAttention = String(count > 0);
    });
  };
  const invalidate = (): void => {
    generation++;
    request?.abort(); request = null; queued = true;
  };
  const read = async (): Promise<void> => {
    if (request || !ready()) { queued = true; return; }
    queued = false;
    const currentMain = document.querySelector("main#content");
    const id = generation;
    const controller = new AbortController(); request = controller;
    const current = (): boolean => !controller.signal.aborted && id === generation && ready()
      && document.querySelector("main#content") === currentMain;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/admin/credential-status", {headers: {Accept: "application/json"}, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal});
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { authorityChanged(); return; }
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return;
      const value: unknown = await response.json();
      if (!current()) return;
      if (!value || typeof value !== "object" || !("actorId" in value) || typeof value.actorId !== "string") return;
      if (value.actorId !== actor) { authorityChanged(true); return; }
      const accounts = readStatuses(value);
      if (accounts) apply(accounts);
    } catch {
      // Retain last confirmed facts. A later notification, poll or reconnect reads
      // again; a transport failure is not a disconnected provider account.
    } finally {
      clearTimeout(timeout); controller.abort();
      if (request === controller) { request = null; if (queued && ready()) void read(); }
    }
  };
  const connect = (): void => {
    if (!ready() || socket || reconnect !== undefined) return;
    const url = new URL("/admin/events/credentials", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const retry = (): void => {
      if (!ready() || reconnect !== undefined) return;
      reconnect = window.setTimeout(() => { reconnect = undefined; connect(); }, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    let connection: WebSocket;
    try { connection = new WebSocket(url.href); } catch { retry(); return; }
    socket = connection;
    const active = (): boolean => !disposed && socket === connection;
    connecting = window.setTimeout(() => {
      if (!active()) return;
      socket = null; connection.close(); connecting = undefined; retry();
    }, 10000);
    connection.addEventListener("message", event => {
      if (!active() || typeof event.data !== "string" || event.data.length > 128) return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "connected") { clearTimeout(connecting); connecting = undefined; backoff = 1000; void read(); }
      else if (message.type === "credentials-changed") void read();
    });
    connection.addEventListener("close", event => {
      if (!active()) return;
      socket = null; clearTimeout(connecting); connecting = undefined;
      if (event.code === 4403) { if (ready()) authorityChanged(); return; }
      retry();
    });
  };
  const pause = (): void => {
    invalidate(); clearTimeout(reconnect); reconnect = undefined; clearTimeout(connecting); connecting = undefined;
    const connection = socket; socket = null; connection?.close();
  };
  const resume = (): void => { if (ready()) { connect(); void read(); } };
  const stop = (): void => {
    if (disposed) return;
    disposed = true; pause(); listeners.abort(); observer.disconnect(); clearInterval(poll); latest.clear();
  };
  document.addEventListener("submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-credential-refresh]")) return;
    const key = form.closest<HTMLElement>("[data-credential-key]")?.dataset.credentialKey;
    const state = key ? latest.get(key)?.state : null;
    if (form.dataset.credentialRefreshBlocked === "true" || state && !refreshable.has(state)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, {capture: true, signal: listeners.signal});
  document.addEventListener("visibilitychange", () => { pause(); queueMicrotask(resume); }, {signal: listeners.signal});
  window.addEventListener("offline", pause, {signal: listeners.signal});
  window.addEventListener("online", resume, {signal: listeners.signal});
  window.addEventListener("pagehide", stop, {signal: listeners.signal});
  document.addEventListener("console:actor-changed", stop, {signal: listeners.signal});
  document.addEventListener("console:document-ended", stop, {signal: listeners.signal});
  const observer = new MutationObserver(records => {
    if (disposed) return;
    let activityChanged = false;
    let newCredentials = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.attributeName === "disabled" && record.target instanceof Element) {
          const form = record.target.closest<HTMLFormElement>('form[data-credential-refresh-blocked="true"]');
          if (form) submits(form).forEach(button => { if (!button.disabled) { disabledByStatus.add(button); button.disabled = true; } });
        } else activityChanged = true;
      } else for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches("[data-credential-key]") || node.querySelector("[data-credential-key]"))) newCredentials = true;
      }
    }
    const main = document.querySelector("main#content");
    const credentials = Boolean(main?.querySelector("[data-credential-key]"));
    if (main !== observedMain || newCredentials || credentials !== observedCredentials) {
      observedMain = main; observedCredentials = credentials; latest.clear(); pause(); resume();
    } else if (activityChanged) { if (!ready()) pause(); else resume(); }
  });
  observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "data-console-role", "data-mutation-pending", "aria-busy"]});
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-console-authority-pending"]});
  const poll = window.setInterval(() => { void read(); }, 120000);
  resume();
  return stop;
}
