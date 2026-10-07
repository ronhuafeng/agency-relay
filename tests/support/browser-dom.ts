import { vi } from "vitest";
export function element<T extends Element>(selector: string, kind: {new(...args: never[]): T}, root: ParentNode = document): T {
  const value = root.querySelector(selector);
  if (!(value instanceof kind)) throw new Error(`Missing ${selector}`);
  return value;
}
export function browserLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {configurable: true, value: vi.fn()});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function(this: HTMLElement): DOMRectList {
    const rect = new DOMRect(0, 0, 200, 44); const visible = !this.hidden;
    return {length: visible ? 1 : 0, item: (index) => visible && index === 0 ? rect : null, [Symbol.iterator]: () => (visible ? [rect] : [])[Symbol.iterator]()};
  });
}
export function dashboardHtml(view = "access", body = ""): string {
  return `<!doctype html><html><head><title>${view}</title></head><body><header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="viewer@example.test" data-console-role="admin"></div></header><div class="shell" data-dashboard-nav="vertical"><nav><a data-dashboard-link href="/admin?view=access">人员</a><a id="account-link" data-dashboard-link href="/admin?view=credentials">账号</a><a id="usage-link" data-dashboard-link href="/admin?view=usage">用量</a></nav><main id="content" data-dashboard-url="/admin?view=${view}" data-dashboard-view="${view}"><h1>${view}</h1><div data-dashboard-notice hidden><span data-notice-message></span><a hidden></a><button type="button" data-stop-waiting hidden>停止等待</button></div>${body}</main></div></body></html>`;
}
export function submit(form: HTMLFormElement): SubmitEvent {
  const event = new SubmitEvent("submit", {bubbles: true, cancelable: true, submitter: form.querySelector("button[type=submit]")});
  form.dispatchEvent(event); return event;
}
