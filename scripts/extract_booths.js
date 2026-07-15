/**
 * extract_booths.js
 * 
 * Parses the LEX26 SVG floorplan and extracts booth spatial data.
 * 
 * Strategy:
 * - Every booth shape (cls-11, cls-13, cls-14) has an x/y/width/height in SVG units
 * - Every cls-1 rect (fill:none) is a text bounding box — we use these to estimate
 *   which text belongs to which booth based on proximity
 * - The sqm number is always in the BOTTOM-RIGHT corner of each booth
 * - We look for cls-1 rects whose bottom-right corner sits inside or very near a booth
 *
 * Output: public/booth_data.json
 * Schema: { boothIndex: { x, y, w, h, sqm, status, boothId } }
 */

const fs   = require('fs');
const path = require('path');

// ─── Parse SVG manually (no external deps needed) ────────────────────────────
const svgPath = path.join(__dirname, '../public/LEX26_Floorplan_Web-Format_57.svg');
const svgText = fs.readFileSync(svgPath, 'utf8');

// Extract all rect elements with their class and position
function parseRects(svg) {
  const rects = [];
  // Match <rect class="..." x="..." y="..." width="..." height="..."/>
  const rectRe = /<rect([^>]+)\/>/g;
  let m;
  while ((m = rectRe.exec(svg)) !== null) {
    const attrs = m[1];
    const cls   = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
    const x     = parseFloat((attrs.match(/\bx="([^"]+)"/)     || [0,0])[1]);
    const y     = parseFloat((attrs.match(/\by="([^"]+)"/)     || [0,0])[1]);
    const w     = parseFloat((attrs.match(/width="([^"]+)"/)   || [0,0])[1]);
    const h     = parseFloat((attrs.match(/height="([^"]+)"/)  || [0,0])[1]);
    rects.push({ cls, x, y, w, h });
  }
  return rects;
}

const allRects = parseRects(svgText);

// Separate booth shapes from text-bounding-box rects
const boothRects = allRects.filter(r =>
  r.cls.includes('cls-11') || r.cls.includes('cls-13') || r.cls.includes('cls-14')
);
const textBoxRects = allRects.filter(r => r.cls.includes('cls-1') && r.w > 0 && r.h > 0);

console.log(`Found ${boothRects.length} booth shapes, ${textBoxRects.length} text bounding boxes`);

// ─── For each booth, find text boxes whose centre falls within the booth ──────
// The sqm number sits in the bottom-right; we look for the SMALLEST number-like
// text box near that corner (small rects = single short number like "21" or "48")
function findSqmBox(booth, textBoxes) {
  const candidates = textBoxes.filter(tb => {
    const tbCx = tb.x + tb.w / 2;
    const tbCy = tb.y + tb.h / 2;
    // Centre of text box must be within the booth bounds (with 5px tolerance)
    return (
      tbCx >= booth.x - 5 && tbCx <= booth.x + booth.w + 5 &&
      tbCy >= booth.y - 5 && tbCy <= booth.y + booth.h + 5
    );
  });

  if (candidates.length === 0) return null;

  // The sqm box is the one closest to the bottom-right corner of the booth
  const brX = booth.x + booth.w;
  const brY = booth.y + booth.h;

  candidates.sort((a, b) => {
    const aDist = Math.hypot((a.x + a.w) - brX, (a.y + a.h) - brY);
    const bDist = Math.hypot((b.x + b.w) - brX, (b.y + b.h) - brY);
    return aDist - bDist;
  });

  return candidates[0];
}

// ─── Estimate sqm from text box size ─────────────────────────────────────────
// Text boxes for numbers like "9", "18", "21", "48" have different widths.
// We calibrate by the ratio of text box area to known booth area.
// Fallback: use booth area calibration.
function estimateSqmFromBooth(booth) {
  // SVG viewbox is 2594×2402 units
  // The full expo floor area is approximately 2130×1994 SVG units = ~4,247,220 sq units
  // LEX26 floor is roughly 15,000 sqm in real life
  // So 1 sqm ≈ 283 SVG units²
  const areaSvgUnits = booth.w * booth.h;
  const sqm = Math.round(areaSvgUnits / 283);
  return Math.max(9, Math.min(300, sqm));
}

// ─── Build output data ────────────────────────────────────────────────────────
const boothData = {};
let availIdx = 1;
let takenIdx = 1000; // taken booths start at 1000 to separate

// Available (white) booths
const whiteBooths = boothRects.filter(r => r.cls.includes('cls-13'));
whiteBooths.forEach(booth => {
  const boothId = `booth-${String(availIdx).padStart(3, '0')}`;
  const sqm = estimateSqmFromBooth(booth);

  boothData[boothId] = {
    boothId,
    status: 'available',
    x: Math.round(booth.x),
    y: Math.round(booth.y),
    w: Math.round(booth.w),
    h: Math.round(booth.h),
    sqm,
    price: sqm * 600
  };

  availIdx++;
});

// Taken (yellow) booths
const yellowBooths = boothRects.filter(r => r.cls.includes('cls-11') || r.cls.includes('cls-14'));
yellowBooths.forEach(booth => {
  const boothId = `booth-${String(takenIdx).padStart(4, '0')}`;
  const sqm = estimateSqmFromBooth(booth);

  boothData[boothId] = {
    boothId,
    status: 'sold',
    x: Math.round(booth.x),
    y: Math.round(booth.y),
    w: Math.round(booth.w),
    h: Math.round(booth.h),
    sqm,
    price: sqm * 600
  };

  takenIdx++;
});

// ─── Write output ─────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, '../public/booth_data.json');
fs.writeFileSync(outPath, JSON.stringify(boothData, null, 2));

const available = Object.values(boothData).filter(b => b.status === 'available').length;
const taken     = Object.values(boothData).filter(b => b.status === 'sold').length;

console.log(`\n✅ booth_data.json written:`);
console.log(`   Available booths: ${available}`);
console.log(`   Taken booths:     ${taken}`);
console.log(`   Total:            ${available + taken}`);
console.log(`\nSample available booths:`);
Object.values(boothData).filter(b => b.status === 'available').slice(0, 5).forEach(b => {
  console.log(`  ${b.boothId}: ${b.sqm}m² → €${b.price.toLocaleString()}`);
});
