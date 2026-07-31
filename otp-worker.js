/**
 * MathLab — Server-side OTP Worker
 * ------------------------------------------------------------
 * WHY THIS EXISTS
 * In the old flow, the browser itself generated the OTP code and kept it in a
 * JS variable (tempRegData.otp / tempResetData.otp) so it could compare it to
 * whatever the user typed. That means anyone could open DevTools → Console on
 * their OWN registration/reset session and just read the variable — no email
 * access needed. The fix isn't "hide it better" client-side (that's not
 * possible — the browser has to have the code to compare it), it's: don't let
 * the browser hold the real code at all. This Worker generates the code,
 * emails it, and is the ONLY thing that ever compares it. The browser only
 * ever gets back true/false.
 *
 * ENDPOINTS
 *   POST /request-otp   { email, name }          -> { ok:true }
 *   POST /verify-otp     { email, code }          -> { ok:true } | { ok:false, error }
 *
 * Both endpoints require header:  X-OTP-Secret: <OTP_SHARED_SECRET>
 * (same pattern as the existing R2 upload Worker's X-Upload-Secret — keeps a
 * casual scraper from hammering these endpoints, NOT a substitute for the
 * per-email rate limiting below, which is the real abuse guard.)
 *
 * STORAGE
 * Needs one KV namespace bound as OTP_KV. Each entry is keyed by email and
 * expires automatically (Cloudflare KV's own TTL) so there's nothing to clean
 * up. We store a SHA-256 hash of the code, never the code itself — so even
 * reading the KV data directly (Cloudflare dashboard, a compromised secret,
 * etc.) doesn't hand over live codes.
 *
 * DEPLOY
 * See OTP_SETUP.md next to this file for the full step-by-step.
 */

const OTP_TTL_SECONDS = 10 * 60;      // 10 minutes, matches the old client-side value
const MAX_ATTEMPTS = 5;               // matches the old client-side value
const RESEND_COOLDOWN_SECONDS = 30;   // stops someone spamming "resend" into an email-bomb

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-OTP-Secret',
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateCode() {
  // crypto.getRandomValues, not Math.random() — Math.random() is not
  // cryptographically secure and is in principle predictable.
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const n = 100000 + (arr[0] % 900000);
  return String(n);
}

async function sendOtpEmail(env, toEmail, toName, code) {
  const templateParams = {
    to_email: toEmail,
    email: toEmail,
    to_name: toName,
    name: toName,
    from_name: 'MathLab By Sithum Munasinghe',
    passcode: code,
    otp: code,
    otp_code: code,
    code,
    time: new Date().toLocaleString(),
  };
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: env.EMAILJS_SERVICE_ID,
      template_id: env.EMAILJS_TEMPLATE_ID,
      user_id: env.EMAILJS_PUBLIC_KEY,
      // EmailJS requires the account's Private Key ("accessToken") to accept
      // API calls that don't come from a browser with an allowed Origin —
      // Workers requests have no browser Origin to check. Get this from
      // EmailJS dashboard → Account → API Keys → Private Key.
      accessToken: env.EMAILJS_PRIVATE_KEY,
      template_params: templateParams,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EmailJS ${res.status}: ${text}`);
  }
}

async function handleRequestOtp(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, env); }
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim() || email;
  if (!email || !email.includes('@')) return json({ ok: false, error: 'invalid_email' }, 400, env);

  const key = `otp:${email}`;
  const existingRaw = await env.OTP_KV.get(key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    const age = (Date.now() - existing.createdAt) / 1000;
    if (age < RESEND_COOLDOWN_SECONDS) {
      return json({ ok: false, error: 'cooldown', retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - age) }, 429, env);
    }
  }

  const code = generateCode();
  const hash = await sha256Hex(`${email}:${code}`);
  const record = { hash, attempts: 0, createdAt: Date.now() };

  try {
    await sendOtpEmail(env, email, name, code);
  } catch (err) {
    return json({ ok: false, error: 'send_failed', detail: String(err.message || err) }, 502, env);
  }

  await env.OTP_KV.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL_SECONDS });
  return json({ ok: true }, 200, env);
}

async function handleVerifyOtp(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, env); }
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!email || !code) return json({ ok: false, error: 'missing_fields' }, 400, env);

  const key = `otp:${email}`;
  const raw = await env.OTP_KV.get(key);
  if (!raw) return json({ ok: false, error: 'expired' }, 200, env);

  const record = JSON.parse(raw);
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.OTP_KV.delete(key);
    return json({ ok: false, error: 'too_many_attempts' }, 200, env);
  }

  const candidateHash = await sha256Hex(`${email}:${code}`);
  if (candidateHash !== record.hash) {
    record.attempts += 1;
    await env.OTP_KV.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL_SECONDS });
    return json({ ok: false, error: 'invalid', attemptsLeft: MAX_ATTEMPTS - record.attempts }, 200, env);
  }

  await env.OTP_KV.delete(key);
  return json({ ok: true }, 200, env);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    const url = new URL(request.url);

    if (env.OTP_SHARED_SECRET) {
      const provided = request.headers.get('X-OTP-Secret');
      if (provided !== env.OTP_SHARED_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401, env);
      }
    }

    if (request.method === 'POST' && url.pathname === '/request-otp') {
      return handleRequestOtp(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/verify-otp') {
      return handleVerifyOtp(request, env);
    }
    return json({ ok: false, error: 'not_found' }, 404, env);
  },
};
