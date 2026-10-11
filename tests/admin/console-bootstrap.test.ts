import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { consoleClientPath } from "../../src/admin/app";
import { consoleBootstrapSource } from "../../src/admin/generated/console-bootstrap";

describe("CSS-first progressive runtime bootstrap", () => {
  it("adds only the generated async module and propagates the document nonce", () => {
    const dom = new JSDOM(`<html><head></head><body><main>Native task</main><script nonce="synthetic-nonce">${consoleBootstrapSource}</script></body></html>`, {
      url: "https://admin.example.test/admin", runScripts: "dangerously"
    });
    const runtime = dom.window.document.head.querySelector("script")!;
    expect(runtime.type).toBe("module");
    expect(runtime.async).toBe(true);
    expect(runtime.getAttribute("src")).toBe(consoleClientPath());
    expect(runtime.nonce).toBe("synthetic-nonce");
    expect(dom.window.document.head.querySelectorAll("script")).toHaveLength(1);
    expect(dom.window.document.querySelector("main")?.textContent).toBe("Native task");
    dom.window.close();
  });
});
