/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { MemberKeyForm, CreditPolicyForm, AddAccountView } from "../../src/admin/ui/forms";
import { Button } from "../../src/admin/ui/components/button";
import { DashLink } from "../../src/admin/ui/chrome";
import { initializeVisibleRowFilters } from "../../src/admin/client/filters";
import { readMemberKeyForm, readCapabilityComparison, readUsageReport, type UsageReportControl } from "../../src/admin/ui/models";
import { UsageReport } from "../../src/admin/ui/usage-report";
import { element } from "../support/browser-dom";
vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {configurable: true, value: true});
let root: Root | null = null;
afterEach(async () => {await act(() => {root?.unmount();}); root = null; vi.restoreAllMocks();});
const model = {surfaces: [{name: "surfaces", value: "codex", label: "Codex", disabled: false, checked: false}], expiry: {id: "expiry", name: "expires_at", label: "有效期", required: false, value: "", options: [{value: "", label: "90 天", disabled: false}]}, lead: null, canCreate: true};
const usage: UsageReportControl = {
  records: [{id: "responses-0", authority: "chatgpt", service: "Codex", plan: "codex.responses", owner: "member@example.com", title: "gpt-preview", metrics: [{label: "请求", value: "12"}, {label: "已记录令牌", value: "24,500"}], details: [{label: "人员标识", value: "member_preview"}, {label: "令牌记录覆盖", value: "100.0% · 12 / 12 次请求"}], note: null}],
  emptyLabel: "今天还没有用量记录。", exportUrl: "/admin/usage?limit=1000", truncated: false, filterPlaceholder: "搜索人员或模型", limitNote: "请求和媒体记录各显示最多 250 条。"
};
describe("typed console controls", () => {
  it("preserves native link behavior and focus through a composed button", async () => {
    document.body.innerHTML = '<div id="root"></div>'; root = createRoot(element("#root", HTMLElement));
    const activate = vi.fn((event: {preventDefault(): void}) => event.preventDefault()); const ref = {current: null};
    await act(() => {root?.render(createElement(Button, {asChild: true}, createElement(DashLink, {href: "/admin?view=access", ref, onClick: activate, "aria-label": "打开人员"}, "人员")));});
    const link = element("a", HTMLAnchorElement);
    expect(ref.current).toBe(link); expect(link.getAttribute("href")).toBe("/admin?view=access");
    expect(link.getAttribute("data-slot")).toBe("button"); expect(link.getAttribute("aria-label")).toBe("打开人员");
    link.focus(); expect(document.activeElement).toBe(link); await act(() => link.click()); expect(activate).toHaveBeenCalledOnce();
  });
  it("keeps functional native form values before enhancement", () => {
    document.body.innerHTML = renderToString(createElement(MemberKeyForm, {model})); const checkbox = element('input[type=checkbox]', HTMLInputElement); checkbox.checked = true;
    const data = new FormData(element("form", HTMLFormElement)); expect(data.getAll("surfaces")).toEqual(["codex"]); expect(data.get("expires_at")).toBe(""); expect(element("select", HTMLSelectElement).getAttribute("aria-hidden")).toBe(null);
  });
  it("identifies both provider choices before script enhancement", () => {
    document.body.innerHTML = renderToString(createElement(AddAccountView, {control: {range: "7d", query: "", page: "1"}}));
    const chatgpt = element('form[aria-label="添加 ChatGPT 账号"]', HTMLFormElement);
    const grok = element('form[aria-label="添加 Grok 账号"]', HTMLFormElement);
    expect(chatgpt.querySelector('h3')?.textContent).toBe("ChatGPT");
    expect(grok.querySelector('h3')?.textContent).toBe("Grok");
    expect(chatgpt.getAttribute('action')).toBe("/admin/ui/codex-auths");
    expect(grok.getAttribute('action')).toBe("/admin/ui/subscriptions");
  });
  it("enhances the checkbox with an accessible Radix control and submits one value", async () => {
    document.body.innerHTML = '<div id="root"></div>'; root = createRoot(element("#root", HTMLElement)); await act(() => {root?.render(createElement(MemberKeyForm, {model}));});
    const checkbox = element('[role=checkbox]', HTMLButtonElement); expect(checkbox.getAttribute("aria-label")).toBe("Codex"); await act(() => checkbox.click());
    expect(new FormData(element("form", HTMLFormElement)).getAll("surfaces")).toEqual(["codex"]);
  });
  it("restores the displayed checkbox and its submitted value together", async () => {
    document.body.innerHTML = '<div id="root"></div>'; root = createRoot(element("#root", HTMLElement)); await act(() => {root?.render(createElement(MemberKeyForm, {model}));});
    const form = element("form", HTMLFormElement);
    element('input[name=surfaces]', HTMLInputElement).checked = true;
    await act(() => form.dispatchEvent(new Event("console:restore")));
    expect(element('[role=checkbox]', HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(new FormData(form).getAll("surfaces")).toEqual(["codex"]);
  });
  it("restores a credit mode with its allowance visibility and form semantics", async () => {
    document.body.innerHTML = '<div id="root"></div>'; root = createRoot(element("#root", HTMLElement));
    await act(() => {root?.render(createElement(CreditPolicyForm, {control: {id: "credit-preview", action: "/admin/ui/credits/test/codex", mode: "limited", monthlyAllowance: "25", clientLabel: "Codex", personId: "preview", personLabel: "preview@example.test"}}));});
    const form = element("form:has(select[name=mode])", HTMLFormElement); const mode = element('select[name=mode]', HTMLSelectElement); const amount = element('input[name=monthly_allowance]', HTMLInputElement);
    mode.value = "unlimited"; await act(() => form.dispatchEvent(new Event("console:restore")));
    expect(amount.disabled).toBe(true); expect(new FormData(form).get("monthly_allowance")).toBe(null);
    mode.value = "limited"; await act(() => form.dispatchEvent(new Event("console:restore")));
    expect(amount.disabled).toBe(false); expect(new FormData(form).get("monthly_allowance")).toBe("25");
  });
  it("rejects malformed island input at its boundary", () => {
    expect(readMemberKeyForm({...model, canCreate: "true"})).toBe(null); expect(readCapabilityComparison({view: {surfaces: [{}], groups: []}, routesHref: "?view=surfaces"})).toBe(null);
  });
  it("shows usage numbers directly and does not open a detail popover", () => {
    document.body.innerHTML = renderToString(createElement(UsageReport, {control: usage}));
    expect(element(".usage-record-measurement", HTMLElement).textContent).toContain("24,500");
    expect(document.querySelector(".usage-record [popover],.usage-record button[popovertarget]")).toBeNull();
    expect(document.body.textContent).not.toContain("member_preview");
  });
  it("keeps primary numbers after enhancement without a detail popover", async () => {
    document.body.innerHTML = '<div id="root"></div>'; root = createRoot(element("#root", HTMLElement));
    await act(() => {root?.render(createElement(UsageReport, {control: usage}));});
    expect(document.querySelector(".usage-record button,[popover],.usage-facts")).toBeNull();
    expect(element(".usage-record-measurement", HTMLElement).textContent).toContain("24,500");
  });
  it("keeps an empty usage view free of unrelated controls and billing explanations", () => {
    document.body.innerHTML = renderToString(createElement(UsageReport, {control: {...usage, records: []}}));
    expect(element(".empty", HTMLElement).textContent).toBe(usage.emptyLabel);
    expect(document.querySelector("a[download],input,details")).toBe(null);
  });
  it("rejects malformed usage values and an export URL outside its read boundary", () => {
    expect(readUsageReport({...usage, exportUrl: "https://other.test/admin/usage?"})).toBe(null);
    expect(readUsageReport({...usage, records: [{...usage.records[0], metrics: [{label: "请求", value: 12}]}]})).toBe(null);
    expect(readUsageReport(usage)).toEqual(usage);
    expect(readUsageReport({...usage, exportUrl: "/me/usage"})?.exportUrl).toBe("/me/usage");
    expect(readUsageReport({...usage, exportUrl: "/me/usage?user_id=someone"})).toBe(null);
  });
  it.each(["table", "list"])("filters only the rendered %s and exposes its empty state", (kind) => {
    const rows = kind === "table" ? '<div data-visible-row-filter-table><table><tbody><tr><td>Codex</td></tr><tr><td>Grok</td></tr></tbody></table></div>' : '<ul data-filter-list><li>Codex</li><li>Grok</li></ul>';
    document.body.innerHTML = `<div data-visible-row-filter="true"><input data-visible-row-filter-input><span data-visible-row-filter-count></span>${rows}<p data-visible-row-filter-empty hidden>没有匹配的行</p></div>`;
    initializeVisibleRowFilters(document); const input = element("input", HTMLInputElement); input.value = "GROK"; input.dispatchEvent(new Event("input"));
    expect(element("[data-visible-row-filter-count]", HTMLElement).textContent).toBe("显示 1 / 2 条");
    input.value = "missing"; input.dispatchEvent(new Event("input")); expect(element("[data-visible-row-filter-empty]", HTMLElement).hidden).toBe(false);
    initializeVisibleRowFilters(document); expect(element("[data-visible-row-filter-count]", HTMLElement).textContent).toBe("显示 0 / 2 条");
  });
});
