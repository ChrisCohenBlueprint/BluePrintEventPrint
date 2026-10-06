/**
 * Run a script from scripts/ against the stand-in database.
 *
 *   node -r ./test/script-db.js scripts/migrate.js --show lna
 *
 * Preloaded ahead of the script, this replaces the MongoDB driver's client —
 * not server/db.js — so the script's REAL connect() runs, index work and all.
 * That matters: "a dry run writes nothing" is only worth asserting if the
 * connection the script opens is the one under test, and the index work that
 * connect() does is exactly where a dry run used to write.
 *
 *   FAKE_DB_IN   a JSON file of collections to start from
 *   FAKE_DB_OUT  where to write { store, calls } when the process exits
 *
 * `calls` is every operation in order, index work included, so a test can say
 * both "nothing was written" and "the snapshot came before the delete".
 */
const fs = require('fs');
const mongodb = require('mongodb');
const { fakeDb } = require('./fake-mongo');

const seed = process.env.FAKE_DB_IN ? JSON.parse(fs.readFileSync(process.env.FAKE_DB_IN, 'utf8')) : {};
const base = fakeDb(seed);

const db = {
  collection(name) {
    const c = base.collection(name);
    return { ...c,
      createIndex: async (...a) => { base.calls.push(['createIndex', name, a]); return 'index'; },
      createIndexes: async (...a) => { base.calls.push(['createIndexes', name, a]); return ['index']; },
      dropIndex: async (...a) => { base.calls.push(['dropIndex', name, a]); },
    };
  },
  command: async (cmd) => { base.calls.push(['command', null, cmd]); return { ok: 1 }; },
};

class StandInClient {
  async connect() { return this; }
  db() { return db; }
  async close() {}
}

require.cache[require.resolve('mongodb')].exports = { ...mongodb, MongoClient: StandInClient };

process.on('exit', () => {
  if (process.env.FAKE_DB_OUT) {
    fs.writeFileSync(process.env.FAKE_DB_OUT, JSON.stringify({ store: base.store, calls: base.calls }));
  }
});
