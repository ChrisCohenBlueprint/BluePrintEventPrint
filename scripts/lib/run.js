/**
 * The shape every destructive script in scripts/ shares.
 *
 * These operations used to run as side effects of booting: nobody chose them,
 * nobody saw what they were about to do, and a flag written on a half-finished
 * run disabled them for good. What replaces that is not just "a script" — it is
 * this contract, and it is the same one every time:
 *
 *   1. say WHICH DATABASE and WHICH EVENT, before doing anything at all. A
 *      repair aimed at the wrong event is the failure that cannot be undone by
 *      re-running it;
 *   2. DRY RUN unless --apply. The default is to print what would change;
 *   3. REFUSE on an event with real commercial state unless --force, because
 *      the thing at the other end of a mistake here is somebody's booking.
 *
 * Nothing here writes. It connects, reports, and hands back the flags.
 */
const { connect, getDb, close } = require('../../server/db');
const config = require('../../server/config');
const showsModel = require('../../server/models/shows');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] : null; };

/** The connection string with its credentials removed — safe to print. */
function describeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return '(unparseable connection string)'; }
}

/**
 * Connect, resolve the event, and print the header.
 *
 * `--show <slug|id>` picks the event; without it the deployment's default show
 * is used, which is what a single-event deploy wants. The slug is resolved
 * against the shows table so a typo names no event rather than silently
 * reaching the default one.
 */
async function begin(name) {
  const apply = has('--apply');
  const force = has('--force');

  await connect();
  await showsModel.refresh();

  const wanted = valueOf('--show');
  let showId = config.defaultShow;
  if (wanted) {
    const show = showsModel.bySlug(wanted) || showsModel.byId(wanted);
    if (!show) {
      console.error(`\nNo event matches "${wanted}". Known events:`);
      for (const s of showsModel.list()) console.error(`  ${s.slug.padEnd(8)} ${s.showId}`);
      await close();
      process.exit(2);
    }
    showId = show.showId;
  }
  const show = showsModel.byId(showId);

  console.log(`\n${name}`);
  console.log(`  database   ${config.dbName}  on  ${describeUri(config.mongoUri)}`);
  console.log(`  event      ${showId}${show ? `  (${show.slug} — ${show.name})` : ''}`);
  console.log(`  mode       ${apply ? 'APPLY — this writes' : 'DRY RUN — nothing will be written'}` +
              `${force ? '   --force: the commercial guard is OFF' : ''}`);
  console.log('');

  return { apply, force, showId, db: getDb(), argv, has, valueOf };
}

/** The closing line, so a dry run never reads as a completed one. */
function end(apply) {
  console.log(apply
    ? '\n✔ Applied.'
    : '\n(dry run — nothing was written. Re-run with --apply to make these changes.)');
}

module.exports = { begin, end, close, has, valueOf, argv, describeUri };
