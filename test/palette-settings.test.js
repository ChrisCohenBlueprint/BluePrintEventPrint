/**
 * The colours an event's spaces are painted in: chosen by an admin, or read
 * off the plan — and a choice outranks a reading.
 *
 * The failure this pins down: an import used to write the plan's colours over
 * whatever was set, so choosing colours at upload and then reading the stands
 * silently put the plan's own back. The picker would have been a lie.
 */
const { fakeDb } = require('./fake-mongo');

const dbPath = require.resolve('../server/db');
let db;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => db } };

const showContext = require('../server/show-context');
const settings = require('../server/models/settings');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const on = (show, fn) => showContext.runAs(show, fn);

(async () => {
  console.log('\nNothing set: the app\'s own colours');
  db = fakeDb({ settings: [] });
  check('the palette is null', (await on('LNA', () => settings.get())).palette === null);

  console.log('\nAn import reads the plan\'s colours');
  const fromPlan = { available: '#fffcf8', sold: '#689abb', sponsored: '#7c1315' };
  let r = await on('LNA', () => settings.setPaletteFromArtwork(fromPlan));
  check('and stores them', r.ok && !r.kept, JSON.stringify(r));
  let p = (await on('LNA', () => settings.get())).palette;
  check('marked as read off the artwork', p && p.source === 'artwork', p && p.source);
  check('sold is the plan\'s light blue', p && p.sold === '#689abb');
  check('on hold is never read off a plan', p && p.held === null, String(p && p.held));

  console.log('\nAn admin chooses colours');
  r = await on('LNA', () => settings.setPalette({ sold: '#123456', held: '#ff0000', areaTaken: '#0000FF' }));
  check('the choice is stored', r.ok && r.palette && r.palette.sold === '#123456', JSON.stringify(r.palette));
  check('a colour not chosen is null, meaning the app\'s own', r.palette.available === null);
  check('on hold CAN be chosen', r.palette.held === '#ff0000');
  check('hex is lower-cased', r.palette.areaTaken === '#0000ff');
  check('and marked as chosen', r.palette.source === 'admin');

  console.log('\nRe-reading the plan does not undo the choice');
  r = await on('LNA', () => settings.setPaletteFromArtwork(fromPlan));
  check('the import reports the choice was kept', r.ok && r.kept === true, JSON.stringify(r));
  p = (await on('LNA', () => settings.get())).palette;
  check('sold is still what the admin chose', p.sold === '#123456', p.sold);
  check('and the reading is offered alongside, for the picker', r.fromArtwork && r.fromArtwork.sold === '#689abb');

  console.log('\nWhat is refused');
  r = await on('LNA', () => settings.setPalette({ sold: 'yellow' }));
  check('a non-hex colour is dropped rather than stored', r.ok && r.palette === null, JSON.stringify(r));
  r = await on('LNA', () => settings.setPalette({ available: '#fff' }, { source: 'artwork' }));
  check('a reading with no sold colour is refused', r.ok === false && r.reason === 'no_sold_colour');

  console.log('\nBack to the app\'s colours');
  await on('LNA', () => settings.setPalette({ sold: '#123456' }));
  r = await on('LNA', () => settings.clearPalette());
  check('cleared', r.ok && (await on('LNA', () => settings.get())).palette === null);
  r = await on('LNA', () => settings.setPalette({}));
  check('choosing nothing at all is the same as clearing', r.ok && r.palette === null);

  console.log('\nOne event\'s colours are its own');
  await on('LNA', () => settings.setPalette({ sold: '#123456' }));
  check('another event is untouched', (await on('LEX', () => settings.get())).palette === null);

  console.log('\nOlder rows, written before the picker existed');
  db = fakeDb({ settings: [{ _id: 'LNA', palette: { available: '#fffcf8', sold: '#689abb', sponsored: '#7c1315' } }] });
  p = (await on('LNA', () => settings.get())).palette;
  check('read as artwork-sourced, so an import may still refresh them', p && p.source === 'artwork');
  check('with the new colours present and unset', p && p.held === null && p.areaTaken === null);

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})();
