import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { authenticate } from '../browser/fixtures';
import { NOW, ORIGIN, startConsoleWorker } from '../browser/worker';
import { distribution, labCls } from './metrics';

type Shift = { startTime: number; value: number; hadRecentInput: boolean };
declare global { interface Window { weakNetworkLab: { shifts: Shift[]; lcp: number | null; drain: () => void } } }

// Five cold/warm pairs and ordinary navigations have a bounded six-minute window.
test.setTimeout(360_000);
const source = '/admin?view=access';
const target = '/admin?view=quotas&range=7d';
const repetitions = 5;
const profile = { latencyMs: 150, downloadBytesPerSecond: 125_000, uploadBytesPerSecond: 125_000, cpuRate: 1 };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
async function painted(page: Page, view: string) {
  await page.waitForFunction(view => document.querySelector(`main[data-dashboard-view="${view}"]:not([aria-busy])`) !== null
    && document.querySelector('button[aria-label="账号菜单"][aria-haspopup="menu"]') !== null, view);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function cpuScalars(cdp: CDPSession) {
  const {metrics} = await cdp.send('Performance.getMetrics');
  const values = new Map<string, number>(metrics.map((value: {name: string; value: number}) => [value.name, value.value]));
  return Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => {
    const value = values.get(name);
    return [name, value !== undefined && Number.isFinite(value) && value >= 0 ? value * 1000 : null];
  }));
}


// Each navigation owns a fresh Performance agent. Reload may reset renderer
// counters, so subtracting the previous document would discard valid warm work.
// The separate network/profile session stays attached throughout both loads.
async function measuredLoad(page: Page, navigate: () => Promise<unknown>) {
  const performanceSession = await page.context().newCDPSession(page);
  try {
    await performanceSession.send('Performance.enable', { timeDomain: 'threadTicks' });
    await navigate();
    await painted(page, 'access');
    const observed = await scalars(page);
    expect(observed.canonicalRuntimeCount).toBe(1);
    expect(observed.resourceTiming.runtime).not.toBeNull();
    if (observed.canonicalStylesheetCount === 1) expect(observed.resourceTiming.stylesheet).not.toBeNull();
    else {
      expect(observed.canonicalStylesheetCount).toBe(0);
      expect(observed.inlineStyleUtf8Bytes).toBeGreaterThan(0);
    }
    return { ...observed, cpuMs: await cpuScalars(performanceSession) };
  } finally { await performanceSession.detach(); }
}

async function scalars(page: Page) {
  return page.evaluate(() => {
    window.weakNetworkLab.drain();
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    // Bind each observation to the exact same-origin asset declared by this
    // document, including the baseline's historical runtime path. URLs remain
    // inside the page; only numeric timings and declared-resource counts leave.
    const canonical = (value: string, kind: 'stylesheet' | 'runtime') => {
      const url = new URL(value, location.href);
      return url.origin === location.origin && !url.search && !url.hash
        && (kind === 'stylesheet' ? /^\/admin\/console-[a-f0-9]{64}\.css$/ : /^\/admin\/console(?:-[a-f0-9]{64})?\.js$/).test(url.pathname);
    };
    const stylesheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet][href]')]
      .filter(link => canonical(link.href, 'stylesheet'));
    const runtimes = [...document.querySelectorAll<HTMLScriptElement>('script[src]')]
      .filter(script => canonical(script.src, 'runtime'));
    if (stylesheets.length > 1 || runtimes.length > 1) throw new Error('Ambiguous canonical console resource observation');
    const finite = (value: number) => Number.isFinite(value) ? value : null;
    const timing = (entry: PerformanceResourceTiming) => ({
      startTime: finite(entry.startTime), fetchStart: finite(entry.fetchStart), requestStart: finite(entry.requestStart),
      responseStart: finite(entry.responseStart), responseEnd: finite(entry.responseEnd), duration: finite(entry.duration),
      transferSize: finite(entry.transferSize), encodedBodySize: finite(entry.encodedBodySize), decodedBodySize: finite(entry.decodedBodySize)
    });
    const observed = (url: string | undefined) => {
      if (!url) return null;
      const entries = resources.filter(entry => entry.name === url);
      if (entries.length > 1) throw new Error('Repeated canonical console resource observation');
      return entries.length === 1 ? timing(entries[0]!) : null;
    };
    const resourceTiming = { stylesheet: observed(stylesheets[0]?.href), runtime: observed(runtimes[0]?.src) };
    const documentTiming = { ...timing(nav), domInteractive: finite(nav.domInteractive),
      domContentLoadedEventStart: finite(nav.domContentLoadedEventStart), domContentLoadedEventEnd: finite(nav.domContentLoadedEventEnd),
      loadEventStart: finite(nav.loadEventStart), loadEventEnd: finite(nav.loadEventEnd) };
    const bytes = (kind: string) => resources.filter(entry => kind === 'script' ? entry.initiatorType === 'script' : new URL(entry.name).pathname.endsWith('.css'))
      .reduce((sum, entry) => sum + entry.transferSize, 0);
    return { resourceTiming, documentTiming, canonicalStylesheetCount: stylesheets.length, canonicalRuntimeCount: runtimes.length,
      inlineStyleUtf8Bytes: [...document.querySelectorAll('style')].reduce((sum, element) => sum + new TextEncoder().encode(element.textContent ?? '').byteLength, 0),
      layoutShiftSupported: PerformanceObserver.supportedEntryTypes.includes('layout-shift'), shifts: window.weakNetworkLab.shifts, lcpMs: window.weakNetworkLab.lcp, ttfbMs: nav.responseStart, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      loadMs: nav.loadEventEnd, observationMs: performance.now(), htmlTransferBytes: nav.transferSize,
      scriptTransferBytes: bytes('script'), cssTransferBytes: bytes('css') };
  });
}

for (const width of [390, 1440]) test(`150 ms RTT / 1 Mbps ${width}px: cold, warm and navigation`, async ({ browser }, info) => {
  expect(process.env.NODE_ENV).toBe('production');
  const worker = await startConsoleWorker({ measure: true });
  const samples = [];
  try {
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const context = await browser.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true,
        viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
      try {
        await authenticate(context, worker, 'admin');
        await context.addInitScript(fixed => {
          const shifts: Shift[] = [];
          const lab = window.weakNetworkLab = { shifts, lcp: null as number | null, drain: () => {} };
          const observers: Array<{ observer: PerformanceObserver; read: (entry: PerformanceEntry) => void }> = [];
          for (const type of ['layout-shift', 'largest-contentful-paint']) {
            if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
            const read = (entry: PerformanceEntry) => {
              if (type === 'largest-contentful-paint') lab.lcp = entry.startTime;
              else { const value = entry as PerformanceEntry & Shift; shifts.push({ startTime: value.startTime, value: value.value, hadRecentInput: value.hadRecentInput }); }
            };
            const observer = new PerformanceObserver(list => list.getEntries().forEach(read));
            observer.observe({ type, buffered: true }); observers.push({ observer, read });
          }
          lab.drain = () => observers.forEach(({ observer, read }) => observer.takeRecords().forEach(read));
          const NativeDate = Date;
          window.Date = new Proxy(NativeDate, {
            construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [fixed], newTarget),
            apply: () => new NativeDate(fixed).toString(),
            get: (target, key, receiver) => key === 'now' ? () => fixed : Reflect.get(target, key, receiver)
          });
        }, Date.parse(NOW));
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latencyMs,
            downloadThroughput: profile.downloadBytesPerSecond, uploadThroughput: profile.uploadBytesPerSecond });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
          const cold = await measuredLoad(page, () => page.goto(source, { waitUntil: 'load' }));
          const warm = await measuredLoad(page, () => page.reload({ waitUntil: 'load' }));
          // Measure the real default link on each revision. The baseline may
          // intercept it; the candidate delegates ordinary pages to the browser.
          // Historical paired enhanced/native evidence owns that design choice.
          await page.goto(source, { waitUntil: 'load' }); await painted(page, 'access');
          if (width < 1000) await page.locator('.nav-toggle-label').click();
          const marker = await page.locator('.nav-rail').elementHandle();
          const link = page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '额度政策', exact: true });
          await expect(link).toHaveAttribute('href', target);
          const response = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === new URL(target, ORIGIN).href);
          const started = performance.now();
          await link.click({noWaitAfter: true});
          await painted(page, 'quotas');
          const completionMs = performance.now() - started;
          expect(page.url()).toBe(new URL(target, ORIGIN).href);
          const result = await response; expect(result.status()).toBe(200); await result.finished();
          const retained = await marker!.evaluate(node => node.isConnected).catch(() => false);
          const documentNavigation = result.request().isNavigationRequest();
          expect(retained).toBe(!documentNavigation);
          const navigation = { mode: 'default', documentNavigation, completionMs, status: result.status(),
            responseBodyBytes: (await result.body()).byteLength,
            requestToResponseHeadersMs: result.request().timing().responseStart, retainedShell: retained };
          const reduce = ({ shifts, ...value }: Awaited<ReturnType<typeof scalars>> & {cpuMs: Awaited<ReturnType<typeof cpuScalars>>}) => ({ ...value, boundedCls: value.layoutShiftSupported ? labCls(shifts) : null });
          samples.push({ repeat: repeat + 1, cold: reduce(cold), warm: reduce(warm), navigation });
        } finally { await cdp.detach(); }
      } finally { await context.close(); }
    }
    expect(worker.unexpected).toEqual([]);
    const summary = { coldObservationMs: distribution(samples.map(sample => sample.cold.observationMs)),
      warmObservationMs: distribution(samples.map(sample => sample.warm.observationMs)),
      defaultNavigationCompletionMs: distribution(samples.map(sample => sample.navigation.completionMs)) };
    writeFileSync(info.outputPath('weak-network-scalars.json'), JSON.stringify({ schema: 5, cpuTimeDomain: 'threadTicks', cpuCounterScope: 'fresh independent Performance session per cold/warm navigation; raw phase counters in milliseconds; no cross-navigation subtraction',
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
      fixtureHash: hash('tests/browser/worker.ts'), authenticationFixtureHash: hash('tests/browser/fixtures.ts'), sqlFixtureHash: hash('tests/support/sqlite-d1.ts'), harnessHash: hash('tests/performance/weak-network.spec.ts'), lockHash: hash('pnpm-lock.yaml'),
      browser: browser.version(), playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version,
      fontHashes: ['Noto Sans CJK SC', 'Noto Sans CJK SC:weight=bold'].map(font => hash(execFileSync('fc-match', ['-f', '%{file}', font], { encoding: 'utf8' }))),
      node: process.version, width, repetitions, profile,
      limits: 'Local uncompressed synthetic Node/SQLite fixture; no edge/D1/RUM, field INP or performance threshold claim. Cold=fresh context; warm=same context reload with eligible cache. Completion ends at committed target plus fonts/two rendering frames. System fonts. CPU uses threadTicks from a fresh independent Performance session enabled before each cold/warm navigation and detached after observation; raw phase counters are never subtracted across navigation. Missing, non-finite or negative counters stay null. Resource timings match exact declared canonical same-origin assets; null means no matching observed entry, while declared counts and inlineStyleUtf8Bytes distinguish inline CSS from missing external evidence. Native timing zeros are retained without interpreting them as measured network work. No resource URLs or bodies are retained. The separate network/profile session remains attached during the experiment. Includes probe and all JS, not isolated hydration cost. Default navigation clicks the unchanged sidebar link with JS enabled, without target overrides or automatic click navigation wait. Each sample records the real document-navigation and shell-retention disposition; no synthetic enhanced mode is claimed after ordinary navigation becomes native. No arbitrary settling delay. Same generated product assets must be built for each compared revision.',
      summary, samples }, null, 2) + '\n');
  } finally { await worker.close(); }
});
