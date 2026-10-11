/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeBackgroundRefresh } from "../../src/admin/client/background-refresh";
import { browserLayout, dashboardHtml, element } from "../support/browser-dom";

let dispose: (() => void) | undefined;
const readUrl = "/admin?view=access";
const revision = "retained-model";
function page(nextRevision = revision, actor = "actor-A"): string {
  return dashboardHtml("access", '<form><input name="label" value="Original"></form>')
    .replace('data-dashboard-view="access"', `data-dashboard-view="access" data-console-read-url="${readUrl}" data-console-revision="${nextRevision}"`)
    .replace('actor-A', actor);
}
function unchanged(actor = "actor-A", value = revision): Response {
  return new Response(null, {status: 204, headers: {"X-Console-Actor-Id": actor, "X-Console-Revision": value}});
}
function start(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetch);
  const apply = vi.fn((doc: Document) => element("main", HTMLElement).replaceWith(element("main", HTMLElement, doc)));
  dispose = initializeBackgroundRefresh(apply);
  return apply;
}
async function read(): Promise<void> { await vi.advanceTimersByTimeAsync(120000); }
beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.removeAttribute("data-console-authority-pending");
  history.replaceState(null, "", readUrl);
  document.documentElement.innerHTML = new DOMParser().parseFromString(page(), "text/html").documentElement.innerHTML;
  document.body.insertAdjacentHTML("afterbegin", '<div data-console-status hidden></div>');
  Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"});
  Object.defineProperty(navigator, "onLine", {configurable: true, value: true});
  browserLayout();
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the exact live DOM on an authorized unchanged read without parsing HTML", async () => {
  const fetch = vi.fn().mockResolvedValue(unchanged()); const apply = start(fetch);
  const root = element("main", HTMLElement); const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
  await read();
  expect(fetch).toHaveBeenCalledWith(new URL(readUrl, location.href).href, expect.objectContaining({headers: {Accept: "text/html", "X-Console-Revision": revision}, cache: "no-store", credentials: "same-origin", redirect: "error"}));
  expect(element("main", HTMLElement)).toBe(root); expect(apply).not.toHaveBeenCalled(); expect(parser).not.toHaveBeenCalled();
  expect(element("[data-console-status]", HTMLElement).hidden).toBe(true);
});
it("applies changed data only while idle and preserves an edited form otherwise", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(page("changed-model"), {headers: {"Content-Type": "text/html"}})));
  const apply = start(fetch); const field = element("input", HTMLInputElement); field.value = "Unfinished";
  field.dispatchEvent(new Event("input", {bubbles: true})); await read();
  expect(field.value).toBe("Unfinished"); expect(apply).not.toHaveBeenCalled(); expect(element("[data-console-status]", HTMLElement).textContent).toBe("有新数据");
  element("form", HTMLFormElement).reset(); await read();
  expect(element("main", HTMLElement).dataset.consoleRevision).toBe("changed-model"); expect(apply).toHaveBeenCalledOnce();
});
it.each(["actor-B", ""])("rejects an unchanged acknowledgement for an unverified actor %s", async actor => {
  const changed = vi.fn(); document.addEventListener("console:actor-changed", changed, {once: true});
  const apply = start(vi.fn().mockResolvedValue(unchanged(actor))); await read();
  expect(changed).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
});
it("treats a mismatched empty revision as unavailable without replacing verified content", async () => {
  const root = element("main", HTMLElement); start(vi.fn().mockResolvedValue(unchanged("actor-A", "other-model"))); await read();
  expect(element("main", HTMLElement)).toBe(root); expect(element("[data-console-status]", HTMLElement).dataset.state).toBe("error");
});
it.each(["hidden", "offline", "authority", "navigation", "mutation", "dispose"])("does not apply a delayed read after %s loses its ownership", async reason => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>(done => { resolve = done; })); const apply = start(fetch);
  await read(); expect(fetch).toHaveBeenCalledOnce();
  if (reason === "hidden") { Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"}); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"}); }
  if (reason === "offline") { Object.defineProperty(navigator, "onLine", {configurable: true, value: false}); window.dispatchEvent(new Event("offline")); Object.defineProperty(navigator, "onLine", {configurable: true, value: true}); }
  if (reason === "authority") document.documentElement.setAttribute("data-console-authority-pending", "");
  if (reason === "navigation") element("main", HTMLElement).replaceWith(element("main", HTMLElement).cloneNode(true));
  if (reason === "mutation") element("main", HTMLElement).dataset.mutationPending = "true";
  if (reason === "dispose") dispose?.();
  resolve(new Response(page("late-model"), {headers: {"Content-Type": "text/html"}})); await vi.advanceTimersByTimeAsync(0);
  expect(apply).not.toHaveBeenCalled(); expect(element("main", HTMLElement).dataset.consoleRevision).toBe(revision);
});
it.each(["hidden", "offline", "pending"])("does not start background network work while %s", async reason => {
  if (reason === "hidden") Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
  if (reason === "offline") Object.defineProperty(navigator, "onLine", {configurable: true, value: false});
  if (reason === "pending") document.documentElement.setAttribute("data-console-authority-pending", "");
  const fetch = vi.fn(); start(fetch); await read(); expect(fetch).not.toHaveBeenCalled();
});
it("retains last verified content and reports a timed-out read without replaying a write", async () => {
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true})));
  const root = element("main", HTMLElement); const apply = start(fetch); await read(); await vi.advanceTimersByTimeAsync(20000);
  expect(element("main", HTMLElement)).toBe(root); expect(apply).not.toHaveBeenCalled();
  expect(element("[data-console-status]", HTMLElement).textContent).toBe("更新暂不可用"); expect(fetch).toHaveBeenCalledOnce();
});
