// api/contact.js
// Vercel serverless function — receives the contact form POST and sends
// a notification email via Resend's HTTP API (no npm dependency needed;
// Vercel's Node runtime has global fetch built in).
//
// Required environment variables (set these in Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY   — from https://resend.com (free tier: 3,000 emails/month)
//   CONTACT_TO_EMAIL — where submissions should be delivered, e.g. nimasha@retentio.in
//                        (contact@retentio.in is a forwarding alias to this inbox —
//                        routing notifications straight to the real mailbox avoids
//                        an unnecessary extra forward hop)
//   CONTACT_FROM_EMAIL — the "from" address Resend sends as. Must be on a domain
//                        verified with Resend — use contact@retentio.in once that
//                        domain verification is complete. For initial testing before
//                        verification, use "onboarding@resend.dev" (Resend's shared
//                        test sender) instead.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }
  body = body || {};

  const name = (body.name || '').toString().trim();
  const workEmail = (body.work_email || '').toString().trim();
  const phone = (body.phone || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const message = (body.message || '').toString().trim();
  const honeypot = (body.company_website || '').toString().trim();

  // Honeypot tripped — pretend success so bots don't learn to skip this field,
  // but don't actually send anything.
  if (honeypot) {
    return res.status(200).json({ ok: true });
  }

  if (!workEmail || !EMAIL_RE.test(workEmail)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!apiKey || !toEmail || !fromEmail) {
    console.error('Missing RESEND_API_KEY, CONTACT_TO_EMAIL or CONTACT_FROM_EMAIL env vars');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  const escapeHtml = (str) =>
    str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  const htmlBody = `
    <h2>New contact form submission — Retentio</h2>
    <p><strong>Name:</strong> ${escapeHtml(name) || '—'}</p>
    <p><strong>Work Email:</strong> ${escapeHtml(workEmail)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
    <p><strong>Company:</strong> ${escapeHtml(company) || '—'}</p>
    <p><strong>Message:</strong><br>${escapeHtml(message).replace(/\n/g, '<br>') || '—'}</p>
  `;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Retentio Contact Form <${fromEmail}>`,
        to: [toEmail],
        reply_to: workEmail,
        subject: `New enquiry from ${name || workEmail}`,
        html: htmlBody
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend API error:', resendRes.status, errText);
      return res.status(502).json({ error: 'Failed to send email.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
};
