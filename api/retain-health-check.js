// api/retain-health-check.js
// Verifies OTP, calls Claude to explain the (already-computed) weakest/
// strongest RETAIN pillar, records the run in Supabase, emails a lead
// notification. Same pattern as champion-scorecard.js, reusing _lib/helpers.
//
// Required environment variables: same as champion-scorecard.js

const { supabasePost, findOrCreateLead, getToolId, verifyOtp, escapeHtml } = require('./_lib/helpers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TOOL_SLUG = 'retain_health_check';

// Reused verbatim from the homepage's interactive RETAIN tiles.
const PILLAR_COPY = {
  Relationships: 'Build the customer relationships that create the foundation for growth.',
  Engagement: 'Keep customers participating, learning and moving forward.',
  Trust: 'Turn customer success into proof your market can believe.',
  Advocacy: 'Give your strongest customers a reason and a way to advocate.',
  Insights: 'Turn customer signals into better decisions.',
  Nurture: 'Keep valuable customer relationships active over time.'
};
const PILLAR_SOLUTIONS = {
  Relationships: ['Customer Advocacy', 'Community', 'Events & User Groups'],
  Engagement: ['Webinars', 'Community', 'Content Marketing', 'Customer Marketing'],
  Trust: ['Customer Stories', 'Content Marketing', 'Webinars'],
  Advocacy: ['Customer Advocacy', 'Customer Stories', 'Events & User Groups', 'Webinars'],
  Insights: ['Impact Measurement', 'Customer Marketing', 'Customer Advocacy', 'Community'],
  Nurture: ['Customer Marketing', 'Community', 'Content Marketing', 'Webinars']
};

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
  const pillarScores = body.pillar_scores || {};
  const overallPct = Number.isFinite(body.overall_pct) ? body.overall_pct : null;
  const weakest = (body.weakest || '').toString();
  const strongest = (body.strongest || '').toString();

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ error: 'A 6-digit verification code is required.' });
  }
  if (!PILLAR_COPY[weakest] || !PILLAR_COPY[strongest]) {
    return res.status(400).json({ error: 'Missing or invalid pillar data.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !anthropicKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing required env vars for retain-health-check');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  const otpResult = await verifyOtp(supabaseUrl, serviceKey, email, otp);
  if (!otpResult.ok) {
    return res.status(400).json({ error: otpResult.error });
  }

  const weakSolutions = PILLAR_SOLUTIONS[weakest].slice(0, 2).join(' or ');
  const pillarScoreLines = Object.keys(pillarScores)
    .map((k) => `- ${k}: ${pillarScores[k]}/10`)
    .join('\n');

  const prompt = `You are helping a customer marketing professional interpret a RETAIN framework health check for their post-sale motion.

Their scores across the six RETAIN pillars (each out of 10):
${pillarScoreLines}

Overall health: ${overallPct}%
Weakest pillar: ${weakest} -- "${PILLAR_COPY[weakest]}"
Strongest pillar: ${strongest} -- "${PILLAR_COPY[strongest]}"
Solutions that map to the weakest pillar: ${weakSolutions}

Write a short, practical explanation (150-200 words, plain text, no markdown headers) covering:
1. One sentence acknowledging their strongest pillar as a real foundation.
2. A clear, direct explanation of why the weakest pillar matters and what it's likely costing them if left unaddressed.
3. One concrete recommendation this week, referencing one of the mapped solutions by name.

Write directly to the reader in second person ("you"), in a direct, practical tone with no fluff or generic AI-sounding filler. Do not invent statistics or numbers beyond what's given above.`;

  let explanation;
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
        max_tokens: 350,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      console.error('Anthropic API error:', claudeRes.status, await claudeRes.text());
      return res.status(502).json({ error: 'Failed to generate explanation.' });
    }

    const claudeData = await claudeRes.json();
    explanation = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    if (!explanation) return res.status(502).json({ error: 'Empty explanation returned.' });
  } catch (err) {
    console.error('Claude call failed:', err);
    return res.status(500).json({ error: 'Unexpected error generating explanation.' });
  }

  try {
    const leadId = await findOrCreateLead(supabaseUrl, serviceKey, { email, phone });
    const toolId = await getToolId(supabaseUrl, serviceKey, TOOL_SLUG);

    const toolRun = await supabasePost(supabaseUrl, serviceKey, 'tool_runs', {
      lead_id: leadId,
      tool_id: toolId,
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      source_page: 'retain-health-check.html',
      tool_version: 'v1'
    });
    const toolRunId = toolRun[0].id;

    await supabasePost(supabaseUrl, serviceKey, 'tool_responses', {
      tool_run_id: toolRunId,
      input_data: { pillar_scores: pillarScores },
      calculation_data: { overall_pct: overallPct, weakest, strongest }
    });

    await supabasePost(supabaseUrl, serviceKey, 'recommendations', {
      tool_run_id: toolRunId,
      score: overallPct,
      score_band: null,
      result_summary: explanation,
      primary_opportunity: weakest,
      next_action: null,
      retentio_programme: PILLAR_SOLUTIONS[weakest][0],
      llm_output: { model: CLAUDE_MODEL, text: explanation }
    });
  } catch (err) {
    console.error('IMPORTANT: failed to record tool_run/response/recommendation in Supabase:', err);
  }

  try {
    const leadHtml = `
      <h2>New RETAIN Health Check lead — Retentio</h2>
      <p><strong>Email:</strong> ${escapeHtml(email)} (verified)</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
      <p><strong>Overall health:</strong> ${overallPct}%</p>
      <p><strong>Weakest pillar:</strong> ${escapeHtml(weakest)}</p>
      <p><strong>Strongest pillar:</strong> ${escapeHtml(strongest)}</p>
      <p><strong>Pillar scores:</strong><br>${escapeHtml(pillarScoreLines).replace(/\n/g, '<br>')}</p>
      <p><strong>Generated explanation:</strong><br>${escapeHtml(explanation).replace(/\n/g, '<br>')}</p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Retentio RETAIN Health Check <${fromEmail}>`,
        to: [toEmail],
        reply_to: email,
        subject: `New RETAIN Health Check lead (${overallPct}%, weakest: ${weakest})`,
        html: leadHtml
      })
    });
  } catch (err) {
    console.error('Lead notification email failed (non-blocking):', err);
  }

  return res.status(200).json({ explanation: explanation });
};
