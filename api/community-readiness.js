// api/community-readiness.js
// Deterministic fit score (health+tickets+revenue, out of 6) + deterministic
// tool-type recommendation (by size) + deterministic problem-to-solutions
// tally. Claude's only job is to explain the verdict -- it does not decide
// the score, verdict, tool type, or which solutions get recommended.
//
// Required environment variables: same as the other tools' backends.

const { supabasePost, findOrCreateLead, getToolId, verifyOtp, escapeHtml } = require('./_lib/helpers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TOOL_SLUG = 'community_readiness_quiz';

const HEALTH_POINTS = { Strong: 2, Mixed: 1, Struggling: 0 };
const TICKETS_POINTS = { Low: 0.5, Moderate: 1, High: 2 };
const REVENUE_POINTS = { Yes: 2, Somewhat: 1, No: 0 };
const MAX_SCORE = 6;

const VALID_SIZES = ['Under 100', '100-500', '500-2000', '2000+'];
const TOOL_TYPE = {
  'Under 100': 'A lightweight space — Slack, Discord, or a private forum — fits your scale far better than a dedicated platform. A purpose-built community tool would be overkill here.',
  '100-500': "You're at a size where a lightweight tool (Slack/Discord) can still work well, though a dedicated platform becomes worth considering as you grow toward the upper end of this range.",
  '500-2000': 'A dedicated community platform (e.g. Circle, Discourse, or similar) is likely worth the investment at this scale — lightweight tools start to strain.',
  '2000+': 'A dedicated, purpose-built community platform is strongly recommended at this scale. Lightweight tools like Slack tend to become unmanageable well before this size.'
};

const PROBLEM_TO_SOLUTIONS = {
  'High support volume': ['In-Product Guides', 'Community'],
  'Poor product adoption': ['Customer Education & Webinars', 'In-Product Guides'],
  'Low customer engagement': ['Community', 'User Groups & Events'],
  'Customer retention/churn': ['Lifecycle Email Nurture', 'Win-back & Re-engagement'],
  'Expansion opportunities being missed': ['Customer Stories & Case Studies', 'Lifecycle Email Nurture'],
  'Weak customer advocacy': ['Champion Programmes', 'Customer-led Content'],
  'Limited customer feedback': ['Community', 'User Groups & Events'],
  'Customers struggling to learn from each other': ['Community', 'User Groups & Events'],
  'Lack of peer networking': ['Community', 'User Groups & Events'],
  'Other': ['Community']
};

function topSolutions(problems) {
  const tally = {};
  problems.forEach((p) => {
    (PROBLEM_TO_SOLUTIONS[p] || []).forEach((sol) => {
      tally[sol] = (tally[sol] || 0) + 1;
    });
  });
  return Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, 3);
}

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
  const health = (body.health || '').toString();
  const size = (body.size || '').toString();
  const tickets = (body.tickets || '').toString();
  const revenue = (body.revenue || '').toString();
  const problems = Array.isArray(body.problems) ? body.problems : [];

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ error: 'A 6-digit verification code is required.' });
  }
  if (!(health in HEALTH_POINTS) || !(tickets in TICKETS_POINTS) || !(revenue in REVENUE_POINTS)) {
    return res.status(400).json({ error: 'Invalid health, ticket volume, or revenue answer.' });
  }
  if (!VALID_SIZES.includes(size)) {
    return res.status(400).json({ error: 'Invalid community size answer.' });
  }
  const invalidProblem = problems.find((p) => !PROBLEM_TO_SOLUTIONS[p]);
  if (invalidProblem) {
    return res.status(400).json({ error: 'Invalid problem selection.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !anthropicKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing required env vars for community-readiness');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  const otpResult = await verifyOtp(supabaseUrl, serviceKey, email, otp);
  if (!otpResult.ok) {
    return res.status(400).json({ error: otpResult.error });
  }

  // ---- Deterministic verdict, tool-type, and solutions (Claude decides none of these) ----
  const score = HEALTH_POINTS[health] + TICKETS_POINTS[tickets] + REVENUE_POINTS[revenue];
  let verdict;
  if (score >= MAX_SCORE * (2 / 3)) verdict = 'Strong Fit';
  else if (score >= MAX_SCORE * (1 / 3)) verdict = 'Some Potential';
  else verdict = 'Not Yet';

  const solutions = topSolutions(problems);
  const toolType = verdict !== 'Not Yet' ? TOOL_TYPE[size] : null;

  const problemsText = problems.length ? problems.join(', ') : 'no specific problems selected';
  const solutionsText = solutions.length ? solutions.join(' and ') : 'Community';

  const prompt = `You are helping a customer marketing professional decide whether launching a community is the right move.

Deterministic inputs already calculated:
- Customer health: ${health}
- Support ticket volume: ${tickets}
- Revenue leakage clarity: ${revenue}
- Fit score: ${score.toFixed(1)} / ${MAX_SCORE}
- Verdict: ${verdict}
- Problems they flagged: ${problemsText}
- Solutions that map to those problems: ${solutionsText}

Write a short explanation (100-150 words, plain text, no markdown) that:
1. Explains why this verdict makes sense given their health/tickets/revenue signals specifically.
2. Connects their flagged problems to the recommended solutions (${solutionsText}) -- be concrete about why those fit.
3. If the verdict is not "Strong Fit," name the single biggest thing to fix first.

Do not invent facts beyond what's given above. Write directly to the reader in second person ("you"), direct and practical, no filler.`;

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
        max_tokens: 300,
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
      source_page: 'community-readiness.html',
      tool_version: 'v2' // v2 = Budget/Owner/CSM questions dropped, problem multi-select added
    });
    const toolRunId = toolRun[0].id;

    await supabasePost(supabaseUrl, serviceKey, 'tool_responses', {
      tool_run_id: toolRunId,
      input_data: { health, size, tickets, revenue, problems },
      calculation_data: { score, verdict, solutions }
    });

    await supabasePost(supabaseUrl, serviceKey, 'recommendations', {
      tool_run_id: toolRunId,
      score: score,
      score_band: verdict,
      result_summary: explanation,
      primary_opportunity: solutions[0] || null,
      next_action: null,
      retentio_programme: solutions[0] || null,
      llm_output: { model: CLAUDE_MODEL, text: explanation }
    });
  } catch (err) {
    console.error('IMPORTANT: failed to record tool_run/response/recommendation in Supabase:', err);
  }

  try {
    const leadHtml = `
      <h2>New Community Readiness Quiz lead — Retentio</h2>
      <p><strong>Email:</strong> ${escapeHtml(email)} (verified)</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
      <p><strong>Verdict:</strong> ${escapeHtml(verdict)} (score ${score.toFixed(1)}/${MAX_SCORE})</p>
      <p><strong>Customer health:</strong> ${escapeHtml(health)} | <strong>Tickets:</strong> ${escapeHtml(tickets)} | <strong>Revenue clarity:</strong> ${escapeHtml(revenue)}</p>
      <p><strong>Community size:</strong> ${escapeHtml(size)}</p>
      <p><strong>Problems flagged:</strong> ${escapeHtml(problemsText)}</p>
      <p><strong>Recommended solutions:</strong> ${escapeHtml(solutionsText)}</p>
      <p><strong>Generated explanation:</strong><br>${escapeHtml(explanation).replace(/\n/g, '<br>')}</p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Retentio Community Readiness Quiz <${fromEmail}>`,
        to: [toEmail],
        reply_to: email,
        subject: `New Community Readiness lead (${verdict})`,
        html: leadHtml
      })
    });
  } catch (err) {
    console.error('Lead notification email failed (non-blocking):', err);
  }

  return res.status(200).json({ score, verdict, toolType, solutions, explanation });
};
