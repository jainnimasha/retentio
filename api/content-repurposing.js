// api/content-repurposing.js
// Deterministic readiness scoring (word length, outcome language, numbers,
// quotes) + a deterministic content-type -> format mapping, same as the
// prototype. Claude's ONLY job is to write a tailored explanation using the
// audience + goal context -- it does not decide the tier, score, or formats.
//
// Required environment variables: same as the other tools' backends.

const { supabasePost, findOrCreateLead, getToolId, verifyOtp, escapeHtml } = require('./_lib/helpers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TOOL_SLUG = 'content_repurposing_planner';
const WORD_CAP = 2000;

const FORMAT_BY_TYPE = {
  'Blog excerpt': ['LinkedIn Post', 'Practitioner Post'],
  'Customer call transcript': ['Customer Story', 'Case Study'],
  'Webinar transcript': ['Customer Story', 'Community Discussion'],
  'Case study draft': ['Case Study', 'Sales Enablement Snippet'],
  'Other': ['LinkedIn Post', 'Community Discussion']
};

const VALID_AUDIENCES = ['Prospects', 'Existing customers', 'Customer champions', 'Practitioners / users', 'Executives / decision-makers', 'Mixed audience'];
const VALID_GOALS = ['Build awareness', 'Educate', 'Drive engagement', 'Generate demand', 'Strengthen customer relationships', 'Build advocacy', 'Support sales conversations'];

function wordCount(text) {
  const trimmed = (text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function scoreContent(text, count) {
  const lower = text.toLowerCase();
  let score = 0;
  const reasons = [];

  if (count >= 60 && count <= WORD_CAP) score += 3; else reasons.push('a bit short to carry a full narrative');

  const outcomeWords = ['result', 'increase', 'reduce', 'improve', 'outcome', 'success', 'growth', 'saved', 'faster', '%'];
  if (outcomeWords.some((w) => lower.includes(w))) score += 3; else reasons.push('no clear outcome or result language yet');

  if (/\d/.test(lower)) score += 2; else reasons.push('could use a specific number or stat to anchor it');

  if (text.includes('"') || text.includes('\u201c')) score += 2;

  score = Math.min(score, 10);
  let tier;
  if (score <= 3) tier = 'Not Ready';
  else if (score <= 6) tier = 'Good Potential';
  else tier = 'Ready to Repurpose';

  return { score, tier, reasons };
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
  const contentType = (body.content_type || '').toString();
  const contentText = (body.content_text || '').toString().trim();
  const audiences = Array.isArray(body.audiences) ? body.audiences : [];
  const goals = Array.isArray(body.goals) ? body.goals : [];

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid work email is required.' });
  }
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ error: 'A 6-digit verification code is required.' });
  }
  if (!contentText) {
    return res.status(400).json({ error: 'Content text is required.' });
  }
  if (!FORMAT_BY_TYPE[contentType]) {
    return res.status(400).json({ error: 'Invalid content type.' });
  }
  const count = wordCount(contentText);
  if (count > WORD_CAP) {
    return res.status(400).json({ error: `Content must be ${WORD_CAP} words or fewer (received ${count}).` });
  }
  const invalidAudience = audiences.find((a) => !VALID_AUDIENCES.includes(a));
  if (invalidAudience) return res.status(400).json({ error: 'Invalid audience selection.' });
  const invalidGoal = goals.find((g) => !VALID_GOALS.includes(g));
  if (invalidGoal) return res.status(400).json({ error: 'Invalid goal selection.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey || !anthropicKey || !resendKey || !toEmail || !fromEmail) {
    console.error('Missing required env vars for content-repurposing');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  const otpResult = await verifyOtp(supabaseUrl, serviceKey, email, otp);
  if (!otpResult.ok) {
    return res.status(400).json({ error: otpResult.error });
  }

  // ---- Deterministic scoring + format mapping (Claude never decides these) ----
  const { score, tier, reasons } = scoreContent(contentText, count);
  const formats = FORMAT_BY_TYPE[contentType];

  const audienceText = audiences.length ? audiences.join(', ') : 'not specified';
  const goalText = goals.length ? goals.join(', ') : 'not specified';

  const prompt = `You are helping a customer marketing professional decide whether a piece of content is worth repurposing.

They pasted this content (type: ${contentType}):
"""
${contentText}
"""

A deterministic readiness check has already scored this content ${score}/10, tier: "${tier}".
${reasons.length ? 'Specific gaps noted: ' + reasons.join('; ') + '.' : 'No specific gaps noted -- the content is solid.'}
Best-fit formats for this content type: ${formats.join(' and ')}.
They said they want to reach: ${audienceText}.
They said their goal is: ${goalText}.

Write a short explanation (100-150 words, plain text, no markdown) that:
1. Confirms the tier in plain language, referencing the specific gaps if the tier is not "Ready to Repurpose."
2. Explains why the suggested formats (${formats.join(' and ')}) specifically fit their stated audience and goal -- be concrete, not generic.
3. Does NOT draft or generate any of the repurposed content itself -- only explain the fit.

Do not invent facts about the content beyond what's given. Write directly to the reader in second person ("you"), direct and practical, no filler.`;

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
      source_page: 'content-repurposing.html',
      tool_version: 'v1'
    });
    const toolRunId = toolRun[0].id;

    await supabasePost(supabaseUrl, serviceKey, 'tool_responses', {
      tool_run_id: toolRunId,
      input_data: { content_type: contentType, word_count: count, audiences, goals },
      calculation_data: { score, tier, formats }
    });

    await supabasePost(supabaseUrl, serviceKey, 'recommendations', {
      tool_run_id: toolRunId,
      score: score,
      score_band: tier,
      result_summary: explanation,
      primary_opportunity: formats[0],
      next_action: null,
      retentio_programme: null,
      llm_output: { model: CLAUDE_MODEL, text: explanation }
    });
  } catch (err) {
    console.error('IMPORTANT: failed to record tool_run/response/recommendation in Supabase:', err);
  }

  try {
    const leadHtml = `
      <h2>New Content Repurposing lead — Retentio</h2>
      <p><strong>Email:</strong> ${escapeHtml(email)} (verified)</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone) || '—'}</p>
      <p><strong>Content type:</strong> ${escapeHtml(contentType)} (${count} words)</p>
      <p><strong>Score:</strong> ${score}/10 (${escapeHtml(tier)})</p>
      <p><strong>Audiences:</strong> ${escapeHtml(audienceText)}</p>
      <p><strong>Goals:</strong> ${escapeHtml(goalText)}</p>
      <p><strong>Best-fit formats:</strong> ${escapeHtml(formats.join(', '))}</p>
      <p><strong>Pasted content:</strong><br>${escapeHtml(contentText).replace(/\n/g, '<br>')}</p>
      <p><strong>Generated explanation:</strong><br>${escapeHtml(explanation).replace(/\n/g, '<br>')}</p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Retentio Content Repurposing <${fromEmail}>`,
        to: [toEmail],
        reply_to: email,
        subject: `New Content Repurposing lead (${tier}, ${score}/10)`,
        html: leadHtml
      })
    });
  } catch (err) {
    console.error('Lead notification email failed (non-blocking):', err);
  }

  return res.status(200).json({ score, tier, formats, explanation });
};
