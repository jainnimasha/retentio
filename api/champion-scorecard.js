// api/champion-scorecard.js
// Vercel serverless function — verifies the OTP code sent by api/send-otp.js,
// then generates a personalised "Champion Program" recommendation via
// Anthropic's Claude API, emails the lead to Retentio via Resend, and
// returns the generated recommendation. No LLM call happens unless the OTP
// check passes, so a submission can't burn API cost without a verified email.
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   KV_REST_API_URL, KV_REST_API_TOKEN — same Upstash Redis integration used by send-otp.js
//   ANTHROPIC_API_KEY — from https://console.anthropic.com (new signup, separate
//                        from Resend). This is a paid API — each call to a Haiku-class
//                        model costs a small fraction of a cent, but it is not free
//                        the way an unlimited client-side calculator is.
//   RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL — reused from the
//                        contact form setup; no new email infrastructure needed.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OTP_ATTEMPTS = 5;
const OTP_RETRY_TTL_SECONDS = 300; // 5 minutes, refreshed on each failed attempt

async function redisGet(baseUrl, token, key) {
  const res = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Redis GET failed: ' + (await res.text()));
  const data = await res.json();
  return data.result; // null if key doesn't exist
}

async function redisSetex(baseUrl, token, key, seconds, value) {
  const url = `${baseUrl}/setex/${encodeURIComponent(key)}/${seconds}/${encodeURIComponent(value)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Redis SETEX failed: ' + (await res.text()));
}

async function redisDel(baseUrl, token, key) {
  const res = await fetch(`${baseUrl}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Redis DEL failed: ' + (await res.text()));
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
  const otp = (body.otp || '').toString().trim();
  const phone = (body.phone || '').toString().trim();
  const tenureLabel = (body.tenure_label || '').toString();
  const usageLabel = (body.usage_label || '').toString();
  const sentimentLabel = (body.sentiment_label || '').toString();
  const seniorityLabel = (body.seniority_label || '').toString();
  const arr = (body.arr || '').toString();
  const engagementSignals = Array.isArray(body.engagement_signals) ? body.engagement_signals : [];
  const score = Number.isFinite(body.score) ? body.score : null;
  const tier = (body.tier || '').toString();

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ error: 'A 6-digit verification code is required.' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!kvUrl || !kvToken || !anthropicKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing one or more required env vars for champion-scorecard');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  // ── Verify the OTP before spending anything on the LLM call ──────────
  const otpKey = `otp:${email}`;
  let record;
  try {
    const raw = await redisGet(kvUrl, kvToken, otpKey);
    if (!raw) {
      return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
    }
    record = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read OTP record:', err);
    return res.status(500).json({ error: 'Could not verify your code right now.' });
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await redisDel(kvUrl, kvToken, otpKey).catch(() => {});
    return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (record.code !== otp) {
    record.attempts += 1;
    await redisSetex(kvUrl, kvToken, otpKey, OTP_RETRY_TTL_SECONDS, JSON.stringify(record)).catch(() => {});
    const remaining = MAX_OTP_ATTEMPTS - record.attempts;
    return res.status(400).json({ error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
  }

  // Correct — the code is single-use, so remove it immediately.
  await redisDel(kvUrl, kvToken, otpKey).catch((err) => console.error('Failed to delete used OTP:', err));

  // ── OTP verified — now it's safe to spend on the LLM call ────────────
  const engagementText = engagementSignals.length ? engagementSignals.join('; ') : 'None selected';

  const prompt = `You are helping a customer marketing professional decide how to activate a specific customer as a champion/advocate.

Here is the customer profile they entered into a scoring tool:
- Tenure as a customer: ${tenureLabel}
- Product usage/adoption level: ${usageLabel}
- Sentiment / NPS: ${sentimentLabel}
- Main contact's seniority: ${seniorityLabel}
- Company ARR band: ${arr}
- Engagement signals observed: ${engagementText}
- Calculated readiness score: ${score} out of 18
- Readiness tier: ${tier}

Write a short, practical recommendation (150-220 words, plain text, no markdown headers or bullet symbols beyond simple dashes) covering:
1. A one-sentence read on where this customer actually stands, in plain language.
2. The single most appropriate type of champion/advocacy programme to invite them into first (choose from: reference calls, case study features, community/user group involvement, referral programme, product advisory board, review/testimonial requests, or continued nurture with no ask yet).
3. One sentence connecting this to potential business value, referencing their ARR band directly (e.g. what a strong reference or referral could be worth at a company of that size) without inventing specific dollar figures as fact — frame it as a reasonable estimate.
4. One concrete next action to take this week.

Write directly to the customer marketer reading this, in second person ("you"), in a direct and practical tone with no fluff or generic AI-sounding filler.`;

  let recommendation;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Anthropic API error:', claudeRes.status, errText);
      return res.status(502).json({ error: 'Failed to generate recommendation.' });
    }

    const claudeData = await claudeRes.json();
    recommendation = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    if (!recommendation) {
      return res.status(502).json({ error: 'Empty recommendation returned.' });
    }
  } catch (err) {
    console.error('Claude call failed:', err);
    return res.status(500).json({ error: 'Unexpected error generating recommendation.' });
  }

  // Send the lead notification — failure here should not block the visitor
  // from seeing their result, so this is best-effort and doesn't throw.
  try {
    const escapeHtml = (str) =>
      str.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));

    const leadHtml = `
      <h2>New Champion Scorecard lead — Retentio</h2>
      <p><strong>Email:</strong> ${escapeHtml(email)} (verified)</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
      <p><strong>Score:</strong> ${score} / 18 (${escapeHtml(tier)})</p>
      <p><strong>Tenure:</strong> ${escapeHtml(tenureLabel)}</p>
      <p><strong>Usage:</strong> ${escapeHtml(usageLabel)}</p>
      <p><strong>Sentiment:</strong> ${escapeHtml(sentimentLabel)}</p>
      <p><strong>Seniority:</strong> ${escapeHtml(seniorityLabel)}</p>
      <p><strong>ARR band:</strong> ${escapeHtml(arr)}</p>
      <p><strong>Engagement signals:</strong> ${escapeHtml(engagementText)}</p>
      <p><strong>Generated recommendation:</strong><br>${escapeHtml(recommendation).replace(/\n/g, '<br>')}</p>
    `;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Retentio Champion Scorecard <${fromEmail}>`,
        to: [toEmail],
        reply_to: email,
        subject: `New Champion Scorecard lead (${tier}, ${score}/18)`,
        html: leadHtml
      })
    });
  } catch (err) {
    console.error('Lead notification email failed (non-blocking):', err);
  }

  return res.status(200).json({ recommendation: recommendation });
};
