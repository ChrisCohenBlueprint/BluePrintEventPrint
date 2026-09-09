#!/usr/bin/env node
/**
 * Validate a supplied floorplan SVG against docs/floorplan-artwork-spec.html.
 *
 * Run this on every file a designer sends, before accepting it. Failures name
 * the clause so the report can be forwarded as-is.
 *
 *   node scripts/validate-artwork.js path/to/plan.svg [--schedule path/to/stands.csv]
 */
const fs = require('fs');
const path = require('path');
const { validate, SPEC } = require('../server/lib/artwork-spec');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/validate-artwork.js <plan.svg> [--schedule <stands.csv>]');
  process.exit(2);
}
const schedIdx = process.argv.indexOf('--schedule');
const schedule = schedIdx > -1 ? process.argv[schedIdx + 1] : null;

const svg = fs.readFileSync(file, 'utf8');

// The checks themselves live in server/lib/artwork-spec.js so an upload and a
// file a designer emails are judged by the same implementation — a report an
// admin sees and one forwarded to a designer must never disagree.
const scheduleText = schedule && fs.existsSync(schedule) ? fs.readFileSync(schedule, 'utf8') : null;
if (schedule && !scheduleText) console.warn(`schedule not found: ${schedule}`);
const { results } = validate(svg, { scheduleText });

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`\nArtwork validation — ${path.basename(file)}`);
console.log(`Specification ${SPEC}\n`);

for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.clause}] ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`\nFile REJECTED. Clauses to correct: ${[...new Set(failed.map(f => f.clause))].join(', ')}`);
  console.log(`Specification: docs/floorplan-artwork-spec.html`);
}
process.exit(failed.length ? 1 : 0);
