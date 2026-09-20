// api/send-otp.js
// Vercel serverless function — generates a 6-digit verification code,
// stores it in Supabase's otp_codes table (upserted by email, so each new
// request replaces any previous code for that address) with a 10-minute
// expiry, and emails it via Resend.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — same project used everywhere else
//   RESEND_API_KEY, CONTACT_FROM_EMAIL

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MINUTES = 10;

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

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  // Upsert by email: replaces any previous code for this address.
  // Requires the UNIQUE constraint on otp_codes.email (see migration_otp.sql).
  try {
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/otp_codes`, {
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