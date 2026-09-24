// api/_lib/helpers.js
// Shared helpers reused by every Resources tool's backend function.
// Lives under an underscore-prefixed folder so Vercel does NOT treat this
// as its own API route -- it's a plain importable module only.
//
// Required environment variables (same ones already set in Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const MAX_OTP_ATTEMPTS = 5;

async function supabaseGet(supabaseUrl, serviceKey, path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  if (!res.ok) throw new Error('Supabase GET failed: ' + (await res.text()));
  return res.json();
}

async function supabasePost(supabaseUrl, serviceKey, path, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST failed (${path}): ` + (await res.text()));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function supabasePatch(supabaseUrl, serviceKey, path, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Supabase PATCH failed: ' + (await res.text()));
}

async function supabaseDelete(supabaseUrl, serviceKey, path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' }
  });
  if (!res.ok) throw new Error('Supabase DELETE failed: ' + (await res.text()));
}

// Find a lead by email, or create one. Returns the lead's id.
// Every tool calls this the same way -- email is always the identity key.
async function findOrCreateLead(supabaseUrl, serviceKey, { email, phone }) {
  const existing = await supabaseGet(supabaseUrl, serviceKey, `leads?email=eq.${encodeURIComponent(email)}&select=id`);
  if (existing && existing.length > 0) return existing[0].id;

  const created = await supabasePost(supabaseUrl, serviceKey, 'leads', {
    first_name: null,
    last_name: null,
    email: email,
    company: null,
    job_title: null,
    phone: phone || null,
    website: null,
    lead_source: 'resource_tool'
  });
  return created[0].id;
}

// Look up a tool's id from the tools catalog by its slug.
async function getToolId(supabaseUrl, serviceKey, slug) {
  const rows = await supabaseGet(supabaseUrl, serviceKey, `tools?slug=eq.${slug}&select=id`);
  if (!rows || rows.length === 0) {
    throw new Error(`Tool with slug "${slug}" not found in tools table`);
  }
  return rows[0].id;
}

// Verify an OTP code for an email. Returns { ok: true } on success (and
// deletes the used code), or { ok: false, error: '...' } on failure --
// every tool's handler can just check result.ok and return result.error
// as-is, without re-implementing this logic.
async function verifyOtp(supabaseUrl, serviceKey, email, otp) {
  const otpPath = `otp_codes?email=eq.${encodeURIComponent(email)}`;
  let record;
  try {
    const rows = await supabaseGet(supabaseUrl, serviceKey, otpPath + '&select=*');
    if (!rows || rows.length === 0) {
      return { ok: false, error: 'That code has expired. Please request a new one.' };
    }
    record = rows[0];
  } catch (err) {
    console.error('Failed to read OTP record:', err);
    return { ok: false, error: 'Could not verify your code right now.' };
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    await supabaseDelete(supabaseUrl, serviceKey, otpPath).catch(() => {});
    return { ok: false, error: 'That code has expired. Please request a new one.' };
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await supabaseDelete(supabaseUrl, serviceKey, otpPath).catch(() => {});
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
  }

  if (record.code !== otp) {
    const newAttempts = record.attempts + 1;
    await supabasePatch(supabaseUrl, serviceKey, otpPath, { attempts: newAttempts }).catch(() => {});
    const remaining = MAX_OTP_ATTEMPTS - newAttempts;
    return { ok: false, error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }

  // Correct -- single-use, remove immediately.
  await supabaseDelete(supabaseUrl, serviceKey, otpPath).catch((err) => console.error('Failed to delete used OTP:', err));
  return { ok: true };
}

// Escape HTML for safe interpolation into notification emails.
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = {
  supabaseGet,
  supabasePost,
  supabasePatch,
  supabaseDelete,
  findOrCreateLead,
  getToolId,
  verifyOtp,
  escapeHtml
};
