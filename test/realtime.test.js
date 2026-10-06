/**
 * Consent and the public socket events, driven through a real Socket.IO server.
 *
 *   consent    — session:adopt had no rate limit and stored a consent.granted
 *                row on every call; one anonymous socket looping it filled the
 *                activity buffer. It is now limited, and consent is recorded
 *                once per socket and once per visitor across their sockets —
 *                the page re-sends it on every connect.
 *   withdrawn  — withdrawing consent stops this socket being tracked at all,
 *                down to the dwell that used to be written on disconnect.
 *   artwork    — an admin, who is in both rooms, hears "the plan changed" once.
 */
const { db, boot, wait, reporter } = require('./socket-harness');
const showContext = require('../server/show-context');
const sockets = require('../server/sockets');
const tracking = require('../server/services/tracking');

const { check, finish } = reporter();
const hex = (c) => c.repeat(32);
const activity = (filter = {}) => (db.store.activity || []).filter(d =>
  Object.entries(filter).every(([k, v]) => d[k] === v));
const BEHAVIOUR = ['booth.view', 'booth.click', 'booth.dwell', 'plan.zoom'];

(async () => {
  const { client, close } = await boot();

  try {
    console.log('\nsession:adopt is limited, and consent is recorded once');
    const sid = hex('a');
    const v = await client({ sessionId: sid, ip: '198.51.100.1' });
    for (let i = 0; i < 2000; i++) v.emit('session:adopt', { sessionId: sid });
    await wait(400);
    await tracking.flush();
    check('one consent.granted for 2,000 adopts', activity({ type: 'consent.granted', sessionId: sid }).length === 1,
          String(activity({ type: 'consent.granted', sessionId: sid }).length));
    check('one session.start', activity({ type: 'session.start', sessionId: sid }).length === 1);
    check('and nothing left queued that could crowd anything out', tracking.stats().pending === 0 &&
          (db.store.activity || []).length < 10, String((db.store.activity || []).length));

    const again = await client({ sessionId: sid, ip: '198.51.100.1' });
    again.emit('session:adopt', { sessionId: sid });   // buffered while offline …
    again.emit('session:adopt', { sessionId: sid });   // … and again on connect
    await wait(100); await tracking.flush();
    check('a reconnect of the same visitor does not record consent again',
          activity({ type: 'consent.granted', sessionId: sid }).length === 1);
    again.disconnect();

    console.log('\nWithdrawing consent stops tracking that socket');
    const sid2 = hex('b');
    const w = await client({ sessionId: sid2, ip: '198.51.100.2' });
    w.emit('session:adopt', { sessionId: sid2 });
    w.emit('booth:view', { boothNumber: '101' });
    await wait(80);
    w.emit('consent:withdrawn');
    await wait(50);
    w.emit('booth:view', { boothNumber: '102' });
    w.emit('booth:click', { boothNumber: '103' });
    w.emit('plan:zoom', { level: 2, cx: 1, cy: 1 });
    await wait(80);
    w.disconnect();
    await wait(80); await tracking.flush();
    const views = activity({ type: 'booth.view', sessionId: sid2 });
    check('the view before withdrawing was recorded', views.length === 1 && views[0].boothNumber === '101');
    const after = (db.store.activity || []).filter(d => BEHAVIOUR.includes(d.type) && d.ts > views[0].ts);
    check('nothing after it — no view, click, zoom, nor a dwell on disconnect', after.length === 0,
          JSON.stringify(after.map(a => [a.type, a.boothNumber, a.sessionId])));
    check('nor anything under a null session', !(db.store.activity || []).some(d => BEHAVIOUR.includes(d.type) && !d.sessionId));
    const sid3 = hex('e');
    const back = await client({ sessionId: sid3, ip: '198.51.100.2' });
    back.emit('consent:withdrawn');
    back.emit('session:adopt', { sessionId: sid3 });
    back.emit('booth:view', { boothNumber: '102' });
    await wait(80); await tracking.flush();
    check('consenting again on the same socket tracks again',
          activity({ type: 'booth.view', sessionId: sid3 }).length === 1 &&
          activity({ type: 'consent.granted', sessionId: sid3 }).length === 1);

    console.log('\nAn admin hears that the plan changed once');
    const admin = await client({ admin: true });
    const heard = { admin: 0, visitor: 0 };
    admin.on('floorplan:changed', () => heard.admin++);
    v.on('floorplan:changed', () => heard.visitor++);
    showContext.runAs('LEX', () => sockets.notifyArtwork('v2'));
    await wait(150);
    check('the admin once, not twice', heard.admin === 1, String(heard.admin));
    check('the visitor once', heard.visitor === 1, String(heard.visitor));
  } catch (e) {
    check('suite ran without throwing', false, e.stack);
  } finally {
    close();
  }
  finish();
})();
