/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeCredentialStatus } from "../../src/admin/client/credential-status";
import { initializeRecovery } from "../../src/admin/client/recovery";
import { formatOperatorInstant } from "../../src/admin/format";
import { dashboardHtml, element, submit } from "../support/browser-dom";

class StatusSocket extends EventTarget {
  static connections: StatusSocket[] = [];
  close = vi.fn();
  constructor(readonly url: string) { super(); StatusSocket.connections.push(this); }
  message(type: string): void { this.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({type})})); }
  disconnect(code = 1011): void { this.dispatchEvent(new CloseEvent("close", {code})); }
}
const status = (state = "active", key = "codex:shared-id") => ({key, state,
  statusLabel: state === "reauth_required" ? "需要重新连接" : "已连接",
  tone: state === "reauth_required" ? "bad" : "ok", hint: state === "reauth_required" ? "请重新登录。" : null,
  expiresAt: null as string | null, lastRefreshAt: null as string | null});
const model = (accounts = [status(), status("active", "grok:shared-id")], actorId = "actor-A") => ({actorId, accounts, revision: "metadata-1"});
const row = (key: string, id: string) => `<article id="${id}" data-credential-key="${key}"><span data-credential-status class="account-state tone-ok">已连接</span></article>`;
const detail = `<section id="detail" data-credential-key="codex:shared-id" data-mgmt-state="active">
  <span data-credential-status class="credential-status-meta tone-ok">已连接</span>
  <p data-credential-hint hidden></p><a data-credential-read-current hidden href="/admin?view=credentials&amp;account=codex%3Ashared-id&amp;q=Synthetic&amp;range=30d">查看当前连接</a>
  <form data-credential-refresh method="post" action="/admin/ui/codex-auths/shared-id/refresh"><input type="hidden" name="confirm" value="1"><button type="submit">刷新账号</button></form>
  <form data-dashboard-draft="unrelated"><input name="label" value="unfinished"><button type="submit" disabled>Locked action</button></form>
</section>`;
let stop = (): void => {};
let fetchMock: ReturnType<typeof vi.fn>;
const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };
const connection = (): StatusSocket => StatusSocket.connections.at(-1)!;
const badge = (): HTMLElement => element("#detail [data-credential-status]", HTMLElement);
const button = (): HTMLButtonElement => element("[data-credential-refresh] button", HTMLButtonElement);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  history.replaceState(null, "", "/admin?view=credentials&account=codex%3Ashared-id");
  document.body.innerHTML = new DOMParser().parseFromString(dashboardHtml("credentials", row("codex:shared-id", "index") + row("grok:shared-id", "other") + row("codex:shared-id", "home") + detail), "text/html").body.innerHTML;
  document.documentElement.removeAttribute("data-console-authority-pending"); document.body.inert = false;
  StatusSocket.connections = []; vi.stubGlobal("WebSocket", StatusSocket);
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(model()))); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { stop(); stop = () => {}; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

it("reads after connection and invalidation, updating exact provider-qualified projections without replacing tasks", async () => {
  stop = initializeCredentialStatus(); await settle(); expect(connection().url).toContain("/admin/events/credentials");
  connection().message("connected"); await settle();
  const main = element("main", HTMLElement); const form = element("form[data-dashboard-draft]", HTMLFormElement); const field = element("input[name=label]", HTMLInputElement);
  field.value = "my draft"; field.focus();
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required"), status("active", "grok:shared-id")])));
  connection().message("credentials-changed"); await settle();
  expect(element("main", HTMLElement)).toBe(main); expect(element("form[data-dashboard-draft]", HTMLFormElement)).toBe(form);
  expect(field.value).toBe("my draft"); expect(document.activeElement).toBe(field);
  for (const id of ["index", "home", "detail"]) expect(element(`#${id} [data-credential-status]`, HTMLElement).textContent).toBe("需要重新连接");
  expect(element("#other [data-credential-status]", HTMLElement).textContent).toBe("已连接");
  expect(badge().classList.contains("tone-bad")).toBe(true); expect(badge().classList.contains("tone-ok")).toBe(false);
  expect(button().disabled).toBe(true); expect(element("#detail [data-credential-hint]", HTMLElement).textContent).toBe("请重新登录。");
  const link = element("[data-credential-read-current]", HTMLAnchorElement);
  expect(link.hidden).toBe(false); expect(link.getAttribute("href")).toContain("account=codex%3Ashared-id&q=Synthetic&range=30d");
  expect(fetchMock).toHaveBeenCalledWith("/admin/credential-status", expect.objectContaining({credentials: "same-origin", cache: "no-store", redirect: "error", headers: {Accept: "application/json"}}));
  expect(fetchMock.mock.calls.every(call => call[1].method === undefined)).toBe(true);
});
it("retains pending OAuth and callback while reporting changed stored authority", async () => {
  const root = element("#detail", HTMLElement); root.dataset.oauthPending = "true"; root.dataset.mgmtState = "authorizing"; badge().textContent = "等待登录";
  root.insertAdjacentHTML("beforeend", '<div data-authorizing data-oauth-session="synthetic-pending"><form><input name="callback_url" value="http://localhost/callback?code=display-only"></form></div>');
  const strip = element("[data-authorizing]", HTMLElement); const callback = element("input[name=callback_url]", HTMLInputElement);
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); stop = initializeCredentialStatus(); await settle();
  expect(badge().textContent).toBe("等待登录"); expect(root.dataset.mgmtState).toBe("authorizing");
  expect(element("[data-authorizing]", HTMLElement)).toBe(strip); expect(callback.value).toContain("display-only");
  expect(element("[data-credential-hint]", HTMLElement).textContent).toBe("当前连接：需要重新连接。请重新登录。");
  connection().message("connected"); await settle(); expect(badge().textContent).toBe("等待登录"); expect(element("[data-credential-hint]", HTMLElement).hidden).toBe(true);
});
it("blocks obsolete refresh submissions even if another control enables the button", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); stop = initializeCredentialStatus(); await settle();
  button().disabled = false; expect(submit(element("[data-credential-refresh]", HTMLFormElement)).defaultPrevented).toBe(true);
  await settle(); expect(button().disabled).toBe(true); const unrelated = element("form[data-dashboard-draft] button", HTMLButtonElement); expect(unrelated.disabled).toBe(true);
  connection().message("connected"); await settle(); expect(button().disabled).toBe(false); expect(unrelated.disabled).toBe(true); expect(element("[data-credential-read-current]", HTMLElement).hidden).toBe(true);
});
it("a metadata read cannot unlock an uncertain document mutation", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); stop = initializeCredentialStatus(); await settle();
  element("main", HTMLElement).dataset.dashboardMutationBlocked = "true"; connection().message("connected"); await settle();
  expect(badge().textContent).toBe("已连接"); expect(button().disabled).toBe(true); expect(element("main", HTMLElement).dataset.dashboardMutationBlocked).toBe("true");
});
it("offers a current exact GET when a restored connection needs controls that the old detail did not render", async () => {
  element("#detail", HTMLElement).dataset.mgmtState = "reauth_required";
  element("form[data-credential-refresh]", HTMLFormElement).remove();
  const draft = element("form[data-dashboard-draft]", HTMLFormElement);
  stop = initializeCredentialStatus(); await settle();
  expect(badge().textContent).toBe("已连接"); expect(element("[data-credential-read-current]", HTMLElement).hidden).toBe(false);
  expect(document.querySelector("form[data-credential-refresh]")).toBeNull(); expect(element("form[data-dashboard-draft]", HTMLFormElement)).toBe(draft);
});
it("disables a disappeared exact account without pretending it is revoked", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(model([status("active", "grok:shared-id")]))); stop = initializeCredentialStatus(); await settle();
  expect(badge().textContent).toBe("已连接"); expect(element("#detail", HTMLElement).dataset.mgmtState).toBe("active"); expect(button().disabled).toBe(true); expect(element("[data-credential-read-current]", HTMLElement).hidden).toBe(false);
});
it("coalesces notifications during a read and reconciles with a subsequent GET", async () => {
  let resolve!: (response: Response) => void; fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  stop = initializeCredentialStatus(); connection().message("connected"); connection().message("credentials-changed"); connection().message("credentials-changed"); expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); resolve(Response.json(model())); await settle(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(badge().textContent).toBe("需要重新连接");
});
it("discards a read taken before a new task and reads its current projections", async () => {
  let resolve!: (response: Response) => void; fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; })); stop = initializeCredentialStatus();
  const previous = element("main", HTMLElement); const next = previous.cloneNode(true) as HTMLElement;
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); previous.replaceWith(next); await settle(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(badge().textContent).toBe("需要重新连接");
  resolve(Response.json(model())); await settle(); expect(badge().textContent).toBe("需要重新连接");
});
it("waits for a pending write, then reads without applying a stale pre-write result", async () => {
  let resolve!: (response: Response) => void; fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; })); stop = initializeCredentialStatus();
  const main = element("main", HTMLElement); main.dataset.mutationPending = "true"; await settle(); resolve(Response.json(model([status("reauth_required")]))); await settle(); expect(badge().textContent).toBe("已连接");
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); delete main.dataset.mutationPending; await settle(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(badge().textContent).toBe("需要重新连接");
});
it.each([401, 403])("routes rejected metadata authority (%s) through privacy recovery", async responseStatus => {
  fetchMock.mockResolvedValueOnce(Response.json({error: {code: "admin_auth_required"}}, {status: responseStatus})); stop = initializeCredentialStatus();
  const dispose = vi.fn(); const recovery = initializeRecovery(dispose); const clientStop = stop; stop = () => { clientStop(); recovery(); }; await settle();
  expect(dispose).toHaveBeenCalledOnce(); expect(document.querySelector(".shell,input")).toBeNull(); expect(document.querySelector("[data-console-recovery]")).not.toBeNull(); expect(connection().close).toHaveBeenCalled();
});
it("rejects another actor's metadata and never displays its account state", async () => {
  const changed = vi.fn(); document.addEventListener("console:actor-changed", changed, {once: true}); fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")], "actor-B"))); stop = initializeCredentialStatus(); await settle();
  expect(changed).toHaveBeenCalledOnce(); expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({outcome: "read", changed: true, reason: "authority"}); expect(badge().textContent).toBe("已连接"); expect(connection().close).toHaveBeenCalled();
});
it("treats websocket authorization close as authority loss", async () => {
  const changed = vi.fn(); document.addEventListener("console:actor-changed", changed, {once: true}); stop = initializeCredentialStatus(); await settle(); connection().message("connected"); await settle(); connection().disconnect(4403); await settle();
  expect(changed).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(120000); expect(StatusSocket.connections).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(["console:actor-changed", "console:document-ended", "pagehide"])("disposes transport and ignores late results on %s", async event => {
  let resolve!: (response: Response) => void; fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; })); stop = initializeCredentialStatus();
  (event === "pagehide" ? window : document).dispatchEvent(new Event(event)); resolve(Response.json(model([status("reauth_required")]))); await settle(); await vi.advanceTimersByTimeAsync(120000);
  expect(badge().textContent).toBe("已连接"); expect(fetchMock).toHaveBeenCalledOnce(); expect(connection().close).toHaveBeenCalled();
});
it("resumes only after visible foreground authority is accepted", async () => {
  let visibility: DocumentVisibilityState = "visible"; vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility); stop = initializeCredentialStatus(); await settle(); const old = connection();
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); await settle(); old.message("credentials-changed"); await vi.advanceTimersByTimeAsync(120000); expect(fetchMock).toHaveBeenCalledOnce(); expect(old.close).toHaveBeenCalled();
  visibility = "visible"; document.documentElement.setAttribute("data-console-authority-pending", ""); document.dispatchEvent(new Event("visibilitychange")); await settle(); expect(StatusSocket.connections).toHaveLength(1);
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); document.documentElement.removeAttribute("data-console-authority-pending"); await settle(); expect(StatusSocket.connections).toHaveLength(2); expect(badge().textContent).toBe("需要重新连接");
});
it("reconnects with bounded backoff and reads on each accepted connection", async () => {
  stop = initializeCredentialStatus(); await settle(); connection().message("connected"); await settle(); connection().disconnect(); await vi.advanceTimersByTimeAsync(999); expect(StatusSocket.connections).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(StatusSocket.connections).toHaveLength(2); connection().disconnect(); await vi.advanceTimersByTimeAsync(1999); expect(StatusSocket.connections).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(StatusSocket.connections).toHaveLength(3); connection().message("connected"); await settle(); expect(fetchMock).toHaveBeenCalledTimes(3); connection().disconnect(); await vi.advanceTimersByTimeAsync(1000); expect(StatusSocket.connections).toHaveLength(4);
});
it("polls metadata at two minutes when websocket is unavailable", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("synthetic transport unavailable"); } }); stop = initializeCredentialStatus(); await settle(); fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")])));
  await vi.advanceTimersByTimeAsync(119999); expect(fetchMock).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2); expect(badge().textContent).toBe("需要重新连接");
});
it("retains last known facts on unavailable reads and recovers on later notification", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({error: {code: "unavailable"}}, {status: 503})); stop = initializeCredentialStatus(); await settle(); expect(badge().textContent).toBe("已连接"); expect(button().disabled).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")]))); connection().message("connected"); await settle(); expect(badge().textContent).toBe("需要重新连接");
});
it.each([{...model(), actorId: undefined}, {...model(), revision: 12}, model([{...status(), tone: "injected"}]), model([{...status(), state: "unknown"}]), model([status(), status()]), model(Array.from({length: 1001}, (_, index) => status("active", `codex:${index}`)))])("ignores incomplete/unbounded metadata without inventing empty inventory", async value => {
  fetchMock.mockResolvedValueOnce(Response.json(value)); stop = initializeCredentialStatus(); await settle(); expect(badge().textContent).toBe("已连接"); expect(button().disabled).toBe(false);
});
it("renders safe metadata as text, not markup", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(model([{...status("reauth_required"), statusLabel: "<img src=x>", hint: "<script>display-only</script>"}]))); stop = initializeCredentialStatus(); await settle(); expect(badge().textContent).toBe("<img src=x>"); expect(document.querySelector("img,script")).toBeNull();
});
it.each(["user", "missing"])("does not connect or read account metadata for %s authority", async role => {
  const identity = element("[data-console-role]", HTMLElement); if (role === "missing") identity.removeAttribute("data-console-actor-id"); else identity.dataset.consoleRole = role; stop = initializeCredentialStatus(); await settle(); expect(fetchMock).not.toHaveBeenCalled(); expect(StatusSocket.connections).toHaveLength(0);
});

it.each(["access", "personal Usage"])("does not subscribe or read organization credentials from %s without mounted projections", async view => {
  element("main", HTMLElement).innerHTML = `<h1>${view}</h1><input value="unfinished">`;
  stop = initializeCredentialStatus(); await settle(); await vi.advanceTimersByTimeAsync(120000);
  expect(fetchMock).not.toHaveBeenCalled(); expect(StatusSocket.connections).toHaveLength(0);
});

it("starts on entering a credential task without subscribing from the previous account-free page", async () => {
  const main = element("main", HTMLElement); main.innerHTML = '<h1>Access</h1>';
  stop = initializeCredentialStatus(); await settle(); expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(Response.json(model([status("reauth_required")])));
  main.innerHTML = detail; await settle();
  expect(StatusSocket.connections).toHaveLength(1); expect(fetchMock).toHaveBeenCalledOnce(); expect(badge().textContent).toBe("需要重新连接");
});

it("defers metadata and channel authority recovery while an explicit navigation is pending", async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  const changed = vi.fn(); document.addEventListener("console:actor-changed", changed, {once: true});
  stop = initializeCredentialStatus(); const old = connection();
  const main = element("main", HTMLElement); main.setAttribute("aria-busy", "true");
  old.disconnect(4403); await settle();
  resolve(Response.json({error: {code: "admin_auth_required"}}, {status: 403})); await settle();
  expect(changed).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledOnce(); expect(badge().textContent).toBe("已连接");
  main.removeAttribute("aria-busy"); await settle();
  expect(StatusSocket.connections).toHaveLength(2); expect(fetchMock).toHaveBeenCalledTimes(2);
  document.removeEventListener("console:actor-changed", changed);
});

it("closes a departed credential scope and ignores its late authority result and notifications", async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  const changed = vi.fn(); document.addEventListener("console:actor-changed", changed, {once: true});
  stop = initializeCredentialStatus(); const old = connection();
  element("main", HTMLElement).innerHTML = '<h1 id="access">Access</h1><input value="retained">'; await settle();
  expect(old.close).toHaveBeenCalled();
  old.message("credentials-changed"); old.disconnect(4403);
  resolve(Response.json({error: {code: "admin_auth_required"}}, {status: 403})); await settle(); await vi.advanceTimersByTimeAsync(120000);
  expect(changed).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledOnce(); expect(element("#access", HTMLElement).textContent).toBe("Access");
  document.removeEventListener("console:actor-changed", changed);
});

it("updates stored expiry and refresh dates with the state, retaining email, rows and pending OAuth facts", async () => {
  const root = element("#detail", HTMLElement);
  root.insertAdjacentHTML("beforeend", '<dl data-credential-dates><div id="credential-email"><dt>邮箱</dt><dd>fixture@example.test</dd></div><div data-credential-expiry><dt>已过期</dt><dd>old expiry</dd></div><div data-credential-last-refresh><dt>上次刷新</dt><dd>old refresh</dd></div></dl>');
  const expiry = element("[data-credential-expiry]", HTMLElement); const refreshed = element("[data-credential-last-refresh]", HTMLElement); const email = element("#credential-email", HTMLElement);
  const past = "2026-06-23T12:00:00.000Z"; const future = "2026-07-24T12:00:00.000Z"; const last = "2026-06-24T12:00:00.000Z";
  fetchMock.mockResolvedValueOnce(Response.json(model([{...status("expired"), expiresAt: past, lastRefreshAt: past}])));
  stop = initializeCredentialStatus(); await settle();
  expect(expiry.querySelector("dt")?.textContent).toBe("已过期"); expect(expiry.querySelector("dd")?.textContent).toBe(formatOperatorInstant(past));
  fetchMock.mockResolvedValueOnce(Response.json(model([{...status(), expiresAt: future, lastRefreshAt: last}])));
  connection().message("credentials-changed"); await settle();
  expect(expiry.querySelector("dt")?.textContent).toBe("到期时间"); expect(expiry.querySelector("dd")?.textContent).toBe(formatOperatorInstant(future)); expect(refreshed.querySelector("dd")?.textContent).toBe(formatOperatorInstant(last));
  expect(element("[data-credential-expiry]", HTMLElement)).toBe(expiry); expect(element("#credential-email", HTMLElement)).toBe(email);
  connection().message("credentials-changed"); await settle();
  expect(expiry.hidden).toBe(true); expect(refreshed.hidden).toBe(true); expect(element("[data-credential-dates]", HTMLElement).hidden).toBe(false);
  email.remove(); connection().message("credentials-changed"); await settle(); expect(element("[data-credential-dates]", HTMLElement).hidden).toBe(true);
  fetchMock.mockResolvedValueOnce(Response.json(model([{...status(), expiresAt: "legacy date unavailable"}])));
  connection().message("credentials-changed"); await settle(); expect(expiry.querySelector("dd")?.textContent).toBe("legacy date unavailable"); expect(expiry.hidden).toBe(false);
  root.dataset.oauthPending = "true"; root.dataset.mgmtState = "authorizing";
  fetchMock.mockResolvedValueOnce(Response.json(model([{...status(), expiresAt: future, lastRefreshAt: last}])));
  connection().message("credentials-changed"); await settle();
  expect(expiry.querySelector("dd")?.textContent).toBe("legacy date unavailable"); expect(root.dataset.mgmtState).toBe("authorizing");
});
