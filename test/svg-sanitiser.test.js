/**
 * The uploaded artwork is made safe by what a browser would make of it.
 *
 * The sanitiser was a handful of regular expressions that matched the tidy
 * form of each dangerous thing. A browser is far more forgiving, and five forms
 * went straight through — reported to the admin as an unchanged file:
 *
 *   <rect/onload="…">                 a slash where the space would be
 *   <image src=x/onerror=…>           the same, unquoted
 *   <script>alert(1)                  never closed
 *   <foreignObject><iframe …>         never closed
 *   href="javascr&#105;pt:…"          a character reference
 *
 * What is asserted here:
 *
 *   real artwork  — every SVG shipped in public/ and the test fixture comes
 *                   out byte for byte as it went in, with nothing reported,
 *                   exactly as it did under the old sanitiser.
 *   each bypass   — is removed, and named in the report.
 *   a browser     — Chrome, given the cleaned markup both as the page inlines
 *                   it (innerHTML) and as a standalone SVG (XML), builds no
 *                   script, no foreignObject, no handler and no javascript:
 *                   link, and runs nothing; given the raw markup, it does.
 *   a hostile file — cannot make the sanitiser take long.
 */
const fs = require('fs');
const path = require('path');
const { sanitise } = require('../server/models/floorplans');
const { launch } = require('./harness');

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const ROOT = path.join(__dirname, '..');

// Each case, what it is, and the label the report must give it.
const CASES = [
  ['slash before a handler',        '<svg><rect/onload="alert(1)" width="10" height="10"/></svg>', 'inline event handlers'],
  ['slash, unquoted',               '<svg><image src=x/onerror=alert(1)></svg>', 'inline event handlers'],
  ['handler after a quoted value',  '<svg><image href="x"/onerror="alert(1)"/></svg>', 'inline event handlers'],
  ['unclosed script',               '<svg><script>alert(1)', 'script blocks'],
  ['unclosed foreignObject',        '<svg><foreignObject><iframe src=javascript:alert(1)></iframe>', 'foreignObject'],
  ['entity-encoded javascript:',    '<svg><a href="javascr&#105;pt:alert(1)"><text>x</text></a></svg>', 'javascript: links'],
  ['tab inside the scheme',         '<svg><a xlink:href="java&#x09;script:alert(1)"><text>x</text></a></svg>', 'javascript: links'],
  ['animated into a link',          '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>', 'javascript: links'],
  ['rebuilt by the removal',        '<svg><scr<script></script>ipt>alert(1)</script></svg>', 'script blocks'],
  ['namespaced script',             '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>', 'script blocks'],
  ['comment closed by --!>',        '<svg><!-- --!><image href="x" onerror="alert(1)"/> --></svg>', 'inline event handlers'],
  ['inside text a CDATA hides',     '<svg><![CDATA[ > <a title=" ]]> <image href="x" onerror="alert(1)"/> <!-- " --></svg>', 'inline event handlers'],
  ['an iframe document',            '<iframe srcdoc="&lt;script&gt;parent.alert(1)&lt;/script&gt;"></iframe><svg></svg>', 'embedded documents'],
  ['markup in an XML entity',       '<!DOCTYPE svg [<!ENTITY x "&#60;script xmlns=&#34;http://www.w3.org/2000/svg&#34;&#62;alert(1)&#60;/script&#62;">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>', 'entity declarations'],
  ['an XSLT stylesheet',            '<?xml-stylesheet type="text/xsl" href="evil.xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'stylesheet instructions'],
];

// The cases whose raw markup Chrome does NOT turn into something runnable
// here, so the check that the raw markup is live skips them. Each is removed
// anyway:
//  - Chrome reads `src=x/onerror=…` as one unquoted value. It is written to
//    pass for two attributes, and nothing honest is written that way.
//  - "rebuilt by the removal" is harmless as uploaded; the danger is the
//    <script> the OLD sanitiser assembled by cutting out the middle of it.
//  - an XSLT instruction runs when the SVG is opened on its own, which
//    DOMParser does not imitate.
const NOT_LIVE = new Set(['slash, unquoted', 'rebuilt by the removal', 'an XSLT stylesheet']);

(async () => {
  console.log('\nReal artwork is untouched');
  const shipped = [
    ...fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.svg')).map(f => path.join('public', f)),
    ...fs.readdirSync(path.join(ROOT, 'public', 'sponsors')).filter(f => f.endsWith('.svg')).map(f => path.join('public', 'sponsors', f)),
    ...fs.readdirSync(path.join(__dirname, 'fixtures')).filter(f => f.endsWith('.svg')).map(f => path.join('test', 'fixtures', f)),
  ];
  for (const f of shipped) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const r = sanitise(text);
    check(`${f} comes out byte for byte, nothing reported`, r.svg === text && r.removed.length === 0,
          r.removed.join(', '));
  }
  const tidy = sanitise('<svg><rect width="1" onclick="go()" height="2"/></svg>');
  check('a handler in a tidy file leaves it tidy',
        tidy.svg === '<svg><rect width="1" height="2"/></svg>', tidy.svg);
  const text = sanitise('<svg><text>Hall 1 &lt; Hall 2: see http://example.com</text><a href="https://example.com/">x</a></svg>');
  check('text and ordinary links are left alone', text.removed.length === 0);

  console.log('\nEach way past the old sanitiser');
  const cleaned = CASES.map(([name, raw, label]) => {
    const r = sanitise(raw);
    check(`${name}: reported as ${label}`, r.removed.includes(label), `${JSON.stringify(r.svg)} [${r.removed.join(', ')}]`);
    return { name, raw, clean: r.svg };
  });

  console.log('\nA file built to defeat the passes');
  const deep = '<svg><text>x</text>' + '<scr'.repeat(15) + '<script></script>' + 'ipt></script>'.repeat(15) + '</svg>';
  const d = sanitise(deep);
  check('is made inert outright, and says so',
        !/</.test(d.svg) && d.removed.some(x => /could not be read safely/.test(x)), d.removed.join(', '));

  console.log('\nA hostile file cannot make it slow');
  const MB = 1 << 20;
  for (const [name, big] of [
    ['a run of "<a<a<a…"', '<a'.repeat(2 * MB) + ' onload=x>'],
    ['a million unclosed scripts', '<script>'.repeat(MB)],
    ['a million open quotes', '<a b="'.repeat(MB)],
    ['four million attributes', '<a ' + 'b '.repeat(4 * MB) + '>'],
  ]) {
    const t = Date.now();
    sanitise(big);
    const ms = Date.now() - t;
    check(`${name} (${(big.length / MB).toFixed(0)} MB) is read in seconds, not minutes`, ms < 5000, `${ms} ms`);
  }

  console.log('\nWhat Chrome makes of it');
  const br = await launch();
  try {
    const page = await br.newPage();
    let dialogs = 0;
    page.on('dialog', (dl) => { dialogs++; dl.dismiss().catch(() => {}); });
    await page.setContent('<!doctype html><html><body></body></html>');
    // Everything the browser built that could run something, read off the DOM.
    const inspect = (markup, mode) => page.evaluate(async ([markup, mode]) => {
      let root;
      if (mode === 'html') {
        root = document.createElement('div');
        document.body.appendChild(root);
        root.innerHTML = markup;
        await new Promise(r => setTimeout(r, 60));   // let an onerror fire, if there is one
      } else {
        root = new DOMParser().parseFromString(markup, 'image/svg+xml');
        if (root.querySelector('parsererror')) return [];   // not XML: nothing is drawn at all
      }
      const found = [];
      for (const el of root.querySelectorAll('*')) {
        const ln = el.localName.toLowerCase();
        if (ln === 'script' || ln === 'foreignobject') found.push(ln);
        for (const a of el.attributes) {
          const n = a.localName.toLowerCase();
          if (n.startsWith('on') || n === 'srcdoc') found.push(n);
          if (/(java|vb)script:/i.test(a.value.replace(/[\u0000-\u0020\u007f]/g, ''))) found.push(`${n}=javascript:`);
        }
      }
      if (mode === 'html') root.remove();
      return found;
    }, [markup, mode]);

    for (const c of cleaned) {
      const raw = [...await inspect(c.raw, 'html'), ...await inspect(c.raw, 'xml')];
      const clean = [...await inspect(c.clean, 'html'), ...await inspect(c.clean, 'xml')];
      if (!NOT_LIVE.has(c.name)) check(`${c.name}: is live as uploaded`, raw.length > 0, raw.join(', '));
      check(`${c.name}: nothing executable once cleaned`, clean.length === 0, clean.join(', '));
    }

    const before = dialogs;
    for (const c of cleaned) await inspect(c.clean, 'html');
    check('and the cleaned markup runs nothing when inlined', dialogs === before, `${dialogs - before} ran`);
    dialogs = 0;
    for (const c of cleaned) await inspect(c.raw, 'html');
    check('which the raw markup did', dialogs > 0, `${dialogs} ran`);
  } finally {
    await br.close();
  }

  const f = out.filter(x => !x).length;
  console.log(`\n${f ? `${f} FAILED` : 'ALL PASSED'} (${out.length} checks)`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
