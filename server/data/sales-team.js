/**
 * The sales team an enquiry can be forwarded to, and the manager who is copied
 * on every forward so nothing is lost.
 *
 * TESTING: every address below is currently chris.cohen@ so forwards land in one
 * inbox while this is being tried out. Replace each `email` with the person's
 * real address when you're ready — that is the only change needed.
 */

const TEAM = [
  { name: 'Tom',     email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Alex',    email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Raymond', email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Chris',   email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Guy',     email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Bailey',  email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Stan',    email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Callum',  email: 'chris.cohen@blueprinteventcompany.com' },
  { name: 'Ben',     email: 'chris.cohen@blueprinteventcompany.com' },
];

// Copied on every forwarded enquiry, so a lead is never lost if the assigned
// person misses it.
const MANAGER = { name: 'Annie', email: 'annie.lindsell@blueprinteventcompany.com' };

const findMember = (name) =>
  TEAM.find(m => m.name.toLowerCase() === String(name || '').toLowerCase().trim()) || null;

module.exports = { TEAM, MANAGER, findMember };
