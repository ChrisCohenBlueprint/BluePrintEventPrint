#!/usr/bin/env node
/**
 * Show what can be read from a floorplan SVG, and write nothing.
 *
 *   node scripts/preview-stands.js path/to/plan.svg [--json out.json]
 *
 * Run this before importing a plan. Reading is deterministic on artwork that
 * meets the spec, but the numbers still deserve a human's eye before they
 * become sellable inventory.
 */
const fs = require('fs');
const { extractStands } = require('../server/lib/extract-stands');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/preview-stands.js <plan.svg> [--json <out.json>]');
  process.exit(2);
}
const jsonIdx = process.argv.indexOf('--json');
const r = extractStands(fs.readFileSync(file, 'utf8'));

const U = r.unit === 'sqft' ? 'ft²' : r.unit === 'sqm' ? 'm²' : '';
console.log(`\nStands read from ${require('path').basename(file)}`);
console.log(`  ${r.stands.length} stands, from ${r.rects} shapes and ${r.texts} text labels`);
if (r.unitsPerArea) {
  console.log(`  scale: ${r.unitsPerArea.toFixed(3)} drawing units per ${U} (calibrated from the plan itself)`);
}
const total = r.stands.reduce((s, x) => s + (x.area || 0), 0);
console.log(`  ${r.stands.filter(s => s.areaSource === 'printed').length} areas printed, ` +
            `${r.stands.filter(s => s.areaSource === 'derived').length} derived — ${total.toLocaleString()} ${U} in total`);
const named = r.stands.filter(s => s.exhibitor);
console.log(`  ${named.length} carry an exhibitor name, ${r.stands.length - named.length} are unnamed`);

if (r.warnings.length) {
  console.log('\nWorth a look:');
  r.warnings.forEach(w => console.log(`  - ${w}`));
}

console.log('\n  number   area      size            exhibitor');
for (const s of r.stands.slice(0, 14)) {
  console.log(`  ${s.number.padEnd(8)} ${String(s.area).padStart(5)} ${U.padEnd(4)} ` +
              `${(s.geometry.w.toFixed(0) + '×' + s.geometry.h.toFixed(0)).padEnd(12)} ` +
              `${s.exhibitor || ''}`);
}
if (r.stands.length > 14) console.log(`  … and ${r.stands.length - 14} more`);

if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
  fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(r, null, 2));
  console.log(`\nWritten to ${process.argv[jsonIdx + 1]} — nothing was sent to the database.`);
}
