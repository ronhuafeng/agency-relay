import { retainConsoleActor, endConsoleRuntime, recordConsoleOutcome } from "./authority";
import { memberHref as personalHref } from "../member-href";
import { consoleLoginHref } from "../return-target";
import { buttonVariants } from "../ui/components/button";
import { readConsoleRejection } from "../ui/messages";

type Control = HTMLInputElement | HTMLButtonElement | HTMLSelectElement;
function isControl(value: Element): value is Control {
  return value instanceof HTMLInputElement || value instanceof HTMLButtonElement || value instanceof HTMLSelectElement;
}
function writable(value: EventTarget | null): HTMLFormElement | null {
  if (!(value instanceof HTMLFormElement) || value.method !== "post") return null;
  const url = new URL(value.action, location.href);
  return url.origin === location.origin && /^\/me(?:\/service-accounts\/[^/]+)?\/ui\/keys(?:\/revoke-all|\/[^/]+\/(?:replace|revoke|rename))?$/.test(url.pathname) ? value : null;
}
function confirmedRevocation(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("revoked" in value)) return false;
  return value.revoked === true && "id" in value && typeof value.id === "string"
    || typeof value.revoked === "number" && Number.isSafeInteger(value.revoked) && value.revoked >= 0;
}
function memberDocument(html: string): {document: Document; main: HTMLElement} | null {
  const document = new DOMParser().parseFromString(html, "text/html");
  const main = document.querySelector<HTMLElement>(".console-simple main#content");
  return main ? {document, main} : null;
}

/** A member write is never replayed. A lost result blocks the form until a fresh read. */
export function initializeMemberMutations(): () => void {
  const serviceId = /^\/me\/service-accounts\/([^/]+)/.exec(location.pathname)?.[1];
  const memberHref = (view: Parameters<typeof personalHref>[0], key?: string): string => personalHref(view,key,serviceId ? decodeURIComponent(serviceId) : undefined);
  const returnPath = new URL(memberHref("keys"),location.href).pathname;
  const validReturn = (url: URL): boolean => url.origin === location.origin && url.pathname === returnPath && url.searchParams.get("view") === "keys";
  let disposed = false;
  const listeners = new AbortController(); const signal = listeners.signal;
  const blocked = new WeakSet<HTMLFormElement>(); let pending: AbortController | null = null;
  const blockDocument = (): void => {
    const main = document.querySelector<HTMLElement>("main#content"); if (!main) return;
    main.dataset.memberMutationBlocked = "true";
    main.querySelectorAll<HTMLButtonElement>("form button").forEach(button => {if (button.type === "submit") button.disabled = true;});
  };
  const feedback = (message: string, state: "pending" | "error" | "success", focus = false, recoveryHref?: string): void => {
    const main = document.querySelector<HTMLElement>("main#content"); if (!main) return;
    let notice = main.querySelector<HTMLElement>("[data-member-feedback]");
    if (!notice) { notice = document.createElement("div"); notice.dataset.memberFeedback = ""; main.prepend(notice); }
    notice.className = "member-feedback"; notice.dataset.state = state; notice.setAttribute("role", state === "error" ? "alert" : "status"); notice.setAttribute("aria-live", "polite"); notice.replaceChildren();
    const text = document.createElement("p"); text.textContent = message; notice.append(text);
    if (state === "pending") {
      const stop = document.createElement("button"); stop.type = "button"; stop.dataset.slot = "button"; stop.className = buttonVariants({variant: "outline"}); stop.textContent = "停止等待"; stop.addEventListener("click", () => pending?.abort(), {signal}); notice.append(stop);
    }
    if (recoveryHref) { const link = document.createElement("a"); link.href = recoveryHref; link.textContent = "查看当前密钥"; notice.append(link); }
    if (focus) { notice.tabIndex = -1; notice.focus(); notice.scrollIntoView({block: "nearest"}); }
  };
  const show = (result: {document: Document; main: HTMLElement}, href = memberHref("keys")): void => {
    document.querySelector("main#content")?.replaceWith(result.main); document.title = result.document.title;
    history.replaceState(null, "", href);
    const focus = result.main.querySelector<HTMLElement>("[data-one-time-key],h1"); if (focus) {focus.tabIndex = -1; focus.focus(); focus.scrollIntoView({block: "start"});}
  };
  document.addEventListener("submit", event => {
    const form = writable(event.target); if (form && (pending || blocked.has(form) || document.querySelector('main[data-member-mutation-blocked="true"]'))) {event.preventDefault(); event.stopImmediatePropagation();}
  }, {capture: true, signal});
  document.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (pending && link) event.preventDefault();
  }, {signal});
  window.addEventListener("beforeunload", event => {if (pending) {event.preventDefault(); event.returnValue = "";}}, {signal});
  const submit = async (form: HTMLFormElement, body: URLSearchParams): Promise<void> => {
    const controller = new AbortController(); pending = controller;
    const controls = Array.from(document.querySelectorAll("main form button,main form input,main form select")).filter(isControl);
    const disabled = new Map(controls.map(control => [control, control.disabled])); controls.forEach(control => {control.disabled = true;}); form.setAttribute("aria-busy", "true");
    document.querySelectorAll("[data-member-nav] a").forEach(link => link.setAttribute("aria-disabled", "true"));
    feedback("正在提交…停止等待不会撤销服务器上的操作。", "pending"); let unknown = false;
    let acknowledged: string | null = null;
    const submittedReturn = body.get("key_return");
    const parsedReturn = new URL(submittedReturn || memberHref("keys"), location.href);
    let href = validReturn(parsedReturn)
      ? memberHref("keys", parsedReturn.searchParams.get("key") ?? undefined) : memberHref("keys");
    const refresh = async (): Promise<boolean> => {
      const read = await fetch(href, {headers: {Accept: "text/html"}, credentials: "same-origin", cache: "no-store", signal: controller.signal});
      const result = read.ok ? memberDocument(await read.text()) : null;
      if (disposed) return false;
      if (result && !retainConsoleActor(result.document, acknowledged ? "confirmed" : "read")) return false;
      if (!result?.main.querySelector('[data-member-view="keys"]') || result.main.querySelector('[data-read-state="unknown"],[data-read-state="unavailable"]')) return false;
      show(result, href); recordConsoleOutcome("confirmed"); feedback(`${acknowledged} 当前列表已更新。`, "success", true); return true;
    };
    try {
      recordConsoleOutcome("unknown");
      const response = await fetch(form.action, {method: "POST", body, headers: {Accept: "text/html"}, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal});
      if (disposed) return;
      if (response.headers.get("Content-Type")?.includes("text/html")) {
        const result = memberDocument(await response.text());
        if (disposed) return;
        const terminal = result?.main.querySelector<HTMLElement>("[data-console-terminal-result]");
        const next = terminal?.dataset.consoleNext;
        const login = next ? new URL(next, location.href) : null;
        const loginHref = login?.origin === location.origin && login.pathname === "/login"
          && next === consoleLoginHref(login.searchParams.get("return") ?? "") ? next : null;
        if (response.status === 403 && loginHref && result) {
          // A known authentication rejection is not an uncertain mutation.
          endConsoleRuntime(); show(result, loginHref);
          document.querySelector("[data-member-nav]")?.remove();
          document.querySelectorAll(".identity").forEach(node => node.remove());
          return;
        }
        const authorityOutcome = result?.main.querySelector('[data-member-result="rejected"]') && [400,403,404,409,422,503].includes(response.status) ? "rejected"
          : response.ok && result?.main.querySelector('[data-one-time-key],[data-member-result="confirmed"]') ? "confirmed" : "unknown";
        recordConsoleOutcome(authorityOutcome);
        if (result && !retainConsoleActor(result.document, authorityOutcome)) return;
        if (response.ok && result?.main.querySelector("[data-one-time-key]")) {
          const target = new URL(result.main.querySelector<HTMLElement>("[data-one-time-key]")?.dataset.memberReturn ?? href, location.href);
          if (validReturn(target)) href = memberHref("keys", target.searchParams.get("key") ?? undefined);
          show(result, href); recordConsoleOutcome("confirmed"); return;
        }
        const outcome = result?.main.querySelector<HTMLElement>("[data-member-result]");
        if (outcome?.dataset.memberResult === "rejected" && [400,403,404,409,422,503].includes(response.status)) {
          feedback(outcome.querySelector("p")?.textContent ?? "操作未执行，请查看当前状态。", "error", true, href); return;
        }
        if (response.ok && outcome?.dataset.memberResult === "confirmed" && result) {
          acknowledged = outcome.querySelector("p")?.textContent ?? "操作已完成。";
          const target = new URL(outcome.dataset.memberReturn ?? href, location.href);
          if (validReturn(target)) href = memberHref("keys", target.searchParams.get("key") ?? undefined);
          show(result, href); recordConsoleOutcome("confirmed");
          if (await refresh()) return;
        }
      } else if (response.headers.get("Content-Type")?.includes("application/json")) {
        const value: unknown = await response.json(); if (disposed) return;
        if ([400,403,404,409,422].includes(response.status)) {
          const message = readConsoleRejection(value);
          if (message) {
            recordConsoleOutcome("rejected");
            const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error ? value.error.code : null;
            if (response.status === 404 && code === "service_not_found"
              || response.status === 403 && ["admin_auth_required", "console_identity_changed"].includes(String(code))) {
              document.dispatchEvent(new CustomEvent("console:actor-changed", {detail:{outcome:"rejected",changed:false,reason:"authority"}}));
              return;
            }
            feedback(message, "error", true, response.status === 403 ? href : undefined); return;
          }
        }
        if (response.ok && confirmedRevocation(value)) {
          recordConsoleOutcome("confirmed");
          acknowledged = typeof value === "object" && value !== null && "already_revoked" in value && value.already_revoked === true ? "密钥原本已撤销。" : "密钥已撤销。";
          if (await refresh()) return;
        }
      }
      unknown = acknowledged === null;
    } catch {unknown = acknowledged === null;}
    finally {
      pending = null;
      if (disposed) return; disabled.forEach((value, control) => {control.disabled = value;}); form.removeAttribute("aria-busy"); document.querySelectorAll("[data-member-nav] a").forEach(link => link.removeAttribute("aria-disabled"));
      if (acknowledged !== null && !document.querySelector('[data-member-feedback][data-state="success"]')) {
        blockDocument();
        blocked.add(form); form.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach(button => {button.disabled = true;});
        feedback(`${acknowledged} 列表未刷新，请只读核对当前密钥，无需再次提交。`, "success", true, href);
      }
      if (unknown) {
        blockDocument();
        blocked.add(form); form.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach(button => {button.disabled = true;});
        feedback("操作结果尚未确认。请先查看当前密钥，不要重复提交。", "error", true, href);
      }
    }
  };
  document.addEventListener("submit", event => {
    if (event.defaultPrevented) return; const form = writable(event.target); if (!form) return;
    const body = new URLSearchParams(); for (const [name, value] of new FormData(form)) {if (typeof value !== "string") return; body.append(name, value);}
    event.preventDefault(); void submit(form, body);
  }, {signal});
  return () => {disposed = true; listeners.abort(); pending?.abort();};
}
