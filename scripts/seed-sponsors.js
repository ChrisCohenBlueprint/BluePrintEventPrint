#!/usr/bin/env node
/**
 * Seed the sponsorship catalogue from the LEX26 sponsorship menu.
 *
 * Prices live here (server side) and are served only to the admin. The public
 * floorplan receives a price-free projection — sales walk the buyer through
 * cost, so the buyer never sees it in the enquiry flow.
 *
 * `image` and `video` are left blank for Blueprint to fill: drop a file into
 * public/sponsors/ and set the path, or paste an external URL. Re-running this
 * script preserves any media and availability you have edited in admin.
 *
 *   node scripts/seed-sponsors.js
 */
const { connect, getDb, close } = require('../server/db');
const config = require('../server/config');

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

async function main() {
  await connect();
  const db = getDb();
  const col = db.collection('sponsors');
  await col.createIndex({ showId: 1, key: 1 }, { unique: true });

  let inserted = 0, updated = 0;
  for (const s of CATALOGUE) {
    const res = await col.updateOne(
      { showId: config.showId, key: s.key },
      { // Catalogue fields are refreshed from this file; media, availability
        // overrides and active flag set in admin are preserved on re-run.
        $set: { name: s.name, tier: s.tier, price: s.price, blurb: s.blurb, perks: s.perks },
        $setOnInsert: {
          showId: config.showId, key: s.key,
          availability: s.availability, active: true,
          image: '', video: '',
          createdAt: new Date(),
        } },
      { upsert: true }
    );
    if (res.upsertedCount) inserted++; else if (res.modifiedCount) updated++;
  }

  const total = await col.countDocuments({ showId: config.showId });
  console.log(`✅ Sponsors — ${inserted} inserted, ${updated} updated (${total} total)`);
  console.log('   Prices are admin-only. Add photos/videos per sponsor in admin or by');
  console.log('   dropping files into public/sponsors/ and setting image/video paths.');
  await close();
}

main().catch(e => { console.error('Seed failed:', e); process.exit(1); });
