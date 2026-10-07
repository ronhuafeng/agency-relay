import { retainConsoleActor, endConsoleRuntime, recordConsoleOutcome } from "./authority";
import type { Navigation } from "./navigation";
import { readConsoleRejection } from "../ui/messages";
import { consoleReturnTarget } from "../return-target";
function writable(target: EventTarget | null): HTMLFormElement | null {
  if (!(target instanceof HTMLFormElement) || target.method !== "post" || target.matches("[data-local-config-sync]")) return null;
  const url = new URL(target.action, location.href);
  return url.origin === location.origin && url.pathname.startsWith("/admin/ui/") ? target : null;
}
type Control = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function isControl(value: Element): value is Control {
  return value instanceof HTMLButtonElement || value instanceof HTMLInputElement || value instanceof HTMLSelectElement || value instanceof HTMLTextAreaElement;
}
export function initializeMutations(navigation: Navigation): () => void {
  let disposed = false;
  let pending: AbortController | null = null; const blocked = new WeakSet<HTMLFormElement>(); const listeners = new AbortController(); const signal = listeners.signal;
  document.addEventListener("submit", (event) => {
    const form = writable(event.target);
    if (form && (pending || blocked.has(form) || document.querySelector('main[data-dashboard-mutation-blocked="true"]')
      || document.documentElement.hasAttribute("data-console-authority-pending"))) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  const focusNotice = (): void => {
    const region = document.querySelector<HTMLElement>("[data-dashboard-notice]"); if (!region) return;
    region.tabIndex = -1; region.focus({ preventScroll: true }); region.scrollIntoView({ block: "nearest" });
  };
  const unknownResult = (form: HTMLFormElement): void => {
    blocked.add(form); navigation.discardDraft(form);
    const main = document.querySelector<HTMLElement>("main#content");
    if (main) main.dataset.dashboardMutationBlocked = "true";
    main?.querySelectorAll("form").forEach(candidate => {
      if (!writable(candidate)) return;
      Array.from(candidate.elements).forEach(control => {
        if ((control instanceof HTMLButtonElement || control instanceof HTMLInputElement) && control.type === "submit") control.disabled = true;
      });
    });
    const readUrl = navigation.currentUrl(); readUrl.searchParams.delete("task");
    navigation.notice("操作结果尚未确认，请先查看当前状态。不要重复提交。", "error", readUrl, "查看当前状态"); focusNotice();
  };
  const submit = async (form: HTMLFormElement, submitter: HTMLElement | null, body: URLSearchParams): Promise<void> => {
    recordConsoleOutcome("unknown");
    const controller = new AbortController(); pending = controller;
    const controls = [...document.querySelectorAll('.shell form button,.shell form input[type="submit"]'), ...form.elements].filter(isControl);
    const disabled = new Map(controls.map((control) => [control, control.disabled]));
    navigation.setMutationPending(true); controls.forEach((control) => { control.disabled = true; });
    form.setAttribute("aria-busy", "true"); const action = submitter?.textContent?.trim() || "提交"; navigation.notice(`正在${action}…`, "pending");
    const timer = setTimeout(() => { if (pending === controller) navigation.notice(`仍在等待“${action}”的结果。停止等待不会撤销服务器上的操作。`, "pending"); }, 20000);
    let unknown = false;
    try {
      const response = await fetch(form.action, { method: "POST", body, headers: { Accept: "text/html" }, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (disposed) return;
      const type = response.headers.get("Content-Type") ?? "";
      if (type.includes("text/html")) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        if (disposed) return;
        const terminal = doc.querySelector<HTMLElement>("[data-console-terminal-result]");
        const incomingMain = doc.querySelector("main#content");
        const shells = Array.from(doc.querySelectorAll(".shell"));
        const publicLayout = shells.length <= 1 && shells.every(shell => shell.childElementCount === 1 && shell.firstElementChild === incomingMain && shell.contains(terminal));
        const unknownTarget = terminal?.dataset.consoleTerminalResult === "unknown" ? consoleReturnTarget(terminal.dataset.consoleNext ?? "") : null;
        const unknownLink = doc.querySelector<HTMLAnchorElement>('[data-console-recovery] a');
        const publicUnknown = Boolean(publicLayout && unknownTarget && unknownLink && consoleReturnTarget(unknownLink.getAttribute("href") ?? "") === unknownTarget
          && doc.querySelector('[data-console-recovery] [data-console-outcome="unknown"]')
          && !doc.querySelector('[data-console-actor-id],[data-console-email],[data-dashboard-nav],[data-member-nav],[data-dashboard-view],[data-member-view],.identity,form,[data-ui-props],script[type="application/json"],[data-one-time-key]'));
        if (terminal && incomingMain && (publicUnknown
          || terminal.dataset.consoleTerminalResult !== "unknown" && (response.ok || response.status === 403) && ["/login", "/admin?view=keys"].includes(terminal.dataset.consoleNext ?? ""))) {
          navigation.discardDraft(form); navigation.dispose(); endConsoleRuntime();
          document.body.replaceChildren(...doc.body.childNodes); document.body.className = doc.body.className; document.title = doc.title;
          history.replaceState(null, "", publicUnknown ? unknownTarget! : terminal.dataset.consoleNext!);
          const heading = document.querySelector<HTMLElement>("h1"); if (heading) {heading.tabIndex = -1; heading.focus();} return;
        }
        const result = doc.querySelector<HTMLElement>("main[data-dashboard-mutation]");
        const url = result?.dataset.dashboardUrl ? new URL(result.dataset.dashboardUrl, location.href) : null;
        if (result && url?.origin === location.origin && ["/", "/admin"].includes(url.pathname) && doc.querySelector(".shell")) {
          const outcome = result.dataset.dashboardMutation?.endsWith("_error") ? "rejected" : "confirmed";
          recordConsoleOutcome(outcome);
          if (!retainConsoleActor(doc, outcome)) return;
          const inputError = doc.querySelector("[data-mutation-input-error]");
          if (inputError) {
            const recovery = inputError.querySelector<HTMLAnchorElement>("a[data-rejected-read]");
            const readUrl = recovery ? new URL(recovery.getAttribute("href") ?? "",location.href) : null;
            navigation.notice(inputError.querySelector("p")?.textContent ?? inputError.textContent ?? "请检查填写的内容。", "error", readUrl?.origin === location.origin ? readUrl : null, recovery?.textContent?.trim() || "查看当前状态");
            focusNotice(); return;
          }
          navigation.showMutationResult(doc, form); recordConsoleOutcome(outcome); return;
        }
      } else if ([400, 401, 403, 409, 422].includes(response.status) && type.includes("application/json")) {
        const value: unknown = await response.json(); if (disposed) return; const message = readConsoleRejection(value);
        if (message) {
          recordConsoleOutcome("rejected");
          const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error ? value.error.code : null;
          if ([401, 403].includes(response.status) && ["admin_auth_required", "admin_required", "console_identity_changed"].includes(String(code))) {
            document.dispatchEvent(new CustomEvent("console:actor-changed", { detail: { outcome: "rejected", changed: false, reason: "authority" } }));
            return;
          }
          if ([401, 403].includes(response.status)) {
            blocked.add(form); navigation.discardDraft(form);
            const readUrl = navigation.currentUrl(); readUrl.searchParams.delete("task");
            navigation.notice(message, "error", readUrl, "查看当前状态");
          } else navigation.notice(message, "error");
          focusNotice(); return;
        }
      }
      unknown = true;
    } catch { unknown = true; }
    finally {
      clearTimeout(timer); pending = null;
      if (disposed) return; navigation.setMutationPending(false); disabled.forEach((value, control) => { control.disabled = value; }); form.removeAttribute("aria-busy");
      if (unknown) unknownResult(form);
      else if (blocked.has(form)) form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button[type="submit"],button:not([type]),input[type="submit"]').forEach(button => { button.disabled = true; });
    }
  };
  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return; const form = writable(event.target); if (!form) return;
    const data = new FormData(form);
    const submitter = event instanceof SubmitEvent ? event.submitter : null;
    if ((submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) && submitter.name) data.append(submitter.name, submitter.value);
    const body = new URLSearchParams(); for (const [name, value] of data) { if (typeof value !== "string") return; body.append(name, value); }
    event.preventDefault(); void submit(form, submitter, body);
  }, { signal });
  document.addEventListener("click", (event) => { if (event.target instanceof Element && event.target.closest("[data-stop-waiting]")) pending?.abort(); }, { signal });
  window.addEventListener("beforeunload", (event) => { if (pending) { event.preventDefault(); event.returnValue = ""; } }, { signal });
  return () => { disposed = true; listeners.abort(); pending?.abort(); };
}
