import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../../scripts/console-preview/workbench.html", import.meta.url), "utf8");
let dom: JSDOM | undefined;
afterEach(() => {dom?.window.close(); dom = undefined;});

async function workbench() {
  dom = new JSDOM(html, {url:"http://localhost/__preview?role=admin&scene=populated&page=quotas&width=768&theme=light", runScripts:"outside-only"});
  const window = dom.window;
  const requests: {input: Record<string, unknown>; finish: (ok?: boolean) => void}[] = [];
  window.setInterval = (() => 1) as typeof window.setInterval;
  window.fetch = vi.fn((url: string, options?: RequestInit) => {
    if (url === "/__preview/data") return Promise.resolve({json: async () => ({snapshot:false})});
    return new Promise(resolve => requests.push({input:JSON.parse(String(options?.body)), finish:(ok = true) => resolve({ok})}));
  }) as unknown as typeof window.fetch;
  window.eval(window.document.querySelector("script")!.textContent!);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  requests[0]!.finish();
  const frame = window.document.querySelector<HTMLIFrameElement>("#preview")!;
  await vi.waitFor(() => expect(frame.src).toContain("view=quotas"));
  frame.dispatchEvent(new window.Event("load"));
  const select = (id: string, value: string) => {
    const element = window.document.querySelector<HTMLSelectElement>(`#${id}`)!;
    element.value = value; element.dispatchEvent(new window.Event("change"));
  };
  return {window, requests, frame, select};
}

it("keeps the latest page while a previous configuration or frame is still loading", async () => {
  const {window, requests, frame, select} = await workbench();
  select("page", "surfaces");
  select("theme", "dark");
  frame.dispatchEvent(new window.Event("load"));
  expect(window.document.querySelector<HTMLSelectElement>("#page")!.value).toBe("surfaces");
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]!.input.theme).toBe("light");
  requests[1]!.finish();
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]!.input.theme).toBe("dark");
  // The superseded result cannot navigate the iframe or change the selected page.
  expect(frame.src).toContain("view=quotas");
  requests[2]!.finish();
  await vi.waitFor(() => expect(frame.src).toContain("view=surfaces"));
  frame.dispatchEvent(new window.Event("load"));
  expect(window.document.querySelector<HTMLSelectElement>("#page")!.value).toBe("surfaces");
  expect(window.location.search).toContain("page=surfaces");
  expect(window.location.search).toContain("theme=dark");
});

it("retains a failed configuration choice and lets the next load recover", async () => {
  const {window, requests, frame, select} = await workbench();
  select("page", "control-audit");
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  requests[1]!.finish(false);
  await vi.waitFor(() => expect(window.document.getElementById("status")!.textContent).toContain("加载失败"));
  expect(frame.src).toContain("view=quotas");
  expect(window.document.querySelector<HTMLSelectElement>("#page")!.value).toBe("control-audit");
  (window.document.getElementById("reload") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  requests[2]!.finish();
  await vi.waitFor(() => expect(frame.src).toContain("view=control-audit"));
});
