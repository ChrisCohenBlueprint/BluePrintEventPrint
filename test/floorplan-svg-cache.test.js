/**
 * The artwork a page fetches is never one the server has since replaced.
 *
 * An event with no plan of its own is drawn with the artwork shipped in the
 * repo, and that copy went out with `Cache-Control: public, max-age=300`. When
 * the event's first plan was then made live, every open page was told
 * `floorplan:changed`, fetched /floorplan.svg again — and was handed the
 * shipped drawing straight out of its own HTTP cache, with the new stands
 * bound over it, for up to five minutes. The stored artwork never had this
 * problem: it is served `no-cache` with its version as the ETag. The shipped
 * copy is now served the same way.
 */
const http = require('http');
const express = require('express');
const { fakeDb } = require('./fake-mongo');

// A browser's revalidation, sent as a browser sends it. Not fetch(): undici
// adds `Cache-Control: no-cache` to any request carrying If-None-Match, and a
// server is right to answer that with the full body every time.
const revalidate = (url, etag) => new Promise((resolve, reject) => {
  http.get(url, { headers: { 'If-None-Match': etag } }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const db = fakeDb({ floorplans: [], shows: [] });
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const publicRoutes = require('../server/routes/public');

(async () => {
  const app = express();
  app.use((_req, _res, next) => showContext.runAs('LNA', next));
  app.use(publicRoutes);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/floorplan.svg`;

  try {
    console.log('\nNo plan yet: the shipped artwork');
    let res = await fetch(url);
    const cc = res.headers.get('cache-control') || '';
    const tag = res.headers.get('etag');
    check('served', res.status === 200 && /<svg/.test(await res.text()));
    check('told to revalidate, never held blind', /no-cache/.test(cc) && !/max-age=[1-9]/.test(cc), cc);
    check('with a validator, so revalidating costs nothing when it has not changed', !!tag, String(tag));
    let again = await revalidate(url, tag);
    check('unchanged, it answers 304', again.status === 304, String(again.status));

    console.log('\nThe first plan goes live');
    db.store.floorplans.push({ showId: 'LNA', svg: '<svg><!-- the new plan --></svg>', version: 'v1',
                               filename: 'LNA28.svg', bytes: 1 });
    again = await revalidate(url, tag);
    check('the same revalidation now fetches the new plan', again.status === 200 && /the new plan/.test(again.body),
          `${again.status} ${again.body.slice(0, 40)}`);
    check('which is served the same way', /no-cache/.test(again.headers['cache-control'] || ''));
  } finally {
    server.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
