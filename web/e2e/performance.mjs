// Repeatable read-only browser measurements. No wallet connection, orders, or production writes.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const site = (process.argv.find(a => a.startsWith('http')) ?? 'https://tapemarket.io').replace(/\/$/, '');
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.slice(7) ?? 2);
const mobile = process.argv.includes('--mobile');
const slowNetwork = process.argv.includes('--slow-network');
const viewport = mobile ? { width: 390, height: 844 } : { width: 1366, height: 768 };
const browser = await chromium.launch();
const results = [];
try {
  for (const path of ['/', '/trade']) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport, isMobile: mobile });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (slowNetwork) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 160, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, connectionType: 'cellular4g' });
    await cdp.send('Performance.enable');
    await page.addInitScript(() => {
      window.__speed = { tasks: [], lcp: 0, cls: 0 };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__speed.tasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__speed.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__speed.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    const requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${site}${path}`, { waitUntil: 'domcontentloaded' });
    await page.locator(path === '/' ? '.lp-hero h1' : '.tt-chart canvas').first().waitFor();
    const readyMs = await page.evaluate(() => performance.now());
    await page.waitForTimeout(2000);
    const metrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource');
      const scripts = resources.filter(entry => entry.name.includes('/assets/') && entry.name.endsWith('.js'));
      return {
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        lcpMs: window.__speed.lcp,
        cls: window.__speed.cls,
        blockingMs: window.__speed.tasks.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0),
        maxTaskMs: Math.max(0, ...window.__speed.tasks),
        scriptDecodedBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        scripts: scripts.map(entry => ({ name: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
        resources: resources.length,
      };
    });
    metrics.readyAtMs = readyMs;
    metrics.candleRequests = requests.filter(request => request.body?.includes('candleSnapshot')).length;
    metrics.totalRequests = requests.length;
    metrics.streamConnections = requests.filter(request => new URL(request.url).pathname === '/stream').length;
    const timings = await cdp.send('Performance.getMetrics');
    metrics.scriptCpuMs = (timings.metrics.find(metric => metric.name === 'ScriptDuration')?.value ?? 0) * 1000;
    if (path === '/trade') {
      const pairs = [];
      for (const market of [1, 3, 7, 0, 8, 2, 0]) {
        const before = await page.evaluate(() => performance.now());
        await page.locator('.mcard').nth(market).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        pairs.push((await page.evaluate(() => performance.now())) - before);
      }
      metrics.pairSwitchMs = pairs;
      metrics.pricesRequestsAfterSwitches = requests.filter(request => new URL(request.url).pathname === '/prices').length;
      metrics.candleRequestsAfterSwitches = requests.filter(request => request.body?.includes('candleSnapshot')).length;
    }
    results.push({ path, run: run + 1, cpuSlowdown: 4, viewport, network: slowNetwork ? '1.6Mbps down / 750Kbps up / 160ms latency' : 'unthrottled', ...metrics, errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally { await browser.close(); }
if (output) writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
