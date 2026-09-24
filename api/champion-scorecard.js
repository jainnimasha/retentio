// api/champion-scorecard.js
// Verifies the OTP, calls Claude for a personalised recommendation, records
// the run in Supabase, and emails a lead notification.
//
// UPDATED: seniority question dropped. Max score is now 15 (was 18).
// Tiers: 0-5 Not Ready | 6-10 Nurture | 11-15 Ready to Activate.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//   RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL

const { supabasePost, findOrCreateLead, getToolId, verifyOtp, escapeHtml } = require('./_lib/helpers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TOOL_SLUG = 'champion_scorecard';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const email = (body.email || '').toString().trim().toLowerCase();
  const otp = (body.otp || '').toString().trim();
  const phone = (body.phone || '').toString().trim();
  const tenureLabel = (body.tenure_label || '').toString();
  const usageLabel = (body.usage_label || '').toString();
  const sentimentLabel = (body.sentiment_label || '').toString();
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !anthropicKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing required env vars for champion-scorecard');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  // ---- Verify OTP before spending anything on the LLM call ----
  const otpResult = await verifyOtp(supabaseUrl, serviceKey, email, otp);
  if (!otpResult.ok) {
    return res.status(400).json({ error: otpResult.error });
  }

  // ---- OTP verified -- now safe to spend on the LLM call ----
  const engagementText = engagementSignals.length ? engagementSignals.join('; ') : 'None selected';

  const prompt = `You are helping a customer marketing professional decide how to activate a specific customer as a champion/advocate.

Here is the customer profile they entered into a scoring tool:
- Tenure as a customer: ${tenureLabel}
- Product usage/adoption level: ${usageLabel}
- Sentiment / NPS: ${sentimentLabel}
- Company ARR band: ${arr}
- Engagement signals observed: ${engagementText}
- Calculated readiness score: ${score} out of 15
- Readiness tier: ${tier}

Write a short, practical recommendation (150-220 words, plain text, no markdown headers or bullet symbols beyond simple dashes) covering:
1. A one-sentence read on where this customer actually stands, in plain language.
2. The single most appropriate type of champion/advocacy programme to invite them into first (choose from: reference calls, case study features, community/user group involvement, referral programme, product advisory board, review/testimonial requests, or continued nurture with no ask yet).
3. One sentence connecting this to potential business value, referencing their ARR band directly (e.g. what a strong reference or referral could be worth at a company of that size) without inventing specific dollar figures as fact -- frame it as a reasonable estimate.
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
      console.error('Anthropic API error:', claudeRes.status, await claudeRes.text());
      return res.status(502).json({ error: 'Failed to generate recommendation.' });
    }

    const claudeData = await claudeRes.json();
    recommendation = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    if (!recommendation) return res.status(502).json({ error: 'Empty recommendation returned.' });
  } catch (err) {
    console.error('Claude call failed:', err);
    return res.status(500).json({ error: 'Unexpected error generating recommendation.' });
  }

  // ---- Record the run in Supabase ----
  try {
    const leadId = await findOrCreateLead(supabaseUrl, serviceKey, { email, phone });
    const toolId = await getToolId(supabaseUrl, serviceKey, TOOL_SLUG);

    const toolRun = await supabasePost(supabaseUrl, serviceKey, 'tool_runs', {
      lead_id: leadId,
      tool_id: toolId,
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      source_page: 'champion-scorecard.html',
      tool_version: 'v2' // v2 = seniority dropped, max score 15
    });
    const toolRunId = toolRun[0].id;

    await supabasePost(supabaseUrl, serviceKey, 'tool_responses', {
      tool_run_id: toolRunId,
      input_data: { tenure: tenureLabel, usage: usageLabel, sentiment: sentimentLabel, arr: arr, engagement_signals: engagementSignals },
      calculation_data: { score, tier, max_score: 15 }
    });

    await supabasePost(supabaseUrl, serviceKey, 'recommendations', {
      tool_run_id: toolRunId,
      score: score,
      score_band: tier,
      result_summary: recommendation,
      primary_opportunity: null,
      next_action: null,
      retentio_programme: null,
      llm_output: { model: CLAUDE_MODEL, text: recommendation }
    });
  } catch (err) {
    console.error('IMPORTANT: failed to record tool_run/response/recommendation in Supabase:', err);
  }

  // ---- Secondary, best-effort: notify by email ----
  try {
    const leadHtml = `
      <h2>New Champion Scorecard lead — Retentio</h2>
      <p><strong>Email:</strong> ${escapeHtml(email)} (verified)</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
      <p><strong>Score:</strong> ${score} / 15 (${escapeHtml(tier)})</p>
      <p><strong>Tenure:</strong> ${escapeHtml(tenureLabel)}</p>
      <p><strong>Usage:</strong> ${escapeHtml(usageLabel)}</p>
      <p><strong>Sentiment:</strong> ${escapeHtml(sentimentLabel)}</p>
      <p><strong>ARR band:</strong> ${escapeHtml(arr)}</p>
      <p><strong>Engagement signals:</strong> ${escapeHtml(engagementText)}</p>
      <p><strong>Generated recommendation:</strong><br>${escapeHtml(recommendation).replace(/\n/g, '<br>')}</p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Retentio Champion Scorecard <${fromEmail}>`,
        to: [toEmail],
        reply_to: email,
        subject: `New Champion Scorecard lead (${tier}, ${score}/15)`,
        html: leadHtml
      })
    });
  } catch (err) {
    console.error('Lead notification email failed (non-blocking):', err);
  }

  return res.status(200).json({ recommendation: recommendation });
};