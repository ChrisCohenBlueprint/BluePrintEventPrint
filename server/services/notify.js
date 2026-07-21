const config = require('../config');

/**
 * Send a "new enquiry" notification.
 *
 * Delivery is via a webhook rather than SMTP, so there is no mail server to run
 * and no new dependency: point NOTIFY_WEBHOOK at a Zapier / Make / n8n catch
 * hook, a Slack incoming webhook, or your CRM's inbound endpoint, and each
 * enquiry is POSTed there as JSON. Wire that to an email in whichever tool you
 * already use.
 *
 * With no webhook configured this is a no-op, so nothing breaks in development.
 */
async function newInquiry(inquiry) {
  const url = config.notifyWebhook;
  if (!url) return;

  const c = inquiry.contact || {};
  const payload = {
    event: 'inquiry.new',
    show: config.showId,
    name: c.name,
    email: c.email,
    phone: c.phone || null,
    company: c.company || null,
    stands: inquiry.boothsOfInterest || [],
    message: inquiry.message || null,
    receivedAt: new Date().toISOString(),
    // A ready-to-read summary line for tools that surface `text` directly, e.g.
    // Slack.
    text: `New enquiry from ${c.name || 'someone'}` +
          (c.company ? ` (${c.company})` : '') +
          ` — stands ${(inquiry.boothsOfInterest || []).join(', ') || 'none listed'}. ` +
          `Reply: ${c.email}`,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`Notify webhook returned ${res.status}`);
  } catch (e) {
    // A failed notification must never fail the enquiry itself.
    console.warn('Notify webhook failed:', e.message);
  }
}

module.exports = { newInquiry };
