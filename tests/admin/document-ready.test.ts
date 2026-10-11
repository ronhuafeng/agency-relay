// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { afterDocumentParsed } from "../../src/admin/client/document-ready";

describe("document-owned enhancement readiness", () => {
  it("does not initialize an incomplete document and starts once after parsing", () => {
    const doc = document.implementation.createHTMLDocument();
    Object.defineProperty(doc, "readyState", {value: "loading"});
    const run = vi.fn(() => doc.querySelector("main")?.textContent);
    afterDocumentParsed(run, doc);
    expect(run).not.toHaveBeenCalled();
    doc.body.innerHTML = "<main>Server-authored task</main>";
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(run).toHaveReturnedWith("Server-authored task");
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["interactive", "complete"])("starts immediately when the bundle arrives after parsing (%s)", state => {
    const doc = document.implementation.createHTMLDocument();
    Object.defineProperty(doc, "readyState", {value: state});
    const run = vi.fn();
    afterDocumentParsed(run, doc);
    expect(run).toHaveBeenCalledTimes(1);
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
