import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { authenticate } from '../browser/fixtures';
import { NOW, ORIGIN, startConsoleWorker } from '../browser/worker';
import { distribution, labCls } from './metrics';

type Shift = { startTime: number; value: number; hadRecentInput: boolean };
declare global { interface Window { weakNetworkLab: { shifts: Shift[]; lcp: number | null; drain: () => void } } }

// Five pairs plus two navigation modes at 1 Mbps need a bounded six-minute window.
test.setTimeout(360_000);
const source = '/admin?view=access';
const target = '/admin?view=quotas';
const repetitions = 5;
const profile = { latencyMs: 150, downloadBytesPerSecond: 125_000, uploadBytesPerSecond: 125_000, cpuRate: 1 };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
async function painted(page: Page, view: string) {
  await page.waitForFunction(view => document.querySelector(`main[data-dashboard-view="${view}"]:not([aria-busy])`) !== null
    && typeof history.state?.miniEntry === 'string', view);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function cpuScalars(cdp: CDPSession) {
  const {metrics} = await cdp.send('Performance.getMetrics');
  const values = new Map<string, number>(metrics.map((value: {name: string; value: number}) => [value.name, value.value]));
  return Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name, values.has(name) ? values.get(name)! * 1000 : null]));
}

async function scalars(page: Page) {
  return page.evaluate(() => {
    window.weakNetworkLab.drain();
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bytes = (kind: string) => resources.filter(entry => kind === 'script' ? entry.initiatorType === 'script' : new URL(entry.name).pathname.endsWith('.css'))
      .reduce((sum, entry) => sum + entry.transferSize, 0);
    return { layoutShiftSupported: PerformanceObserver.supportedEntryTypes.includes('layout-shift'), shifts: window.weakNetworkLab.shifts, lcpMs: window.weakNetworkLab.lcp, ttfbMs: nav.responseStart, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
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
        await cdp.send('Network.enable');
        await cdp.send('Performance.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latencyMs,
          downloadThroughput: profile.downloadBytesPerSecond, uploadThroughput: profile.uploadBytesPerSecond });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
        await page.goto(source, { waitUntil: 'load' }); await painted(page, 'access');
        const cold = {...await scalars(page), cpuMs: await cpuScalars(cdp)};
        await page.reload({ waitUntil: 'load' }); await painted(page, 'access');
        const warm = {...await scalars(page), cpuMs: await cpuScalars(cdp)};
        const navigation = [];
        // Counterbalance order to avoid giving one mode every first request.
        for (const mode of repeat % 2 ? ['document', 'enhanced'] : ['enhanced', 'document']) {
          await page.goto(source, { waitUntil: 'load' }); await painted(page, 'access');
          if (width < 1000) await page.locator('.nav-toggle-label').click();
          const marker = await page.locator('.nav-rail').elementHandle();
          const response = page.waitForResponse(response => new URL(response.url()).pathname === '/admin'
            && new URL(response.url()).searchParams.get('view') === 'quotas');
          const started = performance.now();
          if (mode === 'enhanced') await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '额度政策', exact: true }).click();
          else await page.goto(target, { waitUntil: 'load' });
          await painted(page, 'quotas');
          const completionMs = performance.now() - started;
          const result = await response; expect(result.status()).toBe(200); await result.finished();
          const retained = await marker!.evaluate(node => node.isConnected).catch(() => false);
          expect(retained).toBe(mode === 'enhanced');
          navigation.push({ mode, completionMs, status: result.status(), responseBodyBytes: (await result.body()).byteLength,
            requestToResponseHeadersMs: result.request().timing().responseStart, retainedShell: retained });
        }
        const reduce = ({ shifts, ...value }: Awaited<ReturnType<typeof scalars>> & {cpuMs: Awaited<ReturnType<typeof cpuScalars>>}) => ({ ...value, boundedCls: value.layoutShiftSupported ? labCls(shifts) : null });
        samples.push({ repeat: repeat + 1, cold: reduce(cold), warm: reduce(warm), navigation });
      } finally { await context.close(); }
    }
    expect(worker.unexpected).toEqual([]);
    const summary = { coldObservationMs: distribution(samples.map(sample => sample.cold.observationMs)),
      warmObservationMs: distribution(samples.map(sample => sample.warm.observationMs)),
      enhancedCompletionMs: distribution(samples.map(sample => sample.navigation.find(item => item.mode === 'enhanced')!.completionMs)),
      documentCompletionMs: distribution(samples.map(sample => sample.navigation.find(item => item.mode === 'document')!.completionMs)) };
    writeFileSync(info.outputPath('weak-network-scalars.json'), JSON.stringify({ schema: 1,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
      fixtureHash: hash('tests/browser/worker.ts'), authenticationFixtureHash: hash('tests/browser/fixtures.ts'), sqlFixtureHash: hash('tests/support/sqlite-d1.ts'), harnessHash: hash('tests/performance/weak-network.spec.ts'), lockHash: hash('pnpm-lock.yaml'),
      browser: browser.version(), playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version,
      fontHashes: ['Noto Sans CJK SC', 'Noto Sans CJK SC:weight=bold'].map(font => hash(execFileSync('fc-match', ['-f', '%{file}', font], { encoding: 'utf8' }))),
      node: process.version, width, repetitions, profile,
      limits: 'Local uncompressed synthetic Node/SQLite fixture; no edge/D1/RUM, field INP or performance threshold claim. Cold=fresh context; warm=same context reload with eligible cache. Completion ends at committed target plus fonts/two rendering frames. System fonts. Document CPU counters include probe and all JS, not isolated hydration cost. No arbitrary settling delay. Same generated product assets must be built for each compared revision.',
      summary, samples }, null, 2) + '\n');
  } finally { await worker.close(); }
});
