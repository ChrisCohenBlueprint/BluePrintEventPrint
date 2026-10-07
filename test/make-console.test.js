/**
 * Make, from the console: connect it, test it, and see per lead whether an
 * enquiry reached it.
 *
 *   - Settings carries one "Enquiries to Make" card: the owner pastes the Make
 *     webhook address and saves it; anyone can send a test enquiry so Make can
 *     learn the fields; enquiries Make has not taken are counted there.
 *   - An admin who is not the owner sees whether it is connected, not a field
 *     to change where every visitor's details go.
 *   - Each lead says whether it was sent to Make, why not if it was not, and
 *     sends it again on request — asking first when Make already has it.
 *   - The link Make puts on the Salesforce lead opens the console on that lead.
 */
const { startConsole, seedStands, toasts, checker, launch } = require('./admin-console-harness');

const { check, finish } = checker();

const LEAD = '6702f1c0a1b2c3d4e5f60718';
let hook = { connected: false, url: null, source: null, editable: true, retrying: 0, gaveUp: 1, lastSentAt: null };
const puts = [], tests = [], delivers = [];
let lead = {
  _id: LEAD, showId: 'LEX', status: 'new', createdAt: '2026-10-07T09:00:00Z',
  contact: { name: 'Ana Silva', email: 'ana@example.com', company: 'Silva Oils' },
  boothsOfInterest: ['101'], sponsorsOfInterest: [], areasOfInterest: [], history: [],
  delivery: { status: 'failed', attempts: 8, error: 'Make answered 410 — There is no scenario listening for this webhook',
              nextAttemptAt: null, lastAttemptAt: '2026-10-07T09:00:05Z' },
};

(async () => {
  const { server, base } = await startConsole({ stands: seedStands(10), routes(app) {
    app.get('/api/integrations/enquiry-webhook', (_q, res) => res.json(hook));
    app.put('/api/integrations/enquiry-webhook', (req, res) => {
      puts.push(req.body);
      const url = String(req.body.url || '');
      if (url && !/^https:\/\//.test(url)) return res.status(400).json({ error: 'The address must start with https://' });
      hook = { ...hook, connected: !!url, url: url || null, source: url ? 'settings' : null };
      res.json({ ok: true, connected: !!url });
    });
    app.post('/api/integrations/enquiry-webhook/test', (req, res) => { tests.push(1); res.json({ ok: true, to: 'hook.eu1.make.com', status: 200 }); });
    app.get('/api/inquiries', (_q, res) => res.json([{ ...lead, history: undefined }]));
    app.get(`/api/inquiries/${LEAD}`, (_q, res) => res.json(lead));
    app.post(`/api/inquiries/${LEAD}/deliver`, (_q, res) => {
      delivers.push(1);
      lead = { ...lead, delivery: { status: 'sent', attempts: 9, sentAt: '2026-10-07T10:15:00Z', error: null, nextAttemptAt: null } };
      res.json({ ok: true, delivery: lead.delivery });
    });
  } });

  const br = await launch();
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  const card = () => page.$eval('#make-card', n => n.textContent.replace(/\s+/g, ' '));

  try {
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });

    console.log('\nSettings: connecting Make');
    await page.click('[data-section="settings"]');
    await page.waitForSelector('#make-card:not([hidden]) .plan-name');
    check('the card is there, saying it is not connected', /Enquiries to Make/.test(await card()) && /Not connected/.test(await card()), (await card()).slice(0, 140));
    check('and that an enquiry could not be delivered', /1 enquiry could not be delivered/.test(await card()), (await card()).slice(0, 140));
    await page.fill('#make-card input[type=url]', 'http://hook.eu1.make.com/abc');
    await page.click('#make-card button:has-text("Save")');
    await page.waitForTimeout(300);
    check('an address the server refuses is explained', /https/.test(await toasts(page)), await toasts(page));
    await page.fill('#make-card input[type=url]', 'https://hook.eu1.make.com/abc123');
    await page.click('#make-card button:has-text("Save")');
    await page.waitForFunction(() => /Connected/.test(document.getElementById('make-card').textContent) &&
                                     !/Not connected/.test(document.getElementById('make-card').textContent));
    check('the owner saves it and the card says connected', puts[puts.length - 1].url === 'https://hook.eu1.make.com/abc123', JSON.stringify(puts));
    await page.click('#make-card button:has-text("Send a test enquiry")');
    await page.waitForTimeout(300);
    check('a test enquiry is sent, and the toast says where', tests.length === 1 && /hook\.eu1\.make\.com/.test(await toasts(page)), await toasts(page));
    check('the setup steps and field mapping are on the card', /leadLastName/.test(await card()) && /Redetermine data structure/.test(await card()));

    console.log('\nA lead says whether it reached Make');
    await page.click('[data-section="leads"]');
    await page.waitForSelector('#leads-list .lead-item, #leads-list [data-id], #leads-list > *');
    await page.evaluate((id) => openLead(id), LEAD);
    await page.waitForSelector('.lead-make:not([hidden]) button');
    const line = await page.$eval('.lead-make', n => n.textContent.replace(/\s+/g, ' '));
    check('a lead Make refused says so, and why', /Not delivered/.test(line) && /410/.test(line), line);
    await page.click('.lead-make button');
    await page.waitForFunction(() => /Sent/.test(document.querySelector('.lead-make').textContent));
    check('Resend sends it, and the line says it went', delivers.length === 1 && /Sent/.test(await page.$eval('.lead-make', n => n.textContent)),
          await page.$eval('.lead-make', n => n.textContent));
    await page.click('.lead-make button');
    await page.waitForSelector('dialog.bp-dialog[open]');
    const ask = await page.$eval('dialog.bp-dialog[open]', d => d.textContent);
    check('sending again once Make has it asks first, naming the duplicate it could make', /second Salesforce lead/.test(ask), ask);
    await page.evaluate(() => [...document.querySelectorAll('dialog.bp-dialog[open] button')].find(b => b.textContent === 'Cancel').click());
    await page.waitForTimeout(200);
    check('and Cancel sends nothing', delivers.length === 1, String(delivers.length));

    console.log('\nThe link on the Salesforce lead opens it here');
    await page.goto(`${base}/admin#lead=${LEAD}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#section-leads.active .lead-detail-head h2', { timeout: 10000 }).catch(() => {});
    const opened = await page.evaluate(() => ({
      leads: document.getElementById('section-leads').classList.contains('active'),
      name: document.querySelector('#lead-detail .lead-detail-head h2')?.textContent || '',
    }));
    check('the console opens on Leads, with that enquiry open', opened.leads && opened.name === 'Ana Silva', JSON.stringify(opened));

    console.log('\nAn admin who is not the owner');
    hook = { ...hook, editable: false, url: 'https://hook.eu1.make.com/…c123' };
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('[data-section="settings"]');
    await page.waitForSelector('#make-card:not([hidden]) .plan-name');
    check('sees that it is connected, with no field to change it',
          (await page.$$('#make-card input[type=url]')).length === 0 && /Only the owner/.test(await card()), (await card()).slice(0, 140));

    check('no page errors', errs.length === 0, errs.join(' | '));
  } finally {
    await br.close();
    server.close();
  }
  process.exit(finish());
})().catch(e => { console.error(e); process.exit(1); });
