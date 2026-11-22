// Node.js + Playwright: read-only responsive/scroll measurements, never signs or mutates app data.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Dimas Sawaludin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const base = process.argv[2] || 'https://onerub.net';
const label = process.argv[3] || 'baseline';
const injectCss = process.argv.includes("--inject-css");
const output = 'artifacts/responsive-performance';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { base, label, capturedAt: new Date().toISOString(), environment: 'headless Chrome mobile emulation, 4x CPU throttling for scroll; NOT a physical phone', layouts: [], scroll: [], errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
  await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.__renderProbe = { raf: 0, draws: 0, longTasks: [] };
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = function (callback) { return original.call(window, time => { window.__renderProbe.raf++; callback(time); }); };
    for (const type of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = window[type]?.prototype;
      if (!prototype) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const draw = prototype[name];
        if (draw) prototype[name] = function (...args) { window.__renderProbe.draws++; return draw.apply(this, args); };
      }
    }
    try { new PerformanceObserver(list => { window.__renderProbe.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))); }).observe({ type: 'longtask', buffered: true }); } catch {}
  });
  if (injectCss) {
    const css = await fs.readFile("app/globals.css", "utf8");
    await context.route("**/_next/static/**/*.css*", route => route.fulfill({ status: 200, contentType: "text/css", body: css }));
  }
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  for (const route of ['/', '/playground', '/permissions']) {
    await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('h1').first().waitFor();
    if (route === '/playground') await page.locator('.people-grid .person-card').first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 375, 390, 430, 768, 1024, 1151, 1280, 1440]) {
      await page.setViewportSize({ width, height: width > 768 ? 900 : 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const overflow = [...document.querySelectorAll('main *, .site-header *, .site-footer *')].filter(el => {
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && (r.right > vw + 2 || r.left < -2) && !el.closest('.office-film, .sculpture-canvas, .modal:not([open]), .nav-pill:not(.open)');
        }).slice(0, 16).map(el => ({ tag: el.tagName, cls: el.className?.baseVal ?? el.className, text: el.textContent.slice(0, 65), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) }));
        const imgs = [...document.querySelectorAll('.agent-avatar img')];
        return { viewport: vw, documentWidth: document.documentElement.scrollWidth, overflow, peopleCards: document.querySelectorAll('.person-card').length, brokenAvatars: imgs.filter(img => img.complete && !img.naturalWidth).length, gridColumns: getComputedStyle(document.querySelector('.people-grid') || document.body).gridTemplateColumns };
      });
      report.layouts.push({ route, width, ...result });
      if (width === 390 && route === '/playground') {
        await page.screenshot({ path: output + '/' + label + '-mobile-hero.png' });
        await page.locator('#people').scrollIntoViewIfNeeded();
        await page.screenshot({ path: output + '/' + label + '-mobile-people.png' });
        await page.evaluate(() => scrollTo(0, 0));
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Performance.enable');
  for (let trial = 1; trial <= 3; trial++) {
    await page.goto(base + '/playground#people', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('.people-grid .person-card').first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.locator('#people').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const scroll = await page.evaluate(async () => {
      const probe = window.__renderProbe, rafStart = probe.raf, drawStart = probe.draws, start = performance.now();
      const people = document.querySelector('#people');
      const top = people.getBoundingClientRect().top + scrollY;
      const deltas = []; let previous = start;
      await new Promise(resolve => {
        const tick = now => {
          deltas.push(now - previous); previous = now;
          const elapsed = now - start;
          scrollTo({ top: top + Math.sin(elapsed / 500) * 550 + 550, behavior: 'instant' });
          if (elapsed < 3000) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      const end = performance.now(), sorted = deltas.slice(1).sort((a,b) => a-b);
      return { durationMs: end-start, frames: sorted.length, meanFrameMs: sorted.reduce((a,b) => a+b,0)/sorted.length, p95FrameMs: sorted[Math.floor(sorted.length*.95)], framesOver33ms: sorted.filter(x => x>33.5).length, scheduledCallbacks: probe.raf-rafStart, webglDrawCalls: probe.draws-drawStart, longTasks: probe.longTasks.filter(t => t.start >= start && t.start <= end), peopleCount: document.querySelectorAll('.person-card').length };
    });
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    report.scroll.push({ trial, ...scroll, taskTimeMs: (after.TaskDuration-before.TaskDuration)*1000, scriptTimeMs: (after.ScriptDuration-before.ScriptDuration)*1000, layoutTimeMs: (after.LayoutDuration-before.LayoutDuration)*1000, styleTimeMs: (after.RecalcStyleDuration-before.RecalcStyleDuration)*1000 });
    console.log(JSON.stringify({ trial, ...report.scroll.at(-1) }));
  }
  await context.close();
} finally { await browser.close(); }
await fs.writeFile(output + '/' + label + '.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ label, layouts: report.layouts.length, horizontalOverflow: report.layouts.filter(l => l.documentWidth > l.viewport+2 || l.overflow.length).map(l => ({ route:l.route,width:l.width,documentWidth:l.documentWidth,overflow:l.overflow })), errors:report.errors }));
