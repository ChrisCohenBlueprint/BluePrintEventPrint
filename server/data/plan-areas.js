/**
 * The named areas the floorplan artwork draws in blue — the lounges, the
 * theatres, the conference rooms, the speaker prep room.
 *
 * These are NOT stands. They are not in the booths collection, they carry no
 * price or status, and BoothMap deliberately never binds a stand to them (their
 * fills are outside its ARTWORK_SELECTOR). But they are the most valuable
 * inventory on the plan, and a sponsor who takes one expects to see their logo
 * on it — which is all this file exists to make possible.
 *
 * Geometry is copied from the artwork's own rectangles, so an area is found on
 * the plan the same way a stand is: by matching the rectangle rather than by
 * relying on a fragile element id. The labels could not be read from the file —
 * the artwork converts its text to vector outlines — so they were matched by
 * position and are ADMIN-EDITABLE for exactly that reason: a wrong guess is a
 * rename, not a redeploy.
 *
 * Listed in reading order down the plan, which is the order the admin sees.
 */
const AREAS = [
  { key: 'conference-track-2',    label: 'Conference Track 2',      geometry: { x: 1450.7,  y: 211.93,  w: 161.57, h: 228.9  } },
  { key: 'discovery-theatre',     label: 'Discovery Theatre',       geometry: { x: 1068.39, y: 691.54,  w: 160.41, h: 119.64 } },
  { key: 'vip-lounge',            label: 'VIP Lounge',              geometry: { x: 616.17,  y: 839.65,  w: 188.5,  h: 107.72 } },
  { key: 'networking-lounge-west', label: 'Networking Lounge (West)', geometry: { x: 400.73,  y: 1243.58, w: 107.72, h: 94.25  } },
  { key: 'networking-lounge-east', label: 'Networking Lounge (East)', geometry: { x: 1356.72, y: 1243.58, w: 121.18, h: 107.72 } },
  { key: 'conference-track-1',    label: 'Conference Track 1',      geometry: { x: 278.88,  y: 1498.74, w: 188.5,  h: 255.83 } },
  { key: 'speaker-prep',          label: 'Speaker Prep',            geometry: { x: 144.23,  y: 1553.27, w: 67.32,  h: 134.65 } },
];

const KEYS = new Set(AREAS.map(a => a.key));
const isValid = (key) => KEYS.has(String(key || ''));
const get = (key) => AREAS.find(a => a.key === key) || null;

module.exports = { AREAS, KEYS, isValid, get };
