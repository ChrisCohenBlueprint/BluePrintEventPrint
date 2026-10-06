#!/usr/bin/env node
/**
 * Seed an event's sponsorship catalogue from the LEX26 sponsorship menu.
 *
 * Prices live here (server side) and are served only to the admin. The public
 * floorplan receives a price-free projection — sales walk the buyer through
 * cost, so the buyer never sees it in the enquiry flow.
 *
 * `image` and `video` are left blank for Blueprint to fill in the admin.
 *
 * It used to write on every run, to the default event only, and every run
 * $set the name, tier, blurb and perks of every package in this file —
 * quietly reverting whatever the admin or a CSV import had changed since —
 * and re-created every package someone had deleted. It also created its own
 * unnamed unique index, which clashes with the server's `show_sponsor_unique`
 * on any database the server has booted against. Now:
 *
 *   - it is a dry run until --apply, and --show picks the event;
 *   - on an event with NO catalogue it adds this one;
 *   - on an event that has one, it changes nothing by default. A package in
 *     this file that the event lacks may have been deleted on purpose, so it
 *     is only added with --add-missing; an existing package is only reset to
 *     this file's name, tier, description and perks with --overwrite. Price,
 *     availability, media and sold-out state are never overwritten;
 *   - it creates no index. The server creates the one it relies on at boot.
 *
 *   node scripts/seed-sponsors.js                        what it would do
 *   node scripts/seed-sponsors.js --show lna --apply     seed a named event
 *   --add-missing                                        also add packages this event lacks
 *   --overwrite                                          also reset existing packages' wording to this file
 */
const { begin, end, close, has } = require('./lib/run');
const showContext = require('../server/show-context');
const sponsors = require('../server/models/sponsors');

// tier drives the card colour on the public plan; price drives the ranking and
// is admin-only. perks are the buyer-facing bullet points.
const CATALOGUE = [
  { key: 'conference', name: 'Conference Sponsorship', tier: 'platinum', price: 39950, availability: 'Exclusive',
    blurb: 'Own the conference stages across all three days.',
    perks: ['Branding on every conference stage & holding slide', 'Sponsor’s welcome address on Day 1',
            'Full scanned data of all conference attendees', '20 VIP passes', 'Full-page Show Guide advert'] },
  { key: 'vip-opening', name: 'VIP Lounge & Opening Night Reception', tier: 'platinum', price: 39950, availability: 'Exclusive',
    blurb: 'The VIP lounge plus the opening-night networking reception.',
    perks: ['Exclusive VIP lounge branding', 'Host the opening-night reception', 'Complimentary drinks for all VIPs & speakers',
            'Full scanned VIP lounge data', '20 VIP passes'] },
  { key: 'networking-lounge', name: 'Networking Lounge', tier: 'platinum', price: 34950, availability: '2 Available',
    blurb: 'A branded lounge for visitors to relax and meet.',
    perks: ['Your branding throughout the lounge', 'Furniture & carpet in your colours', 'Exclusive materials distribution',
            '20 VIP passes', 'Pairs well with the Networking Reception'] },
  { key: 'registration', name: 'Registration', tier: 'platinum', price: 29950, availability: 'Exclusive',
    blurb: 'Your brand on every visitor’s first touchpoint.',
    perks: ['Your brand on the registration form', 'Onsite registration-area branding', 'Data of opted-in pre-registered attendees',
            '20 VIP passes', 'Full-page Show Guide advert'] },

  { key: 'vip-lounge', name: 'VIP Lounge', tier: 'gold', price: 29950, availability: 'Exclusive',
    blurb: 'Exclusive branding within the VIP lounge.',
    perks: ['Exclusive VIP lounge branding', 'Lounge colours matched to your brand', 'Full scanned VIP lounge data',
            'Unlimited VIP invitations', 'Show Guide advert'] },
  { key: 'networking-reception', name: 'Networking Reception', tier: 'gold', price: 24950, availability: '2 Available',
    blurb: 'Host the drinks reception for the whole show.',
    perks: ['Complimentary drinks for all attendees', 'Host on your stand or the lounge', 'Bespoke invitations for special guests',
            '10 VIP passes', 'Pairs well with the Networking Lounge'] },
  { key: 'lanyards', name: 'Lanyards', tier: 'gold', price: 19950, availability: 'Exclusive',
    blurb: 'Your brand around every attendee’s neck.',
    perks: ['Sponsor-designed lanyard for every attendee', 'Guaranteed presence in event photography', '10 VIP passes', 'Show Guide advert'] },
  { key: 'show-guide', name: 'Show Guide', tier: 'gold', price: 19950, availability: 'Exclusive',
    blurb: 'Front cover and full back cover of the printed guide.',
    perks: ['Logo on the show guide front cover', 'Exclusive full back-cover advert'] },
  { key: 'show-app', name: 'Show App', tier: 'gold', price: 19950, availability: 'Exclusive',
    blurb: 'Own the show app splash screen and dashboard.',
    perks: ['Logo on the app splash page', 'Dashboard logo with active link', 'Inside-front-cover Show Guide advert',
            'Pre- and post-event exposure'] },
  { key: 'badges', name: 'Badges', tier: 'gold', price: 16950, availability: 'Exclusive',
    blurb: 'Your logo on every badge at the show.',
    perks: ['Logo on every attendee badge', 'Worn by all participants for guaranteed coverage', '10 VIP passes', 'Show Guide advert'] },
  { key: 'coffee', name: 'Coffee Morning Refreshments', tier: 'gold', price: 14950, availability: 'Exclusive',
    blurb: 'Greet arriving visitors with morning coffee.',
    perks: ['Host morning refreshments at your stand or a networking area', 'Signage on the show floor',
            '10 VIP passes', 'Show Guide advert'] },

  { key: 'bags', name: 'Bags', tier: 'silver', price: 12950, availability: 'Exclusive',
    blurb: 'Branded bags handed out at registration.',
    perks: ['Exclusive bag distribution at registration', 'Guaranteed presence in event photography', '5 VIP passes'] },
  { key: 'floorplan', name: 'Floorplan', tier: 'silver', price: 9950, availability: '20 Available',
    blurb: 'Your stand highlighted across every floorplan.',
    perks: ['Branding on online, onsite & Show Guide floorplans', 'Your stand highlighted prominently',
            'Banner advert on the Show Guide floorplan', '5 VIP passes'] },
  { key: 'speakers-lounge', name: 'Speakers’ Lounge', tier: 'silver', price: 5950, availability: 'Exclusive',
    blurb: 'Exclusive access to 75+ industry leaders.',
    perks: ['Branding in the Speakers’ Lounge', 'Offer goodie bags to every speaker', '5 VIP passes'] },
];

const WORDING = ['name', 'tier', 'blurb', 'perks'];
const sameWording = (a, b) => WORDING.every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));

async function main() {
  const { apply, showId, db } = await begin('Seed the sponsorship catalogue');
  const addMissing = has('--add-missing');
  const overwrite  = has('--overwrite');

  await showContext.runAs(showId, async () => {
    const existing = await sponsors.all();
    const byKey = new Map(existing.map(s => [s.key, s]));
    const names = new Map(existing.map(s => [String(s.name || '').trim().toLowerCase(), s.key]));
    const empty = existing.length === 0;

    const missing = CATALOGUE.filter(s => !byKey.has(s.key));
    // Names are unique within an event (a CSV without keys matches on them),
    // so a missing package whose name another package already has is skipped.
    const clash = missing.filter(s => names.has(s.name.toLowerCase()));
    const adding = (empty || addMissing) ? missing.filter(s => !clash.includes(s)) : [];
    const resetting = overwrite
      ? CATALOGUE.filter(s => byKey.has(s.key) && !sameWording(byKey.get(s.key), s))
      : [];

    console.log(`  ${existing.length} package(s) in this event's catalogue, ${CATALOGUE.length} in this file`);
    console.log(`  ${adding.length} to add${adding.length ? `: ${adding.map(s => s.key).join(', ')}` : ''}`);
    if (!empty && !addMissing && missing.length) {
      console.log(`  ${missing.length} in this file but not in the event, NOT added — they may have been deleted on purpose:`);
      console.log(`    ${missing.map(s => s.key).join(', ')}`);
      console.log('    (--add-missing adds them)');
    }
    for (const s of clash) console.log(`  skipped ${s.key}: the name "${s.name}" is already used by "${names.get(s.name.toLowerCase())}"`);
    if (overwrite) {
      console.log(`  ${resetting.length} existing package(s) to reset to this file's name, tier, description and perks`);
      for (const s of resetting) {
        const cur = byKey.get(s.key);
        console.log(`    ${s.key.padEnd(22)} "${cur.name}" (${cur.tier}) → "${s.name}" (${s.tier})`);
      }
    } else {
      const differ = CATALOGUE.filter(s => byKey.has(s.key) && !sameWording(byKey.get(s.key), s)).length;
      if (differ) console.log(`  ${differ} existing package(s) differ from this file and are left as edited (--overwrite resets them)`);
    }

    if (!apply) { end(false); return; }

    let added = 0;
    for (const s of adding) {
      // Through the model, so a seeded package is validated exactly as one
      // added in the admin, and a key that appeared meanwhile is refused.
      const r = await sponsors.create({ ...s, active: true, soldOut: false });
      if (r.ok) added++;
      else console.log(`  not added ${s.key}: ${r.error}`);
    }
    for (const s of resetting) {
      await db.collection('sponsors').updateOne({ showId, key: s.key },
        { $set: { name: s.name, tier: s.tier, blurb: s.blurb, perks: s.perks, updatedAt: new Date() } });
    }
    console.log(`\n  ${added} added, ${resetting.length} reset`);
    end(true);
  });

  await close();
}

main().catch(e => { console.error('Seed failed:', e); process.exit(1); });
