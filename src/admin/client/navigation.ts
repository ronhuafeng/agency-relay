import { retainConsoleActor } from "./authority";
import { consoleLoginHref } from "../return-target";
import type { Drafts } from "./drafts";
import { setConsoleStatus } from "./background-refresh";
interface Context { url: string; scroll: number; focusLink: string | null; filters: string[] }
interface Entry { miniEntry: string; miniDepth: number }
export interface Navigation {
  notice(message: string, kind?: string, url?: URL | null, linkLabel?: string): void;
  currentUrl(): URL;
  discardDraft(form: HTMLFormElement): void;
  setMutationPending(pending: boolean): void;
  showMutationResult(doc: Document, form: HTMLFormElement): void;
  acceptBackground(doc: Document): void;
  dispose(): void;
}
function readEntry(value: unknown): Entry | null {
  if (typeof value !== "object" || value === null || !("miniEntry" in value) || !("miniDepth" in value)) return null;
  return typeof value.miniEntry === "string" && typeof value.miniDepth === "number" && Number.isSafeInteger(value.miniDepth) ? { miniEntry: value.miniEntry, miniDepth: value.miniDepth } : null;
}
function required<T>(value: T | null, name: string): T { if (value === null) throw new Error(name); return value; }
const shellSelector = '.shell[data-dashboard-nav]';

function navigationShape(nav: HTMLElement): string {
  const shape = nav.cloneNode(true) as HTMLElement;
  // Account controls own their hydrated DOM. Their server identity is checked
  // separately; only the destination links and native navigation are compared.
  shape.querySelector(".console-nav-account")?.remove();
  shape.querySelector(".nav-toggle-label strong")?.replaceChildren();
  const toggle = shape.querySelector<HTMLInputElement>("input#console-navigation-toggle.nav-toggle[type=checkbox]");
  // Restoring a temporary caret style can leave an equivalent empty attribute.
  if (toggle?.hasAttribute("style") && toggle.style.length === 0) toggle.removeAttribute("style");
  shape.querySelectorAll("a").forEach(link => {
    link.removeAttribute("href"); link.removeAttribute("aria-current"); link.removeAttribute("data-active"); link.removeAttribute("aria-disabled");
  });
  return shape.outerHTML;
}

function retainNavigation(current: HTMLElement, incoming: HTMLElement): boolean {
  const nav = current.querySelector<HTMLElement>(".nav-rail");
  const nextNav = incoming.querySelector<HTMLElement>(".nav-rail");
  const identity = nav?.querySelector<HTMLElement>("[data-console-actor-id]");
  const nextIdentity = nextNav?.querySelector<HTMLElement>("[data-console-actor-id]");
  if (!nav || !nextNav || !identity?.dataset.consoleActorId || !nextIdentity
    || current.dataset.dashboardNav !== incoming.dataset.dashboardNav
    || ["consoleActorId", "consoleEmail", "consoleRole"].some(key => identity.dataset[key] !== nextIdentity.dataset[key])
    || navigationShape(nav) !== navigationShape(nextNav)) return false;
  const links = Array.from(nav.querySelectorAll("a")).filter(link => !link.closest(".console-nav-account"));
  const nextLinks = Array.from(nextNav.querySelectorAll("a")).filter(link => !link.closest(".console-nav-account"));
  nextLinks.forEach((next, index) => {
    const link = links[index];
    for (const name of ["href", "aria-current", "data-active"]) {
      const value = next.getAttribute(name);
      if (value === null) link.removeAttribute(name); else link.setAttribute(name, value);
    }
  });
  const title = nav.querySelector(".nav-toggle-label strong");
  const nextTitle = nextNav.querySelector(".nav-toggle-label strong");
  if (title && nextTitle) title.textContent = nextTitle.textContent;
  return true;
}

export function createNavigation(initialize: (root: ParentNode) => void, drafts: Drafts): Navigation {
  const shell = (): HTMLElement => required(document.querySelector<HTMLElement>(shellSelector), "shell missing");
  const main = (): HTMLElement => required(document.querySelector<HTMLElement>("main#content"), "main missing");
  const integrate = (doc: Document, incoming: HTMLElement): void => {
    const current = shell();
    if (retainNavigation(current, incoming)) {
      main().replaceWith(required(incoming.querySelector<HTMLElement>("main#content"), "main missing"));
    } else current.replaceWith(incoming);
    document.title = doc.title;
    const header = document.querySelector(".site-header"); const nextHeader = doc.querySelector(".site-header");
    if (header && nextHeader) header.replaceWith(nextHeader);
    initialize(shell());
  };
  const pending = (): boolean => main().dataset.mutationPending === "true";
  const listeners = new AbortController(); const signal = listeners.signal;
  const contexts = new Map<string, Context>();
  const personalNavigation = Boolean(document.querySelector("[data-member-nav]"));
  let paneFocus: HTMLElement | null = null; let sequence = 0; let controller: AbortController | null = null;
  let busy = false; let restoring: string | null = null;
  let currentUrl = new URL(main().dataset.dashboardUrl ?? location.href, location.href);
  const requested = new URL(location.href); if (requested.pathname === currentUrl.pathname) currentUrl.hash = requested.hash;
  const savedEntry = readEntry(history.state); let entry = savedEntry?.miniEntry ?? crypto.randomUUID(); let depth = savedEntry?.miniDepth ?? 0;
  const state = (): Entry => ({ miniEntry: entry, miniDepth: depth });
  history.replaceState(state(), "", currentUrl); history.scrollRestoration = "manual";
  const updateInset = (): void => {
    const header = document.querySelector<HTMLElement>(".site-header"); const region = document.querySelector<HTMLElement>("[data-dashboard-notice]");
    const inset = (header?.getBoundingClientRect().height ?? 0) + (region && !region.hidden ? region.getBoundingClientRect().height + 8 : 0) + 16;
    document.documentElement.style.setProperty("--dashboard-scroll-inset", `${inset}px`);
  };
  const notice = (message: string, kind = "info", url: URL | null = null, label = "打开页面"): void => {
    const region = document.querySelector<HTMLElement>("[data-dashboard-notice]"); if (!region) return;
    region.hidden = !message || kind === "loading"; region.dataset.state = kind;
    setConsoleStatus(kind === "loading" ? message : "", "pending");
    const text = region.querySelector("[data-notice-message]"); if (text) text.textContent = message;
    const link = region.querySelector<HTMLAnchorElement>("a"); if (link) { link.hidden = !url; if (url) { link.href = url.href; link.textContent = label; link.dataset.dashboardLink = ""; link.dataset.dashboardRefresh = ""; } }
    const stop = region.querySelector<HTMLElement>("[data-stop-waiting]"); if (stop) stop.hidden = kind !== "pending"; updateInset();
  };
  const clearPrivatePage = (): void => {
    drafts.clear(); contexts.clear(); paneFocus = null;
    const region = main().querySelector<HTMLElement>("[data-dashboard-notice]");
    if (region) main().replaceChildren(region); else main().replaceChildren();
    main().removeAttribute("data-dashboard-view"); main().removeAttribute("data-dashboard-mutation");
    shell().querySelector(".nav-rail")?.remove();
    document.querySelector(".identity-person")?.replaceChildren();
  };
  const visible = (element: HTMLElement | null | undefined): element is HTMLElement => Boolean(element?.getClientRects().length);
  const heading = (): HTMLElement => Array.from(main().querySelectorAll<HTMLElement>("[data-person-detail] h2,[data-account-detail] h2,[data-setup-detail] h2")).find(visible) ?? required(main().querySelector<HTMLElement>("h1"), "heading missing");
  const focus = (destination: HTMLElement): void => { if (!destination.matches("input,select,textarea,button,a[href]")) destination.tabIndex = -1; destination.focus({ preventScroll: true }); };
  const save = (source: HTMLAnchorElement | null = null): void => {
    drafts.capture(shell());
    const link = source ?? document.activeElement?.closest<HTMLAnchorElement>("a[data-dashboard-link]") ?? null;
    const url = link ? new URL(link.href, location.href) : null;
    contexts.set(entry, { url: currentUrl.href, scroll: scrollY, focusLink: url && url.origin === currentUrl.origin && url.pathname === currentUrl.pathname && !link?.hasAttribute("download") ? url.href : null,
      filters: Array.from(document.querySelectorAll<HTMLInputElement>("[data-visible-row-filter-input]"), (input) => input.value) });
  };
  const restoreFilters = (context: Context | undefined): void => {
    if (!context) return;
    document.querySelectorAll<HTMLInputElement>("[data-visible-row-filter-input]").forEach((input, index) => { input.value = context.filters[index] ?? ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const position = (url: URL, context?: Context): void => {
    updateInset(); const target = url.hash ? document.getElementById(url.hash.slice(1)) : null; const section = visible(target) ? target : null;
    const link = context?.focusLink ? Array.from(main().querySelectorAll<HTMLAnchorElement>("a[data-dashboard-link]")).find((link) => link.href === context.focusLink && visible(link)) : undefined;
    const destination = link ?? section ?? main().querySelector<HTMLElement>("[data-person-detail] [autofocus],[data-account-detail] [autofocus]") ?? heading();
    if (section instanceof HTMLDetailsElement) section.open = true; focus(destination);
    if (context) scrollTo({ top: context.scroll, behavior: "instant" }); else if (section) section.scrollIntoView(); else scrollTo({ top: 0, behavior: "instant" });
    if (link || (context?.focusLink && !section)) destination.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const sectionNavigation = (url: URL, next: Entry | null = null): void => {
    if (busy) { sequence++; controller?.abort(); busy = false; main().removeAttribute("aria-busy"); notice(""); }
    save(); const context = next ? contexts.get(next.miniEntry) : undefined; currentUrl = url;
    if (next) { entry = next.miniEntry; depth = next.miniDepth; } else { entry = crypto.randomUUID(); depth++; history.pushState(state(), "", url); }
    restoreFilters(context); position(url, context);
  };
  const navigate = async (url: URL, mode: "push" | "refresh" | "back", next: Entry | null = null, source: HTMLAnchorElement | null = null): Promise<void> => {
    save(source); const requestSequence = ++sequence; controller?.abort(); controller = new AbortController(); busy = true;
    main().setAttribute("aria-busy", "true"); notice(mode === "refresh" ? "正在刷新页面…" : "正在打开页面…", "loading");
    try {
      const response = await fetch(url.href, { headers: { Accept: "text/html" }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (requestSequence !== sequence) return;
      if (!response.ok) {
        // An admin-only URL can legitimately become a member-shell 404 after
        // demotion. The current role projection still owns that response.
        if (response.headers.get("Content-Type")?.includes("text/html")) {
          const denied = new DOMParser().parseFromString(await response.text(), "text/html");
          if (requestSequence !== sequence) return;
          if (!personalNavigation && denied.querySelector("[data-member-nav]")) throw new Error("role");
        }
        // An object-specific denial is not proof that the whole session ended.
        if ([401, 403].includes(response.status)) {
          let code: unknown;
          try { const value: unknown = await response.json(); code = typeof value === "object" && value !== null && "error" in value && typeof value.error === "object" && value.error !== null && "code" in value.error ? value.error.code : undefined; } catch { /* Unrecognized denial has no session authority. */ }
          if (code === "admin_required") throw new Error("role");
          if (["admin_auth_required", "user_inactive", "console_identity_changed"].includes(String(code))) throw new Error("session");
          throw new Error("denied");
        }
        throw new Error("network");
      }
      const doc = new DOMParser().parseFromString(await response.text(), "text/html"); const replacement = doc.querySelector<HTMLElement>(shellSelector);
      if (requestSequence !== sequence) return;
      if (!personalNavigation && doc.querySelector("[data-member-nav]")) throw new Error("role");
      if (!replacement || !replacement.querySelector("main[data-dashboard-url]")) {
        if (response.url && new URL(response.url).pathname === "/login") throw new Error("session");
        throw new Error("network");
      }
      if (!retainConsoleActor(doc)) return;
      const closeContext = source?.hasAttribute("data-task-close") ? [...contexts.values()].reverse().find(context => {
        const saved = new URL(context.url); return saved.pathname === url.pathname && saved.search === url.search;
      }) : undefined;
      const context = mode === "push" ? closeContext : contexts.get(mode === "back" ? next?.miniEntry ?? "" : entry);
      drafts.capture(shell()); integrate(doc, replacement); currentUrl = url;
      if (mode === "push") { entry = crypto.randomUUID(); depth++; history.pushState(state(), "", url); }
      else if (mode === "back") { entry = next?.miniEntry ?? crypto.randomUUID(); depth = next?.miniDepth ?? 0; history.replaceState(state(), "", url); }
      else history.replaceState(state(), "", url);
      const changed = drafts.restore(shell()); restoreFilters(context);
      notice(changed ? "部分表单选项已改变，请检查当前值。" : "", changed ? "stale" : "success"); position(url, context);
    } catch (error) {
      if (requestSequence !== sequence) return;
      const reason = error instanceof Error ? error.message : "network";
      if (reason === "session" || reason === "role") {
        clearPrivatePage();
        notice(reason === "session" ? "登录状态无法验证，请重新登录。" : "当前角色已改变，请打开自己的首页。", "error", new URL(reason === "session" ? consoleLoginHref(url.pathname + url.search + url.hash) : "/", location.href), reason === "session" ? "重新登录" : "打开我的首页");
      } else if (mode === "back") { location.replace(url.href); }
      else notice((document.querySelector<HTMLElement>("[data-usage-range-label]")?.dataset.usageRangeLabel ? `仍显示旧范围 ${document.querySelector<HTMLElement>("[data-usage-range-label]")!.dataset.usageRangeLabel} 的上次数据（已过期）；已应用搜索：${document.querySelector<HTMLElement>("[data-usage-search]")?.dataset.usageSearch || "无"}。` : "") + (reason === "denied" ? "没有这个页面的访问权限，目前仍显示上次的数据。" : document.querySelector("[data-dashboard-unavailable]") ? "页面暂时打不开，请稍后重试。" : "页面暂时打不开，目前仍显示上次的数据。"), "error", url, "重试");
    } finally { if (requestSequence === sequence) { busy = false; main().removeAttribute("aria-busy"); } }
  };
  document.addEventListener("submit", (event) => {
    const form = event.target; if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !form.matches("[data-dashboard-search]") || form.method !== "get") return;
    const url = new URL(form.action, location.href); if (url.origin !== location.origin || url.pathname !== currentUrl.pathname) return;
    event.preventDefault(); if (pending()) return; url.search = "";
    for (const [name, value] of new FormData(form)) if (typeof value === "string") url.searchParams.append(name, value);
    url.hash = form.dataset.searchAnchor ?? ""; void navigate(url, "push");
  }, { signal });
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (pending() && target?.closest("a[data-dashboard-link],.section-links a")) { event.preventDefault(); return; }
    const section = target?.closest<HTMLAnchorElement>('.section-links a[href^="#"]'); if (section) { event.preventDefault(); sectionNavigation(new URL(section.href, location.href)); return; }
    const link = target?.closest<HTMLAnchorElement>("a[data-dashboard-link]"); if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href); if (url.origin !== location.origin || url.pathname !== currentUrl.pathname) return;
    event.preventDefault(); void navigate(url, link.hasAttribute("data-dashboard-refresh") || url.href === currentUrl.href ? "refresh" : "push", null, link);
  }, { signal });
  const paneTarget = (target: EventTarget | null): HTMLElement | null => target instanceof HTMLElement && target.matches("input,select,textarea,button,a[href],summary") && target.closest(".object-workspace-collection,[data-task-close]") ? target : null;
  document.addEventListener("pointerdown", (event) => { paneFocus = paneTarget(event.target); }, { signal });
  document.addEventListener("focusin", (event) => { paneFocus = paneTarget(event.target); }, { signal });
  window.addEventListener("resize", () => requestAnimationFrame(() => {
    updateInset(); if (document.visibilityState !== "visible" || document.querySelector('[data-action-confirmation][data-state="open"]') || pending()) return;
    const field = document.activeElement;
    if (paneFocus?.isConnected && !visible(paneFocus) && (!field || field === document.body || field === paneFocus)) { paneFocus = null; const target = heading(); focus(target); target.scrollIntoView({ block: "nearest" }); }
    else if (field instanceof HTMLElement && field.matches("input:not([type=hidden]),select,textarea") && visible(field)) field.scrollIntoView({ block: "nearest" });
  }), { signal });
  window.addEventListener("popstate", (event) => {
    const next = readEntry(event.state);
    if (restoring && next?.miniEntry === restoring) { restoring = null; history.replaceState(state(), "", currentUrl); return; }
    if (pending()) { const distance = depth - (next?.miniDepth ?? 0); if (distance) { restoring = entry; history.go(distance); } else history.replaceState(state(), "", currentUrl); return; }
    const url = new URL(location.href);
    if (url.pathname === currentUrl.pathname && url.search === currentUrl.search) { if (next) sectionNavigation(url, next); else { currentUrl = url; position(url); } return; }
    void navigate(url, "back", next);
  }, { signal });
  window.addEventListener("pagehide", () => { contexts.clear(); paneFocus = null; drafts.clear(); }, { signal });
  updateInset(); drafts.restore(shell());
  return {
    notice, currentUrl: () => new URL(currentUrl), discardDraft: (form) => drafts.discard(form),
    setMutationPending: (value) => {
      if (value) { drafts.capture(shell()); sequence++; controller?.abort(); busy = false; main().removeAttribute("aria-busy"); }
      main().dataset.mutationPending = String(value);
      document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("[data-dashboard-search] input,[data-dashboard-search] button").forEach((control) => { control.disabled = value; });
      document.querySelectorAll("a[data-dashboard-link],.section-links a").forEach((control) => { if (value) control.setAttribute("aria-disabled", "true"); else control.removeAttribute("aria-disabled"); });
    },
    showMutationResult: (doc, form) => {
      const result = required(doc.querySelector<HTMLElement>(shellSelector), "result missing"); const resultMain = required(result.querySelector<HTMLElement>("main#content"), "main missing");
      const url = new URL(resultMain.dataset.dashboardUrl ?? "", location.href); const inputError = resultMain.dataset.dashboardMutation === "user_create_error";
      if (!inputError) drafts.discard(form); integrate(doc, result); currentUrl = url; contexts.clear(); history.replaceState(state(), "", url);
      if (drafts.restore(shell(), inputError ? form : null)) notice("部分表单选项已改变，请检查当前值。", "stale"); updateInset();
      const destination = main().querySelector<HTMLElement>('[aria-invalid="true"],[data-one-time-key],[data-oauth-open],[data-mutation-flash]') ?? heading(); focus(destination); destination.scrollIntoView({ block: "nearest" });
    },
    acceptBackground: (doc) => {
      const replacement = required(doc.querySelector<HTMLElement>(shellSelector), "shell missing");
      drafts.capture(shell()); integrate(doc, replacement);
      paneFocus = null; drafts.restore(shell()); updateInset();
    },
    dispose: () => { sequence++; listeners.abort(); controller?.abort(); contexts.clear(); drafts.dispose(); }
  };
}
