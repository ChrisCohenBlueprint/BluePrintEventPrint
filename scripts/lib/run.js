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
 *      the thing at the other end of a mistake here is somebody's booking;
 *   4. TELL THE OPERATOR TO RESTART the service after --apply. The running
 *      server holds each event's stands, areas and tags in memory and only
 *      re-reads them when something in the app changes them, so a script that
 *      rewrites the database is invisible to every open plan, and to every new
 *      visitor, until it does.
 *
 * Nothing here writes — not even an index (see db.connect). It connects,
 * reports, and hands back the flags.
 */
const { connect, getDb, close } = require('../../server/db');
const config = require('../../server/config');
const showsModel = require('../../server/models/shows');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

/**
 * The value given for a flag, in either form people type: `--show lna` or
 * `--show=lna`.
 *
 * Only the first used to be understood. `--show=lna` was not the flag, so it
 * was not found, so the script quietly ran against the DEFAULT event — the
 * wrong event, named in the command line as the right one. A flag that is
 * present with no value (`--show` at the end, or followed by another flag) is
 * refused for the same reason, rather than read as "not given".
 */
function valueOf(flag) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v = null;
    if (a.startsWith(`${flag}=`)) v = a.slice(flag.length + 1);
    else if (a === flag) v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : '';
    else continue;
    if (!v.trim()) {
      console.error(`
${flag} needs a value — e.g. ${flag} lna, or ${flag}=lna.`);
      process.exit(2);
    }
    return v.trim();
  }
  return null;
}

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
 * `--show <slug|id>` (or `--show=<slug|id>`) picks the event; without it the
 * deployment's default show is used, which is what a single-event deploy
 * wants. The slug is resolved against the shows table so a typo names no
 * event rather than silently reaching the default one.
 */
async function begin(name) {
  const apply = has('--apply');
  const force = has('--force');
  // Read before connecting, so a malformed flag stops the script before it
  // has touched anything.
  const wanted = valueOf('--show');

  // No index work: a dry run must not write, and see db.connect for what the
  // index work did to the live retention period when a script ran it.
  await connect({ indexes: false });
  await showsModel.refresh();

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

/**
 * What to do once a script has written. The server re-reads an event's stands,
 * areas and tags only when the app itself changes them, so nobody sees what a
 * script did until it restarts — and nothing else here can tell it to.
 */
const RESTART_NOTICE = [
  '',
  '⚠  The running server has not seen this. It serves each event\'s stands, areas and',
  '   tags from memory, so every open plan, the admin console and every new visitor',
  '   still see the event as it was before this ran. Restart the web service now —',
  '   on Render, restart the service; locally, restart node — and check the plan.',
].join('\n');

/**
 * The closing line, so a dry run never reads as a completed one. After an
 * apply it also says to restart; a script whose writes the server does not
 * cache can pass { restart: false }.
 */
function end(apply, { restart = true } = {}) {
  console.log(apply
    ? '\n✔ Applied.'
    : '\n(dry run — nothing was written. Re-run with --apply to make these changes.)');
  if (apply && restart) console.log(RESTART_NOTICE);
}

module.exports = { begin, end, close, has, valueOf, argv, describeUri, RESTART_NOTICE };
