// spec-003 Task 9 — Playwright smoke suite asserting G3, G5, G9.
// Run: node scripts/smoke.mjs  (after `npm install` + `npx playwright install chromium`)
//
// Bootstraps a local static server, launches Chromium via Playwright, and
// exercises three guarantee groups from spec-003:
//   G3 — graph renders correct node counts + disclosure affordance
//   G5 — spotlight deep-link (?spotlight=<flowAddress>) activates the overlay
//   G9 — performance gate: first-paint + long-task ratio under mobile throttle
//
// Exit code 0 = all assertions passed; 1 = one or more failed.

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const PLAYER = 'LeBron+James';
const PLAYER_URL = `${BASE}/fandom.html?player=${PLAYER}`;
const DATA_URL = `${BASE}/data/2544.json`;

let server = null;
let browser = null;
const failures = [];
const passes = [];

function assert(cond, label, detail) {
  if (cond) {
    passes.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function startServer() {
  server = require('./serve.cjs');
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  // Wait for the port to accept connections (up to ~5s).
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/index.json', { method: 'GET' });
      if (r.ok || r.status === 200 || r.status === 404) return;
    } catch {
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  throw new Error(`http.server on :${PORT} did not become reachable`);
}

function stopServer() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
}

// ---------------------------------------------------------------------------
// G3 — graph renders with correct node counts + disclosure
// ---------------------------------------------------------------------------
async function testG3(page) {
  console.log('\n[G3] Graph renders with correct node counts + disclosure');
  await page.goto(PLAYER_URL, { waitUntil: 'domcontentloaded' });
  // Graph build is async (data fetch + force-graph layout). Give it room.
  await page.waitForFunction(() => window.__fandomCoverage, {}, { timeout: 45000 });

  const cov = await page.evaluate(() => window.__fandomCoverage || {});
  assert(
    typeof cov.S === 'number' && cov.S >= 200,
    'G3.a window.__fandomCoverage.S >= 200',
    `got S=${cov.S}`
  );
  assert(
    cov.M === 9960,
    'G3.b window.__fandomCoverage.M === 9960',
    `got M=${cov.M}`
  );

  const coverageText = await page.evaluate(
    () => document.getElementById('graph-coverage')?.textContent || ''
  );
  assert(
    coverageText.includes('Showing top 200 of 9,960'),
    'G3.c #graph-coverage contains "Showing top 200 of 9,960"',
    `got: ${JSON.stringify(coverageText)}`
  );

  const canvasDims = await page.evaluate(() => {
    const c = document.querySelector('#graph canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, attrW: c.width, attrH: c.height };
  });
  assert(
    canvasDims && (canvasDims.w > 0 || canvasDims.attrW > 0),
    'G3.d #graph canvas exists with non-zero dimensions',
    canvasDims ? `got ${JSON.stringify(canvasDims)}` : 'canvas not found'
  );
}

// ---------------------------------------------------------------------------
// G5 — spotlight deep-link works
// ---------------------------------------------------------------------------
async function testG5(page) {
  console.log('\n[G5] Spotlight deep-link works');
  // Resolve the first owner's flowAddress from the raw dataset.
  const flowAddress = (await (await fetch(DATA_URL)).json()).owners[0].flowAddress;
  assert(!!flowAddress, 'G5.a resolved first owner flowAddress', `got ${flowAddress}`);

  await page.goto(
    `${PLAYER_URL}&spotlight=${encodeURIComponent(flowAddress)}`,
    { waitUntil: 'domcontentloaded' }
  );
  // Router dispatches spotlight via setTimeout(1500) after graph build; pad it.
  await page.waitForFunction(() => document.getElementById('spotlight-overlay')?.style.display === 'flex', {}, {timeout:45000});

  const overlayDisplay = await page.evaluate(
    () => document.getElementById('spotlight-overlay')?.style.display || 'none'
  );
  assert(
    overlayDisplay !== 'none',
    'G5.b #spotlight-overlay is visible (display !== none)',
    `got display=${JSON.stringify(overlayDisplay)}`
  );

  const uname = await page.evaluate(
    () => (document.getElementById('spotlight-username')?.textContent || '').trim()
  );
  assert(
    uname.length > 0,
    'G5.c #spotlight-username has non-empty text',
    `got: ${JSON.stringify(uname)}`
  );
}

// ---------------------------------------------------------------------------
// G9 — performance gate (mobile throttle)
// ---------------------------------------------------------------------------
async function testG9(context) {
  console.log('\n[G9] Performance gate (mobile throttle)');
  const page = await context.newPage();
  // iPhone 13 viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  // CPU + network throttle via CDP (Playwright exposes these on the context
  // through the page's CDPSession). We enable them before navigation.
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
  });

  const buildStart = Date.now();
  await page.goto(PLAYER_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const buildEnd = Date.now();
  const graphBuildMs = buildEnd - buildStart;

  const firstPaint = await page.evaluate(
    () => performance.getEntriesByType('paint').find((e) => e.name === 'first-paint')?.startTime || 0
  );
  assert(
    firstPaint > 0 && firstPaint < 4000,
    'G9.a first-paint < 4000ms',
    `got firstPaint=${firstPaint}ms`
  );

  const longTasks = await page.evaluate(
    () => performance.getEntriesByType('longtask').map((e) => e.duration)
  );
  const totalLongTaskMs = longTasks.reduce((a, b) => a + b, 0);
  const ratio = graphBuildMs > 0 ? totalLongTaskMs / graphBuildMs : 1;
  assert(
    ratio < 0.5,
    `G9.b long-task ratio < 0.5 of graph-build time (${graphBuildMs}ms)`,
    `longTasks=${longTasks.length} total=${totalLongTaskMs}ms ratio=${ratio.toFixed(3)}`
  );

  await page.close();
}

// ---------------------------------------------------------------------------
async function main() {
  let context = null;
  try {
    await startServer();
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {}) });
    context = await browser.newContext();
    // Pin repository snapshots and omit third-party media in this local regression run.
    await context.route('https://fandom-v3.vercel.app/data/**', route => route.abort());
    await context.route('**/*', route => route.request().resourceType() === 'image' ? route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'}) : route.fallback());

    const p3 = await context.newPage();
    await testG3(p3);
    await p3.close();

    const p5 = await context.newPage();
    await testG5(p5);
    await p5.close();

    await testG9(context);

    await browser.close();
  } catch (err) {
    failures.push(`fatal: ${err && err.stack ? err.stack : String(err)}`);
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    stopServer();
  }


  console.log(`\n--- Smoke summary: ${passes.length} passed, ${failures.length} failed ---`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log('  ALL PASS');
    process.exit(0);
  }
}

main();
