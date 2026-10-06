/**
 * Preloaded (`node -r`) into a real `node server.js` by test/server-process.js,
 * so the process-level suites run the actual server — its Socket.IO options,
 * its shutdown — with the in-memory database in place of MongoDB.
 *
 * Says what it is doing on stdout, where the suite reads it:
 *   "STUB enquiry stored"  when an enquiry's insert completes
 *   "STUB db closed"       when the server closes the database
 *
 * STUB_SLOW_INSERT_MS holds every enquiry's insert open that long, so a suite
 * can stop the server while one is half-way through.
 */
const { fakeDb } = require('./fake-mongo');

const showId = process.env.SHOW_ID || 'LEX';
const db = fakeDb({
  booths: [{ showId, boothNumber: '101', status: 'available', sqm: 9, listPrice: 5400, sponsored: true,
             geometry: { x: 0, y: 0, w: 1, h: 1 }, assignment: { company: null, tags: [] } }],
  users: [{ username: 'chris', role: 'admin', tokenVersion: 0 }],
});

const slow = Number(process.env.STUB_SLOW_INSERT_MS) || 0;
const realCollection = db.collection;
db.collection = (name) => {
  const c = realCollection(name);
  if (name === 'inquiries') {
    const insertOne = c.insertOne;
    c.insertOne = async (doc) => {
      if (slow) await new Promise(r => setTimeout(r, slow));
      const res = await insertOne(doc);
      console.log('STUB enquiry stored');
      return res;
    };
  }
  return c;
};

const dbPath = require.resolve('../server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => db,
  connect: async () => db,
  close: async () => { console.log('STUB db closed'); },
} };
