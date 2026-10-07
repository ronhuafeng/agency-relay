/** PWA resources for the console-session-protected dashboard host. No operator data. */
import { APP_ICON_PNG } from "./app-icons";
import { consoleClientSource } from "./generated/console-client";
import { consoleStyles, consoleTheme } from "./generated/console-styles";

export const DASHBOARD_APP_PATHS = [
  "/admin/app.webmanifest", "/admin/app-worker.js",
  "/admin/app-icon-192.png", "/admin/app-icon-512.png"
] as const;

export function isDashboardAppPath(path: string): boolean {
  return DASHBOARD_APP_PATHS.some((candidate) => candidate === path);
}

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
<title>无法连接 · Agency Relay</title>
<style>${consoleStyles}</style>
</head><body class="offline-page"><main><span class="brand-mark">A</span><h1>无法连接 Agency Relay</h1>
<p>Agency Relay 没有连上服务器。请检查网络，然后再试一次。</p>
<p>这个画面不能显示当前账号和访问状态。没有排队任何操作。</p>
<p class="actions"><a class="retry" href="">重试这个页面</a><a href="/">打开首页</a></p>
</main></body></html>`;

/** Network-only GET navigation. No cache, mutation interception, or update reload. */
export function dashboardAppWorkerSource(): string {
  return `self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=="GET"||request.mode!=="navigate"||url.origin!==self.location.origin||!["/","/admin","/admin/"].includes(url.pathname))return;
  event.respondWith(fetch(request).catch(()=>new Response(${JSON.stringify(OFFLINE_HTML)},{status:503,headers:{
    "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",
    "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options":"nosniff"
  }})));
});`;
}

/** Caller must enforce dashboard hostname and console session before serving. */
export function consoleClientResponse(): Response {
  return new Response(consoleClientSource, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

export function dashboardAppResponse(path: string): Response | null {
  if (!isDashboardAppPath(path)) return null;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow"
  });
  if (path === "/admin/app.webmanifest") {
    headers.set("Content-Type", "application/manifest+json");
    return new Response(JSON.stringify({
      id: "/", name: "Agency Relay", short_name: "Relay", lang: "zh-CN",
      description: "管理我的密钥、用量与客户端配置。",
      start_url: "/", scope: "/", display: "standalone",
      background_color: consoleTheme.light.background, theme_color: consoleTheme.light.card,
      icons: [192, 512].map((size) => ({
        src: `/admin/app-icon-${size}.png`, sizes: `${size}x${size}`,
        type: "image/png", purpose: "any maskable"
      }))
    }), { headers });
  }
  if (path === "/admin/app-worker.js") {
    headers.set("Content-Type", "text/javascript; charset=utf-8");
    headers.set("Service-Worker-Allowed", "/");
    return new Response(dashboardAppWorkerSource(), { headers });
  }
  headers.set("Content-Type", "image/png");
  const encoded = path === "/admin/app-icon-192.png" ? APP_ICON_PNG[192] : APP_ICON_PNG[512];
  return new Response(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)), { headers });
}
