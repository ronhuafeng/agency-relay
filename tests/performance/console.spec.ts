import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { authenticate } from "../browser/fixtures";
import { NOW, ORIGIN, startConsoleWorker, type ConsoleWorker } from "../browser/worker";
import { consoleClientSource } from "../../src/admin/generated/console-client";
import { consoleStyles } from "../../src/admin/generated/console-styles";
import { consoleAssetBytes } from "../../scripts/console-asset-metrics";
import { distribution, labCls } from "./metrics";

const repetitions = 5;
const settleMs = 1000;
const profiles = [
  { name: "desktop-loopback", width: 1440, height: 900, cpuRate: 1, latencyMs: 0, downloadBytesSec: -1, uploadBytesSec: -1 },
  { name: "mobile-emulated", width: 390, height: 844, cpuRate: 4, latencyMs: 150, downloadBytesSec: 200_000, uploadBytesSec: 93_750 }
] as const;
const scenes = [
  { name: "login", role: null, path: "/login", usage: false },
  { name: "member-keys", role: "member", path: "/admin?area=me&view=keys", usage: false },
  { name: "member-usage-populated", role: "member", path: "/admin?area=me&view=usage&range=7d", usage: true },
  { name: "member-usage-empty", role: "member", path: "/admin?area=me&view=usage&range=7d", usage: false },
  { name: "admin-people", role: "admin", path: "/admin?view=access", usage: false }
] as const;
interface LabWindow {
  supported: readonly string[];
  lcp: number | null;
  shifts: Array<{ startTime: number; value: number; hadRecentInput: boolean }>;
  tasks: Array<{ startTime: number; duration: number }>;
  events: Array<{ startTime: number; duration: number; inputDelay: number; processingMs: number }>;
}
declare global { interface Window { consoleLab: LabWindow } }
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function instrument(page: Page) {
  // Freeze Date only. Playwright's clock also replaces Performance entry APIs,
  // which would erase the native navigation/LCP evidence being measured here.
  await page.addInitScript(fixedNow => {
    const NativeDate = Date;
    window.Date = new Proxy(NativeDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [fixedNow], newTarget),
      apply: () => new NativeDate(fixedNow).toString(),
      get: (target, key, receiver) => key === "now" ? () => fixedNow : Reflect.get(target, key, receiver)
    });
    const lab: LabWindow = { supported: PerformanceObserver.supportedEntryTypes, lcp: null, shifts: [], tasks: [], events: [] };
    window.consoleLab = lab;
    const observe = (type: string, read: (entry: PerformanceEntry) => void, durationThreshold?: number) => {
      if (lab.supported.includes(type)) new PerformanceObserver(list => list.getEntries().forEach(read))
        .observe({ type, buffered: true, ...(durationThreshold === undefined ? {} : { durationThreshold }) });
    };
    observe("largest-contentful-paint", entry => { lab.lcp = entry.startTime; });
    observe("layout-shift", entry => { const item = entry as PerformanceEntry & {value: number; hadRecentInput: boolean}; lab.shifts.push({ startTime: item.startTime, value: item.value, hadRecentInput: item.hadRecentInput }); });
    observe("longtask", entry => { lab.tasks.push({startTime: entry.startTime, duration: entry.duration}); });
    observe("event", entry => { const item = entry as PerformanceEventTiming; if (item.interactionId) lab.events.push({startTime: item.startTime, duration: item.duration, inputDelay: item.processingStart-item.startTime, processingMs: item.processingEnd-item.processingStart}); }, 16);
  }, Date.parse(NOW));
}

async function cpuMetrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const values = new Map<string, number>(metrics.map((item: {name: string; value: number}) => [item.name, item.value]));
  return Object.fromEntries(["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration"].map(name => [name, values.get(name) ?? null]));
}

// Native profiler events are reduced in memory. No trace arguments, URLs, DOM,
// source text, event targets or request bodies are retained or written to disk.
async function parsingProfile(cdp: CDPSession) {
  const names = ["ParseHTML", "ParseAuthorStyleSheet", "v8.compile", "V8.CompileCode", "V8.CompileScript"];
  const durations = new Map<string, number[]>();
  const listener = ({value}: {value: Array<Record<string, unknown>>}) => {
    for (const event of value) if (typeof event.name === "string" && names.includes(event.name) && event.ph === "X" && typeof event.dur === "number") {
      const values = durations.get(event.name) ?? []; values.push(event.dur / 1000); durations.set(event.name, values);
    }
  };
  cdp.on("Tracing.dataCollected", listener);
  await cdp.send("Tracing.start", { categories: "devtools.timeline,v8,disabled-by-default-v8.compile", transferMode: "ReportEvents" });
  return async () => {
    const complete = new Promise<void>(resolve => cdp.once("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.end"); await complete; cdp.off("Tracing.dataCollected", listener);
    return Object.fromEntries(names.map(name => { const values = durations.get(name); return [name, { events: values?.length ?? 0, inclusiveMs: values ? values.reduce((a,b)=>a+b,0) : null }]; }));
  };
}

async function ready(page: Page, scene: typeof scenes[number]) {
  await page.waitForFunction(() => document.readyState === "complete");
  if (scene.name !== "login") await page.waitForFunction(() => document.querySelector("#console-dialog-root") !== null
    && (document.querySelector("[data-member-nav]") ? document.querySelector('[data-confirmation-fallback]:not([hidden])') === null : typeof history.state?.miniEntry === "string"));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function load(page: Page, cdp: CDPSession, worker: ConsoleWorker, scene: typeof scenes[number], warm: boolean) {
  worker.timings.length = 0;
  const stopProfile = await parsingProfile(cdp);
  const response = warm ? await page.reload({waitUntil: "load"}) : await page.goto(scene.path, {waitUntil: "load"});
  expect(response?.status()).toBe(200);
  await ready(page, scene);
  await page.waitForTimeout(settleMs);
  const observation = await page.evaluate(() => {
    const lab = window.consoleLab;
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const kind = (entry: PerformanceResourceTiming) => entry.initiatorType === "script" ? "script" : entry.initiatorType === "css" || new URL(entry.name).pathname.endsWith(".css") ? "stylesheet" : "other";
    const resourceBytes = ["script", "stylesheet", "other"].map(name => {
      const entries = resources.filter(entry => kind(entry) === name);
      return {kind: name, count: entries.length, transferBytes: entries.reduce((sum,e)=>sum+e.transferSize,0), encodedBodyBytes: entries.reduce((sum,e)=>sum+e.encodedBodySize,0), decodedBodyBytes: entries.reduce((sum,e)=>sum+e.decodedBodySize,0)};
    });
    return {supported: lab.supported, lcpMs: lab.lcp, fcpMs: fcp, shifts: lab.shifts,
      observedUntilMs: performance.now(), loadMs: navigation.loadEventEnd,
      ttfbMs: navigation.responseStart-navigation.startTime, responseDownloadMs: navigation.responseEnd-navigation.responseStart,
      postResponseToInteractiveMs: navigation.domInteractive-navigation.responseEnd,
      htmlTransferBytes: navigation.transferSize, htmlEncodedBodyBytes: navigation.encodedBodySize, htmlDecodedBodyBytes: navigation.decodedBodySize,
      inlineCssUtf8Bytes: [...document.querySelectorAll("style")].reduce((sum,element)=>sum+new TextEncoder().encode(element.textContent ?? "").byteLength,0),
      domElements: document.getElementsByTagName("*").length,
      fcpToObservationBlockingMs: lab.supported.includes("longtask") && fcp !== null ? lab.tasks.reduce((sum,t)=>sum+Math.max(0, t.startTime+t.duration-Math.max(t.startTime+50,fcp)),0) : null,
      longTaskCount: lab.supported.includes("longtask") ? lab.tasks.length : null, resourceBytes};
  });
  const after = await cpuMetrics(cdp);
  const parsing = await stopProfile();
  const { shifts, ...safe } = observation;
  const htmlBytes = consoleAssetBytes(await response!.body());
  return {...safe, labCls: observation.supported.includes("layout-shift") ? labCls(shifts) : null, htmlBytes,
    serverHtmlHandlerMs: worker.timings.filter(t=>t.kind === "html").map(t=>t.handlerMs),
    // Chromium resets these counters at document navigation. Subtracting the
    // previous document would create nonsensical negative warm-load durations.
    cpuMs: Object.fromEntries(Object.entries(after).map(([key,value])=>[key, value === null ? null : value*1000])), parsing,
    tbtMs: null, fieldInpMs: null};
}

async function interaction(page: Page, name: string, selector: string, action: () => Promise<unknown>, eventType = "click") {
  // Epoch-relative native Performance timestamps remain comparable when the
  // current UI action navigates to a new document instead of expanding old markup.
  const started = page.evaluate(eventType => new Promise<number>(resolve => {
    window.consoleLab.events = [];
    const start = (event: Event) => {
      if (eventType === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
      document.removeEventListener(eventType,start,true);
      resolve(performance.timeOrigin + performance.now());
    };
    document.addEventListener(eventType,start,true);
  }), eventType);
  const [start] = await Promise.all([started, action()]);
  await page.waitForFunction(selector => document.querySelector(selector) !== null, selector);
  const finish = await page.evaluate(() => new Promise<number>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())));
  }));
  // Event Timing may be delivered after the next frame; absence is below threshold
  // or unsupported, not zero and never an INP measurement.
  await page.waitForTimeout(100);
  const value = await page.evaluate(()=>{
    const lab=window.consoleLab; return {eventTimingSupported: lab.supported.includes("event"), events: lab.events};
  });
  const completionMs = finish - start;
  expect(Number.isFinite(completionMs) && completionMs >= 0, "Native interaction completion is non-negative").toBe(true);
  return {name, completionMs, ...value};
}

async function actions(page: Page, scene: typeof scenes[number], cdp: CDPSession) {
  if (scene.name === "login") {
    // Stop at Mini's own redirect. No browser request to the IdP is allowed, and
    // the OAuth URL/state never enters scalar evidence or an assertion message.
    await cdp.send("Fetch.enable", { patterns: [{urlPattern: "https://accounts.feishu.cn/*", requestStage: "Request"}] });
    const destinationBlocked = new Promise<void>((resolve, reject) => {
      cdp.once("Fetch.requestPaused", ({requestId}) => {
        void cdp.send("Fetch.failRequest", {requestId,errorReason:"Aborted"}).then(() => resolve(), () => reject(new Error("Could not confirm blocked IdP navigation")));
      });
    });
    const pending = page.waitForResponse(response=>response.request().method()==="POST" && new URL(response.url()).pathname==="/login");
    await page.getByRole("button", {name:"使用飞书继续"}).focus();
    await page.keyboard.press("Enter");
    const response=await pending; expect(response.status()).toBe(302);
    await response.finished(); await destinationBlocked;
    const timing=response.request().timing();
    return [{name:"login-submit-to-local-redirect", requestToResponseHeadersMs: timing.responseStart, requestToResponseEndMs: timing.responseEnd,
      completionMs:null, reason:"IdP exchange and return excluded; native local POST timing only"}];
  }
  if (scene.name === "member-keys") return [await interaction(page,"open-key-management", '[data-key-id="member-key"] input[name="name"]', ()=>page.locator('[data-key-id="member-key"]').getByRole("link",{name:"管理密钥",exact:false}).click())];
  if (scene.name.startsWith("member-usage")) return [await interaction(page,"switch-usage-to-30-days", '[data-usage-range-label="2026-05-26 至 2026-06-24 UTC"]', ()=>page.getByRole("navigation",{name:"UTC 时间范围"}).getByRole("link",{name:"30 天",exact:true}).click())];
  const search=page.getByRole("searchbox",{name:"搜索邮箱、名称或 ID",exact:true});
  await search.fill("person-");
  const filtered=await interaction(page,"filter-people", 'main[data-dashboard-url*="q=person-"]:not([aria-busy])', ()=>search.press("Enter"),"keydown");
  await page.waitForFunction(()=>new URL(location.href).searchParams.get("q")==="person-" && document.querySelector("main[aria-busy]")===null);
  const source=page.locator('[data-user-id="person-12"] a'); await source.scrollIntoViewIfNeeded();
  const detail=await interaction(page,"open-person-detail", '[data-person-detail="person-12"]', ()=>source.click());
  await page.goBack(); await page.waitForFunction(()=>document.querySelector('[data-person-detail="person-12"]')===null && document.querySelector("main[aria-busy]")===null);
  await search.fill("no-synthetic-person-matches");
  const empty=await interaction(page,"filter-people-to-empty", '.people-list > .empty', ()=>search.press("Enter"),"keydown");
  return [filtered,detail,empty];
}

for (const profile of profiles) for (const scene of scenes) test(`${profile.name} ${scene.name}: five cold/warm pairs`, async ({browser},testInfo)=>{
  expect(process.env.NODE_ENV).toBe("production");
  const fontHashes=["Noto Sans CJK SC","Noto Sans CJK SC:weight=bold"].map(family=>sha256(readFileSync(execFileSync("fc-match",["-f","%{file}",family],{encoding:"utf8"}))));
  expect(fontHashes).toEqual(["b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a","faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb"]);
  const startedAt=new Date().toISOString();
  const worker=await startConsoleWorker({measure:true});
  if (scene.usage) worker.seedUsageTrends();
  const samples: Array<{ repeat: number; cold: Awaited<ReturnType<typeof load>>; warm: Awaited<ReturnType<typeof load>>; interactions: Awaited<ReturnType<typeof actions>> }> = [];
  try {
    for (let repeat=1;repeat<=repetitions;repeat++) {
      const context=await browser.newContext({baseURL:ORIGIN,proxy:{server:worker.proxy},ignoreHTTPSErrors:true,
        viewport:{width:profile.width,height:profile.height},locale:"zh-CN",timezoneId:"UTC",colorScheme:"light",reducedMotion:"reduce",serviceWorkers:"block",deviceScaleFactor:1});
      try {
        if (scene.role) await authenticate(context,worker,scene.role);
        const page=await context.newPage(); await instrument(page);
        const cdp=await context.newCDPSession(page);
        await cdp.send("Performance.enable"); await cdp.send("Network.enable");
        await cdp.send("Emulation.setCPUThrottlingRate",{rate:profile.cpuRate});
        await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:profile.latencyMs,downloadThroughput:profile.downloadBytesSec,uploadThroughput:profile.uploadBytesSec});
        const cold=await load(page,cdp,worker,scene,false);
        const warm=await load(page,cdp,worker,scene,true);
        for (const observation of [cold,warm]) {
          expect(observation.lcpMs !== null && observation.lcpMs > 0, "Native LCP observation exists").toBe(true);
          expect(Object.values(observation.cpuMs).every(value=>value === null || value >= 0), "Document CPU counters are non-negative").toBe(true);
        }
        const measuredActions=await actions(page,scene,cdp);
        samples.push({repeat,cold,warm,interactions:measuredActions});
      } finally {await context.close();}
    }
    expect(worker.unexpected).toEqual([]);
    const summary=Object.fromEntries(["cold","warm"].map(mode=>[mode,Object.fromEntries(["lcpMs","labCls","ttfbMs","loadMs","fcpToObservationBlockingMs","postResponseToInteractiveMs"].map(metric=>[metric,distribution(samples.map(sample=>(sample[mode as "cold"|"warm"] as unknown as Record<string,number|null>)[metric]!))]))]));
    const payload={schema:1,startedAt,finishedAt:new Date().toISOString(),checkoutSha:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),trackedDirty:git("status","--porcelain","--untracked-files=no").length>0,
      fixtureSha256:sha256(readFileSync("tests/browser/worker.ts")),measurementSha256:sha256(readFileSync("tests/performance/console.spec.ts")),lockSha256:sha256(readFileSync("pnpm-lock.yaml")),
      esbuild:JSON.parse(readFileSync("node_modules/esbuild/package.json","utf8")).version,tailwind:JSON.parse(readFileSync("node_modules/@tailwindcss/cli/package.json","utf8")).version,
      node:process.version,v8:process.versions.v8,zlib:process.versions.zlib,brotli:process.versions.brotli,os:{platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length},
      browser:browser.version(),playwright:JSON.parse(readFileSync("node_modules/@playwright/test/package.json","utf8")).version,fontHashes,
      scene:scene.name,role:scene.role??"unauthenticated",profile,theme:"light",locale:"zh-CN",timezone:"UTC",fixtureTime:NOW,
      data:{users:22,keys:2,memberKeys:1,usageDailyRows:scene.usage?4:0,mediaDailyRows:scene.usage?1:0},
      repetitions,settleMs,cold:"fresh isolated context/cache; shared already-running browser process and fixture",warm:"same page/context/session and reload; eligible connections/cache reused, no-store retained; not bfcache",
      assets:{client:{sha256:sha256(consoleClientSource),bytes:consoleAssetBytes(consoleClientSource)},inlineCss:{sha256:sha256(consoleStyles),bytes:consoleAssetBytes(consoleStyles)}},
      limits:{field:"unverified: no authorized RUM sample/window",tbt:"unavailable: no TTI estimator; fcpToObservationBlockingMs has a different bounded endpoint",parsing:"native inclusive event totals; categories overlap and may include profiler overhead; absent event types are null",hydration:"not isolated from per-document ScriptDuration; counters include the probe itself; readiness and DOM observed without production hooks",server:"combined local Node Worker handler including SQL/SSR, not edge/D1 or a query-only timer",compression:"gzip level 9 / brotli quality 11 attribution only; fixture HTTP is uncompressed"},summary,samples};
    writeFileSync(testInfo.outputPath("scalars.json"),JSON.stringify(payload,null,2)+"\n");
  } finally {await worker.close();}
});
