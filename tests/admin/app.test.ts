import { describe, expect, it, vi } from "vitest";
import { dashboardAppResponse, dashboardAppWorkerSource } from "../../src/admin/app";

function workerFixture(fetcher: (request: unknown) => Promise<Response>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const scope = {
    location: { origin: "https://admin.example.test" },
    clients: { claim: vi.fn(async () => undefined) },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener)
  };
  new Function("self", "fetch", "URL", "Response", dashboardAppWorkerSource())(scope, fetcher, URL, Response);
  return (overrides: Partial<{ method: string; mode: string; url: string }> = {}) => {
    let result: Promise<Response> | undefined;
    const request = {
      method: "GET", mode: "navigate", url: "https://admin.example.test/?view=access",
      ...overrides
    };
    listeners.get("fetch")!({ request, respondWith: (response: Promise<Response>) => { result = response; } });
    return { request, result };
  };
}

describe("dashboard application resources", () => {
  it("provides a stable standalone entry and real maskable PNG icons", async () => {
    const response = dashboardAppResponse("/admin/app.webmanifest")!;
    expect(response.headers.get("Content-Type")).toBe("application/manifest+json");
    const manifest = await response.json() as { icons: { src: string; sizes: string }[] };
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    for (const icon of manifest.icons) {
      const resource = dashboardAppResponse(icon.src)!;
      expect(resource.headers.get("Content-Type")).toBe("image/png");
      const bytes = new Uint8Array(await resource.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const dimensions = new DataView(bytes.buffer);
      expect(`${dimensions.getUint32(16)}x${dimensions.getUint32(20)}`).toBe(icon.sizes);
    }
    expect(dashboardAppResponse("/admin/unknown")).toBeNull();
    const worker = dashboardAppResponse("/admin/app-worker.js")!;
    expect(worker.headers.get("Service-Worker-Allowed")).toBe("/");
    expect(worker.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([200, 302, 401, 403, 500])("preserves the actual network response (%s)", async (status) => {
    const network = new Response("network response", { status });
    const fetcher = vi.fn(async () => network);
    const dispatch = workerFixture(fetcher);
    const { request, result } = dispatch();
    expect(await result).toBe(network);
    expect(fetcher).toHaveBeenCalledWith(request);
  });

  it("uses a generic recovery page only on navigation transport failure", async () => {
    const dispatch = workerFixture(async () => { throw new TypeError("network failure"); });
    const { result } = dispatch({ url: "https://admin.example.test/admin/?view=access&private-value=fixture-private" });
    const response = (await result)!;
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("无法连接 Agency Relay");
    expect(html).toContain("没有排队任何操作");
    expect(html).toContain('href=""');
    expect(html).not.toContain("fixture-private");
  });

  it.each([
    { method: "POST" },
    { method: "POST", url: "https://admin.example.test/admin/ui/users" },
    { url: "https://admin.example.test/admin/usage" },
    { url: "https://admin.example.test/cdn-cgi/access/login" },
    { url: "https://admin.example.test/admin/app-icon-192.png", mode: "no-cors" },
    { mode: "cors" },
    { url: "https://api.trustedtunnel.app/admin" }
  ])("leaves non-dashboard navigation and mutations to the browser: %j", (request) => {
    const fetcher = vi.fn(async () => new Response());
    expect(workerFixture(fetcher)(request).result).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
