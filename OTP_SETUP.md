# MathLab — Server-side OTP Worker Setup

මේක fix කරන්නේ: OTP code එක දැන් **browser එකේ JS memory එකේ නෑ**. Code එක
generate කරන්නෙත්, email එවන්නෙත්, check කරන්නෙත් — ඔක්කොම Cloudflare Worker
එකේ (server side). Browser එකට ලැබෙන්නේ `{ok:true}` / `{ok:false}` විතරයි,
DevTools console එකෙන් බලාගන්න code එකක් නෑ.

## 1. Prerequisites
- Same Cloudflare account you used for the existing R2 upload Worker.
- `npm install -g wrangler` (if you don't already have it).
- `wrangler login`

## 2. Create the KV namespace (where OTPs are held, briefly)
```
wrangler kv namespace create OTP_KV
```
This prints an `id`. Paste it into `wrangler.toml` in place of
`PASTE_YOUR_KV_NAMESPACE_ID`.

## 3. Get an EmailJS Private Key
EmailJS only accepts calls from a server (no browser Origin to check) if you
send the account's **Private Key**:
EmailJS dashboard → Account → API Keys → Private Key → copy it.

## 4. Set secrets (never go in wrangler.toml or the HTML file)
```
cd otp-worker
wrangler secret put EMAILJS_PRIVATE_KEY
wrangler secret put OTP_SHARED_SECRET
```
For `OTP_SHARED_SECRET`, make up any long random string — it just has to match
what you put in the HTML file's `OTP_WORKER_SECRET` constant later. (You can
reuse the same style as `R2_UPLOAD_SECRET` already in the site.)

## 5. Deploy
```
wrangler deploy
```
This prints your Worker URL, e.g.
`https://mathlab-otp-worker.<your-subdomain>.workers.dev`

## 6. Wire it into the site
In `moramaths-mega-edition.html`, find (near the existing `R2_WORKER_URL` lines):
```js
const OTP_WORKER_URL = "PASTE_YOUR_OTP_WORKER_URL_HERE";
const OTP_WORKER_SECRET = "PASTE_YOUR_OTP_WORKER_SECRET_HERE";
```
Replace both with the URL from step 5 and the secret from step 4. Save,
re-upload/redeploy the site. Until these two are filled in, the site
automatically keeps using the old client-side OTP flow (same fallback pattern
as file upload before the R2 Worker is configured) — so nothing breaks if you
deploy the site before the Worker.

## What changed in the HTML
- `requestOtpFromServer(email, name)` and `verifyOtpWithServer(email, code)`
  now do the real work; `generateOtpCode()` / local `otp` fields are only used
  in the fallback path.
- Registration, resend, forgot-password-send, and forgot-password-verify all
  route through these two functions first, and only fall back to the old
  local flow if `OTP_WORKER_URL` still has the placeholder text.
- Rate limiting: the Worker refuses a new send within 30s of the last one for
  the same email, and locks out after 5 wrong verify attempts (matches your
  old 5-attempt limit) — enforced server-side now, not just in the UI.
