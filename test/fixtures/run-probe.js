#!/usr/bin/env node
/**
 * The smallest script on the scripts/lib/run.js contract: resolve the event,
 * write one document if --apply, close. operator-scripts.test.js runs it to
 * test the contract itself, apart from what any one real script does.
 */
const { begin, end, close } = require('../../scripts/lib/run');

(async () => {
  const { apply, showId, db } = await begin('Probe');
  console.log(`PROBE showId=${showId}`);
  if (apply) await db.collection('probe').insertOne({ showId, at: new Date() });
  end(apply);
  await close();
})().catch(e => { console.error('Failed:', e); process.exit(1); });
