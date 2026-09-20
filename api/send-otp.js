// api/send-otp.js
// Vercel serverless function — generates a 6-digit verification code,
// stores it in Redis (via the Upstash Redis integration connected through
// Vercel's Storage tab) with a 10-minute expiry, and emails it via Resend.
//
// Required environment variables (auto-injected once you connect an Upstash
// Redis database to this project via Vercel → Storage → Create Database):
//   KV_REST_API_URL, KV_REST_API_TOKEN
// Plus the existing Resend variables:
//   RESEND_API_KEY, CONTACT_FROM_EMAIL

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_SECONDS = 600; // 10 minutes

async function redisSetex(baseUrl, token, key, seconds, value) {
  const url = `${baseUrl}/setex/${encodeURIComponent(key)}/${seconds}/${encodeURIComponent(value)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Redis SETEX failed: ' + (await res.text()));
  return res.json();
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

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!kvUrl || !kvToken || !resendKey || !fromEmail) {
    console.error('Missing KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY or CONTACT_FROM_EMAIL env vars');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  const code = crypto.randomInt(100000, 999999).toString();
  const record = JSON.stringify({ code: code, attempts: 0 });

  try {
    await redisSetex(kvUrl, kvToken, `otp:${email}`, OTP_TTL_SECONDS, record);
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
        html: `<p>Your Retentio Champion Scorecard verification code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:0.1em">${code}</p><p>This code expires in 10 minutes.</p>`
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
