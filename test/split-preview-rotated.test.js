/**
 * Splitting a rotated stand, in the console, on the plan that has 99 of them.
 *
 * A stand's stored geometry is its rectangle as written; Illustrator writes a
 * rotated stand as a rectangle plus a transform, so the written box is the
 * stand turned on its side about another origin. The server has carved the
 * drawn footprint since the merge-footprint work, but the console's split
 * preview still drew its cells, divider and handle on the written box and
 * chose the default direction from it. On Europe's v02 plan (13 Oct 2026)
 * that put the preview across the neighbours and defaulted a tall stand to
 * left/right, so it was carved into two slivers — "the split is busted".
 *
 * The real console, the real model, the real drawing: the preview sandbox is
 * started on the v02 fixture and driven as an operator would drive it.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launch } = require('./harness');

const ROOT = path.join(__dirname, '..');
const SVG = path.join('test', 'fixtures', 'LEX27_Floorplan_v02.svg');
const STATE = path.join(ROOT, 'scripts', '.preview-state-LEX27_Floorplan_v02.json');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const near = (a, b, tol = 1.5) => Math.abs(a - b) < tol;
const sameBox = (a, b) => a && b && near(a.l, b.l) && near(a.t, b.t) && near(a.w, b.w) && near(a.h, b.h);
const union = (a, b) => { const l = Math.min(a.l, b.l), t = Math.min(a.t, b.t); return { l, t, w: Math.max(a.l + a.w, b.l + b.w) - l, h: Math.max(a.t + a.h, b.t + b.h) - t }; };

(async () => {
  try { fs.unlinkSync(STATE); } catch (_) {}
  const port = await freePort();
  const proc = spawn(process.execPath, ['scripts/preview-plan.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), PREVIEW_SVG: SVG }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (log.includes(String(port))) return resolve();
      if (proc.exitCode !== null || Date.now() - t0 > 20000) return reject(new Error('sandbox did not start:\n' + log));
      setTimeout(poll, 50);
    })();
  });

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1600 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/admin`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.click('text=Floorplan');
  for (let i = 0; i < 30 && !(await page.evaluate(() => !!document.querySelector('[data-booth="1050"]'))); i++) await page.waitForTimeout(400);
  await page.waitForTimeout(800);

  const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; }, sel);
  const preview = () => page.evaluate(() => {
    const P = splitUI.parts; const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; };
    return { axis: splitUI.axis, cellA: r(P.cellA), cellB: r(P.cellB), handle: r(P.handle),
             lineLevel: P.line.getAttribute('y1') === P.line.getAttribute('y2') };
  });

  console.log('\nStand 1050: written 81 wide × 40 tall, drawn 40 wide × 81 tall');
  const drawn = await rect('[data-booth="1050"]');
  const stored = await page.evaluate(() => booths['1050'].geometry);
  check('the plan draws it tall', drawn && drawn.h > drawn.w * 1.8, JSON.stringify(drawn));
  check('and stores it wide, as written', stored && stored.w > stored.h * 1.8, JSON.stringify(stored));
  await page.evaluate(() => enterSplitMode('1050'));
  await page.waitForTimeout(400);
  let p = await preview();
  check('the preview covers the stand as drawn, not its written box', sameBox(union(p.cellA, p.cellB), drawn),
        `preview ${JSON.stringify(union(p.cellA, p.cellB))} stand ${JSON.stringify(drawn)}`);
  check('a tall stand defaults to top / bottom', p.axis === 'horizontal' && p.lineLevel, p.axis);
  check('the handle lies across the stand', sameBox({ l: p.handle.l, t: drawn.t, w: p.handle.w, h: drawn.h }, { l: drawn.l, t: drawn.t, w: drawn.w, h: drawn.h }),
        JSON.stringify(p.handle));
  await page.click('#split-bar-apply');
  await page.waitForTimeout(1500);
  const a = await rect('[data-booth="1050"]'), b = await rect('[data-booth="1050-2"]');
  check('the two cells tile the stand as drawn', a && b && sameBox(union(a, b), drawn), JSON.stringify({ a, b }));
  check('one above the other, each the stand\'s full width', a && b && near(a.l, b.l) && near(a.w, drawn.w) && near(b.w, drawn.w) && !near(a.t, b.t),
        JSON.stringify({ a, b }));
  const sizes = await page.evaluate(() => [booths['1050'].sqm, booths['1050-2'].sqm]);
  check('9 + 9 m²', sizes[0] === 9 && sizes[1] === 9, sizes.join(' + '));

  console.log('\nStand 1150: not rotated — as it always was');
  const drawn1150 = await rect('[data-booth="1150"]');
  await page.evaluate(() => enterSplitMode('1150'));
  await page.waitForTimeout(400);
  p = await preview();
  check('the preview covers the stand', sameBox(union(p.cellA, p.cellB), drawn1150));
  check('a wide stand defaults to left / right', p.axis === 'vertical' && !p.lineLevel, p.axis);
  await page.evaluate(() => exitSplitMode());

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  proc.kill('SIGTERM');
  try { fs.unlinkSync(STATE); } catch (_) {}
  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); try { fs.unlinkSync(STATE); } catch (_) {} process.exit(1); });
