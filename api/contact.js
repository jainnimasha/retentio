// api/contact.js
// Vercel serverless function — receives the contact form POST, finds or
// creates the lead in Supabase (matched by email), stores the message in
// contact_messages, and sends a notification email via Resend.
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — your Supabase project's REST API
//                        base URL and service_role key. The service_role key
//                        bypasses Row Level Security, which is exactly what a
//                        trusted server-side function is supposed to do — it
//                        must NEVER be exposed to the browser.
//   RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL — same as before.
//
// Data guarantee: the Supabase write is now the PRIMARY thing this function
// promises (the person asked for this to be reliably stored). If that write
// fails, this returns a real error to the visitor. The email notification is
// secondary/best-effort — if Resend has a hiccup, the visitor still gets a
// success response, since their data is already safely stored.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return { first_name: null, last_name: null };
  const parts = trimmed.split(/\s+/);
  const first_name = parts.shift();
  const last_name = parts.length ? parts.join(' ') : null;
  return { first_name, last_name };
}

async function supabaseRequest(supabaseUrl, serviceKey, path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase request failed (${path}): ${res.status} ${errText}`);
  }
  // Some Supabase responses (e.g. a successful DELETE) can be empty.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function findOrCreateLead(supabaseUrl, serviceKey, { first_name, last_name, email, company, phone }) {
  // 1. Look for an existing lead with this email.
  const existing = await supabaseRequest(
    supabaseUrl,
    serviceKey,
    `leads?email=eq.${encodeURIComponent(email)}&select=id`
  );

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  // 2. Not found — create a new lead.
  const created = await supabaseRequest(supabaseUrl, serviceKey, 'leads', {
    method: 'POST',
    body: JSON.stringify({
      first_name: first_name,
      last_name: last_name,
      email: email,
      company: company || null,
      job_title: null,
      phone: phone || null,
      website: null,
      lead_source: 'contact_us'
    })
  });

  return created[0].id;
}

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
  const workEmail = (body.work_email || '').toString().trim().toLowerCase();
  const phone = (body.phone || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const message = (body.message || '').toString().trim();
  const honeypot = (body.company_website || '').toString().trim();

  // Honeypot tripped — pretend success so bots don't learn to skip this field,
  // but don't actually store or send anything.
  if (honeypot) {
    return res.status(200).json({ ok: true });
  }

  if (!workEmail || !EMAIL_RE.test(workEmail)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CONTACT_TO_EMAIL or CONTACT_FROM_EMAIL env vars');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  // ── Primary guarantee: store the lead + message in Supabase ──────────
  let leadId;
  try {
    const { first_name, last_name } = splitName(name);
    leadId = await findOrCreateLead(supabaseUrl, serviceKey, {
      first_name,
      last_name,
      email: workEmail,
      company,
      phone
    });

    await supabaseRequest(supabaseUrl, serviceKey, 'contact_messages', {
      method: 'POST',
      body: JSON.stringify({
        lead_id: leadId,
        message: message || '(no message provided)'
      })
    });
  } catch (err) {
    console.error('Supabase write failed:', err);
    return res.status(500).json({ error: 'Could not save your message right now. Please try again or email contact@retentio.in directly.' });
  }

  // ── Secondary, best-effort: notify by email ───────────────────────────
  try {
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
      <p style="color:#888;font-size:12px">Stored as lead ${leadId}</p>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
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
      console.error('Resend API error (non-blocking):', resendRes.status, errText);
    }
  } catch (err) {
    console.error('Failed to send notification email (non-blocking):', err);
  }

  return res.status(200).json({ ok: true });
};
