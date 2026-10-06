/**
 * The search narrows, and it does not care how a name was typed.
 *
 * Two ways it got this wrong.
 *
 * A two-letter term matched any stand whose text merely CONTAINED those two
 * letters. "us" is how a visitor asks for the United States, and it lit
 * "Acme Industries"; "de" lit "Golden Delta Trading". The country-code rule
 * that was meant to make two letters precise was added ALONGSIDE the substring
 * match, so it widened the result instead of narrowing it. Two letters now
 * match a country code or a whole word, and nothing else.
 *
 * And the comparison was letter-for-letter. "wurth" — how anyone types it on
 * an English keyboard — missed "Würth"; "cote d'ivoire" missed "Côte d’Ivoire"
 * because the data has a typographic apostrophe and the keyboard a straight
 * one. Both sides are now folded the same way before they are compared.
 */
const { start, openPage, artworkRects, stand, reporter, wait } = require('./floorplan-stub');

const { check, finish } = reporter();

const countries = [
  { code: 'US', name: 'United States', flag: '🇺🇸', aliases: ['USA', 'America'] },
  { code: 'CI', name: 'Côte d’Ivoire', flag: '🇨🇮', aliases: ['Ivory Coast'] },
  { code: 'DE', name: 'Germany', flag: '🇩🇪', aliases: ['Deutschland'] },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', aliases: ['UK', 'Britain'] },
];

(async () => {
  const srv = await start({ countries });
  const { page, errors } = await openPage(srv.browser, `${srv.base}/floorplan`);
  await wait(1200);

  const rects = await artworkRects(page, 30);
  const sold = (i, company, country) => stand(i, rects[i], { status: 'sold', company, country });
  const stands = rects.map((g, i) => stand(i, g));
  stands[0] = sold(0, 'Acme Industries', 'GB');
  stands[1] = sold(1, 'Würth Oil', 'DE');
  stands[2] = sold(2, 'Abidjan Petroleum', 'CI');
  stands[3] = sold(3, 'Liberty Lubes', 'US');
  stands[4] = sold(4, 'Us Lubricants Co', 'GB');
  stands[5] = sold(5, 'D’Arcy Chemicals', 'GB');
  stands[6] = sold(6, 'Golden Delta Trading', 'GB');
  await page.evaluate(s => window.__fire('state:full', s), stands);
  await wait(1200);

  const search = async (q) => {
    await page.fill('#fps-input', '');
    await page.type('#fps-input', q);
    await wait(150);
    return page.evaluate(() => ({
      lit: [...document.querySelectorAll('#svg-mount svg .booth-match')]
        .map(e => e.getAttribute('data-booth')).sort().join(','),
      suggest: [...document.querySelectorAll('#fps-suggest .fps-sg-label')].map(e => e.textContent),
    }));
  };

  console.log('\nTwo letters');
  let r = await search('us');
  check('"us" finds the American stand and a company called "Us"', r.lit === '103,104', r.lit);
  check('but not "Acme Industries"', !r.lit.split(',').includes('100'), r.lit);
  check('nor does it offer it', !r.suggest.includes('Acme Industries'), r.suggest.join(' / '));
  r = await search('de');
  check('"de" finds Germany by its code', r.lit === '101', r.lit);
  check('and not "Golden Delta Trading"', !r.lit.split(',').includes('106'), r.lit);
  r = await search('uk');
  check('a whole word that is not a code still counts — "UK" is an alias',
        r.lit.split(',').includes('100') && !r.lit.split(',').includes('103'), r.lit);

  console.log('\nAccents and apostrophes');
  r = await search('wurth');
  check('"wurth" finds Würth', r.lit === '101', r.lit);
  check('and offers it', r.suggest.includes('Würth Oil'), r.suggest.join(' / '));
  r = await search("cote d'ivoire");
  check('a straight apostrophe finds a country spelt with a curly one', r.lit === '102', r.lit);
  r = await search('cote');
  check('the country is offered without its accent typed',
        r.suggest.some(s => /Côte d’Ivoire/.test(s)), r.suggest.join(' / '));
  r = await search("d'arcy");
  check('and an exhibitor spelt with a curly apostrophe', r.lit === '105', r.lit);

  console.log('\nLonger terms are unchanged');
  r = await search('lub');
  check('three letters still match inside a word', r.lit === '103,104', r.lit);
  r = await search('germany würth');
  check('every term must hit', r.lit === '101', r.lit);

  check('the page raised no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
