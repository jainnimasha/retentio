// api/send-otp.js
// Vercel serverless function — generates a 6-digit verification code,
// stores it in Supabase's otp_codes table (upserted by email), and emails
// it via Resend. FIRST checks whether this email has already completed
// ANY Resources tool before — if so, refuses to send a new code and tells
// the frontend to show a "talk to us" message instead. This is a deliberate
// business rule: one email gets one free self-serve tool report, ever;
// repeat interest goes through a real conversation, not another AI call.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY, CONTACT_FROM_EMAIL

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MINUTES = 10;

async function supabaseGet(supabaseUrl, serviceKey, path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  if (!res.ok) throw new Error('Supabase GET failed: ' + (await res.text()));
  return res.json();
}

async function hasCompletedAnyTool(supabaseUrl, serviceKey, email) {
  const leads = await supabaseGet(supabaseUrl, serviceKey, `leads?email=eq.${encodeURIComponent(email)}&select=id`);
  if (!leads || leads.length === 0) return false; // never seen this email at all

  const leadId = leads[0].id;
  const runs = await supabaseGet(
    supabaseUrl,
    serviceKey,
    `tool_runs?lead_id=eq.${leadId}&status=eq.completed&select=id&limit=1`
  );
  return runs && runs.length > 0;
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

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !resendKey || !fromEmail) {
    console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY or CONTACT_FROM_EMAIL env vars');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  // ── Business rule: one email = one completed tool, ever ──────────────
  try {
    const alreadyDone = await hasCompletedAnyTool(supabaseUrl, serviceKey, email);
    if (alreadyDone) {
      return res.status(200).json({
        alreadyLead: true,
        message: "We've already got your details on file — our team would love to walk you through a deeper audit personally rather than another automated report."
      });
    }
  } catch (err) {
    // If this check itself fails, fail OPEN (let them proceed) rather than
    // blocking a legitimate first-time visitor because of a transient
    // database hiccup. Logged so it doesn't go unnoticed.
    console.error('Failed to check prior tool completion (proceeding anyway):', err);
  }

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  try {
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/otp_codes?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        email: email,
        code: code,
        attempts: 0,
        expires_at: expiresAt,
        created_at: new Date().toISOString()
      })
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('Supabase OTP upsert failed:', upsertRes.status, errText);
      return res.status(500).json({ error: 'Could not generate a code right now.' });
    }
  } catch (err) {
    console.error('Failed to store OTP:', err);
    return res.status(500).json({ error: 'Could not generate a code right now.' });
  }

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Retentio <${fromEmail}>`,
        to: [email],
        subject: `Your verification code: ${code}`,
        html: `<p>Your Retentio Champion Scorecard verification code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:0.1em">${code}</p><p>This code expires in ${OTP_TTL_MINUTES} minutes.</p>`
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend API error:', resendRes.status, errText);
      return res.status(502).json({ error: 'Failed to send verification email.' });
    }
  } catch (err) {
    console.error('Failed to send OTP email:', err);
    return res.status(500).json({ error: 'Could not send the verification email.' });
  }

  return res.status(200).json({ ok: true });
};