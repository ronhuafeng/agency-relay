import { retainConsoleActor } from "./authority";

export function setConsoleStatus(message: string, state: "pending" | "stale" | "error" = "pending"): void {
  const status = document.querySelector<HTMLElement>("[data-console-status]");
  if (!status) return;
  status.hidden = !message;
  status.textContent = message;
  status.dataset.state = state;
}

/** Periodic local reads. A changed model can wait for the user's current task;
 * no background operation submits forms or probes a provider. */
export function initializeBackgroundRefresh(apply: (doc: Document) => void): () => void {
  const listeners = new AbortController();
  const editedForms = new Set<HTMLFormElement>();
  const changedTabs = new Set<Element>();
  let lastRead = Date.now();
  let observed: HTMLElement | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  const main = (): HTMLElement | null => document.querySelector<HTMLElement>("main#content");
  const busy = (root: HTMLElement): boolean => root.dataset.mutationPending === "true" || root.dataset.memberMutationBlocked === "true" || root.dataset.dashboardMutationBlocked === "true" || root.getAttribute("aria-busy") === "true" || Boolean(root.querySelector('form[aria-busy="true"],[data-one-time-key],[data-member-result],[data-member-feedback][data-state="error"],[data-member-feedback][data-state="pending"]'));
  const visible = (node: Element): boolean => node.getClientRects().length > 0;
  const defer = (root: HTMLElement): boolean => {
    for (const form of editedForms) if (!root.contains(form)) editedForms.delete(form);
    for (const tabs of changedTabs) if (!root.contains(tabs)) changedTabs.delete(tabs);
    const active = document.activeElement;
    return editedForms.size > 0 || changedTabs.size > 0
      || active instanceof Element && active.matches(".usage-chart-bar")
      || active instanceof HTMLElement && active.matches("input,textarea,select,button,a[href],summary")
      || Boolean(root.querySelector('[data-draft-state]:not([hidden]),[data-slot=collapsible-content][data-state=open],details[open],[data-member-key-open=true],[data-credit-editor-state=open],[data-dashboard-notice][data-state=error]:not([hidden])'))
      || Array.from(document.querySelectorAll('[popover]:popover-open,[role=dialog],[role=alertdialog],[data-slot=dropdown-menu-content]')).some(visible)
      || Boolean(document.querySelector<HTMLInputElement>("#console-navigation-toggle")?.checked)
      || Array.from(root.querySelectorAll<HTMLInputElement>('input[type=password],[data-visible-row-filter-input]')).some(input => input.value !== "");
  };
  document.addEventListener("input", event => {
    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) && field.form) editedForms.add(field.form);
  }, {signal: listeners.signal});
  document.addEventListener("change", event => {
    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement) && field.form) editedForms.add(field.form);
  }, {signal: listeners.signal});
  document.addEventListener("reset", event => { if (event.target instanceof HTMLFormElement) editedForms.delete(event.target); }, {signal: listeners.signal});
  document.addEventListener("console:restore", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.matches("[data-dashboard-draft]") && !form.querySelector('[data-draft-state]:not([hidden])')) editedForms.delete(form);
  }, {capture: true, signal: listeners.signal});
  document.addEventListener("click", event => {
    const tabs = event.target instanceof Element ? event.target.closest('[data-slot=tabs-trigger]')?.closest('[data-slot=tabs]') : null;
    if (tabs) changedTabs.add(tabs);
  }, {signal: listeners.signal});
  document.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const tabs = event.target instanceof Element ? event.target.closest('[data-slot=tabs-trigger]')?.closest('[data-slot=tabs]') : null;
    if (tabs) changedTabs.add(tabs);
  }, {signal: listeners.signal});
  const check = async (): Promise<void> => {
    const root = main();
    if (root !== observed) { observed = root; lastRead = Date.now(); }
    const interval = root?.dataset.dashboardView === "usage" ? 300000 : 120000;
    if (disposed || controller || !root?.dataset.consoleReadUrl || !root.dataset.consoleRevision
      || document.visibilityState !== "visible" || !navigator.onLine || document.documentElement.hasAttribute("data-console-authority-pending")
      || busy(root) || Date.now() - lastRead < interval) return;
    const readUrl = root.dataset.consoleReadUrl;
    const url = new URL(readUrl, location.href);
    if (url.origin !== location.origin) return;
    const revision = root.dataset.consoleRevision;
    const current = (): boolean => !disposed && main() === root && root.dataset.consoleRevision === revision && root.dataset.consoleReadUrl === readUrl && !busy(root);
    lastRead = Date.now();
    const request = new AbortController(); controller = request;
    const timeout = window.setTimeout(() => request.abort(), 20000);
    try {
      const response = await fetch(url.href, {headers: {Accept: "text/html"}, credentials: "same-origin", cache: "no-store", redirect: "error", signal: request.signal});
      if (!current()) return;
      if (response.headers.get("Content-Type")?.includes("application/json")) {
        const value: unknown = await response.json();
        if (!current()) return;
        const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error ? value.error.code : null;
        if (["admin_required", "admin_auth_required", "user_inactive", "console_identity_changed", "service_not_found"].includes(String(code))) {
          document.dispatchEvent(new CustomEvent("console:actor-changed", {detail: {outcome: "read", changed: false, reason: "authority"}}));
          return;
        }
        throw new Error("read unavailable");
      }
      if (!response.headers.get("Content-Type")?.includes("text/html")) throw new Error("read unavailable");
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      if (!current()) return;
      if (!retainConsoleActor(doc)) return;
      if (!document.querySelector("[data-member-nav]") && doc.querySelector("[data-member-nav]")) {
        document.dispatchEvent(new CustomEvent("console:actor-changed", {detail: {outcome: "read", changed: false, reason: "authority"}}));
        return;
      }
      const incoming = doc.querySelector<HTMLElement>("main#content");
      if (!response.ok || !incoming?.dataset.consoleRevision || incoming.dataset.consoleReadUrl !== root.dataset.consoleReadUrl) throw new Error("read unavailable");
      if (incoming.dataset.consoleRevision === revision) {
        if (document.querySelector<HTMLElement>("[data-console-status]")?.dataset.state !== "pending") setConsoleStatus("");
        return;
      }
      if (defer(root)) { setConsoleStatus("有新数据", "stale"); return; }
      const active = document.activeElement;
      const focusId = active instanceof HTMLElement && root.contains(active) ? active.id : "";
      const focusHeading = active instanceof HTMLElement && root.contains(active) && /^H[1-6]$/.test(active.tagName) ? active.tagName.toLowerCase() : null;
      const position = {left: scrollX, top: scrollY, behavior: "instant" as const};
      apply(doc);
      const destination = focusId ? document.getElementById(focusId) : focusHeading ? main()?.querySelector<HTMLElement>(focusHeading) : null;
      if (destination) { destination.tabIndex = -1; destination.focus({preventScroll: true}); }
      scrollTo(position); setConsoleStatus("");
    } catch {
      if (current()) setConsoleStatus("更新暂不可用", "error");
    } finally { clearTimeout(timeout); request.abort(); if (controller === request) controller = null; }
  };
  observed = main();
  const timer = window.setInterval(() => { void check(); }, 30000);
  return () => { disposed = true; listeners.abort(); controller?.abort(); clearInterval(timer); editedForms.clear(); changedTabs.clear(); };
}
