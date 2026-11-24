interface PairPageOptions {
  code: string
  telegramAvailable: boolean
}

/**
 * Phone-side pairing page. Kept dependency-free so it can be opened on any
 * phone browser; it talks only to the Relay backend. The glasses never see the
 * Telegram login code or API credentials.
 */
export function pairPage({ code, telegramAvailable }: PairPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="theme-color" content="#080b09">
<title>Relay — pair</title>
<style>
  :root { --ink:#d8ffe2; --dim:#7f9d87; --line:#1d2c22; --green:#67ff8b; --bg:#080b09; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:radial-gradient(1200px 600px at 50% -10%, #0f1a12 0%, var(--bg) 55%);
    color:var(--ink); font:15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:420px; border:1px solid var(--line); border-radius:14px; padding:28px 24px 22px; background:rgba(9,14,10,.92); box-shadow:0 30px 80px #0008; }
  .brand { letter-spacing:.38em; font-size:14px; color:var(--dim); }
  h1 { font-size:24px; line-height:1.2; margin:14px 0 6px; font-weight:500; }
  p { color:var(--dim); margin:0 0 18px; }
  label { display:block; font-size:11px; letter-spacing:.16em; color:var(--dim); margin:16px 0 6px; }
  input { width:100%; background:#050806; border:1px solid var(--line); color:var(--ink); border-radius:8px; padding:12px 12px; font:inherit; outline:none; }
  input:focus { border-color:#2d6b41; }
  input.code { font-size:26px; letter-spacing:.34em; text-align:center; padding:14px 8px; }
  button { width:100%; margin-top:14px; padding:12px 14px; border-radius:8px; border:1px solid #2a7a43; background:#0e2a17; color:#c9ffd7; font:inherit; cursor:pointer; }
  button:hover { background:#123a20; }
  button.ghost { background:transparent; border-color:var(--line); color:var(--dim); }
  .status { margin-top:16px; min-height:22px; color:var(--green); font-size:13px; }
  .status.err { color:#ff9b9b; }
  .step { display:none; }
  .step.active { display:block; }
  .meta { margin-top:18px; padding-top:14px; border-top:1px solid var(--line); color:#5d7464; font-size:11px; line-height:1.6; }
  .consent { display:flex; gap:10px; align-items:flex-start; margin-top:14px; color:var(--dim); font-size:12px; line-height:1.5; }
  .consent input { width:auto; margin:2px 0 0; accent-color:#67ff8b; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:10px; letter-spacing:.12em; color:var(--dim); }
  a { color:#8dffab; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">RELAY</div>
  <h1>Pair your glasses</h1>
  <p>Telegram stays on your account. The glasses get a device token, never your API keys or login code.</p>

  <section id="step-code" class="step active">
    <label for="code">CODE ON YOUR GLASSES</label>
    <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" value="${code}">
    <button id="code-next">Continue</button>
    <div class="meta"><span class="pill">DEMO</span> No code? Open the Relay app on your glasses and choose <strong>Connect Telegram</strong> from the menu.</div>
  </section>

  <section id="step-telegram" class="step">
    <label for="phone">TELEGRAM PHONE NUMBER</label>
    <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+971 50 123 4567">
    <label class="consent"><input type="checkbox" id="consent"> I understand Relay reads my most recent Telegram chats and sends a reply only when I tap send. I can disconnect and delete the session from the glasses at any time.</label>
    <label class="consent"><input type="checkbox" id="sms"> Send the login code by SMS instead of the Telegram app.</label>
    <button id="send-code">${telegramAvailable ? 'Send login code' : 'Telegram not configured'}</button>
    <button class="ghost" id="back-code">Back</button>
    <button class="ghost" id="bot-link">Use a bot token instead</button>
    <div class="meta">Use international format. Relay asks Telegram for a login code; the code is never stored.</div>
  </section>

  <section id="step-verify" class="step">
    <label for="phone-code">TELEGRAM LOGIN CODE</label>
    <input id="phone-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
    <button id="verify">Verify</button>
    <button class="ghost" id="resend">Resend</button>
  </section>

  <section id="step-password" class="step">
    <label for="password">TWO-STEP PASSWORD</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="Your Telegram 2FA password">
    <button id="password-next">Unlock</button>
    <div class="meta">Your password is forwarded once to Telegram and never persisted.</div>
  </section>

  <section id="step-bot" class="step">
    <label for="bot-token">TELEGRAM BOT TOKEN</label>
    <input id="bot-token" type="password" autocomplete="off" placeholder="123456789:AA...">
    <button id="bot-connect">Connect bot inbox</button>
    <button class="ghost" id="bot-back">Back</button>
    <div class="meta">Bot mode reads messages sent to the bot (or to groups it can access), never your personal DMs. Create a bot with <strong>@BotFather</strong>, send it a message, then connect.</div>
  </section>

  <section id="step-done" class="step">
    <h1 style="margin-top:0">Connected.</h1>
    <p id="done-copy">Relay is syncing your chats. Look at your glasses.</p>
    <button class="ghost" id="done-close">Done</button>
  </section>

  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div class="meta">Read-only until you send. Demo data is fictional. <a href="/health">status</a></div>
</main>
<script>
(function () {
  var state = { code: ${JSON.stringify(code)}, phone: '', telegram: ${telegramAvailable ? 'true' : 'false'} };
  var statusEl = document.getElementById('status');

  function show(id) {
    var steps = document.querySelectorAll('.step');
    for (var i = 0; i < steps.length; i++) steps[i].classList.remove('active');
    document.getElementById(id).classList.add('active');
  }
  function say(message, isError) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (isError ? ' err' : '');
  }
  async function post(path, body) {
    var res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
    return data;
  }
  function cleanCode(value) { return (value || '').replace(/\\D/g, '').slice(0, 6); }

  document.getElementById('code-next').addEventListener('click', function () {
    state.code = cleanCode(document.getElementById('code').value);
    if (state.code.length !== 6) { say('Enter the 6-digit code shown on your glasses.', true); return; }
    say('');
    show('step-telegram');
    if (!state.telegram) say('This server has no Telegram API credentials. Demo mode still works on the glasses.', true);
    document.getElementById('send-code').disabled = !state.telegram;
  });

  document.getElementById('back-code').addEventListener('click', function () { show('step-code'); say(''); });
  document.getElementById('bot-link').addEventListener('click', function () { show('step-bot'); say(''); });
  document.getElementById('bot-back').addEventListener('click', function () { show('step-telegram'); say(''); });
  document.getElementById('bot-connect').addEventListener('click', async function () {
    var token = document.getElementById('bot-token').value.trim();
    if (!token) { say('Paste the bot token from BotFather.', true); return; }
    say('Asking Telegram about the bot…');
    try {
      var data = await post('/api/pair/' + state.code + '/bot', { token: token });
      show('step-done');
      document.getElementById('done-copy').textContent = 'Synced ' + data.synced.threads + ' chats and ' + data.synced.messages + ' messages. Look at your glasses.';
      say('Bot connected.');
    } catch (err) { say(err.message, true); }
  });

  document.getElementById('send-code').addEventListener('click', async function () {
    if (!document.getElementById('consent').checked) { say('Please confirm the access note first.', true); return; }
    state.phone = document.getElementById('phone').value.trim();
    if (!state.phone) { say('Enter your phone number.', true); return; }
    say('Asking Telegram for a code…');
    try {
      var data = await post('/api/pair/' + state.code + '/telegram/start', { phone: state.phone, forceSMS: document.getElementById('sms').checked });
      say(data.isCodeViaApp ? 'Code sent in the Telegram app.' : 'Code sent by SMS.');
      show('step-verify');
      document.getElementById('phone-code').focus();
    } catch (err) { say(err.message, true); }
  });

  async function verify(password) {
    say(password ? 'Checking your password…' : 'Verifying…');
    try {
      var data = await post('/api/pair/' + state.code + '/telegram/verify', { phoneCode: cleanCode(document.getElementById('phone-code').value), password: password });
      if (data.status === 'password') {
        show('step-password');
        say(data.hint ? 'Hint: ' + data.hint : 'Two-step verification is on.');
        return;
      }
      show('step-done');
      say('');
      document.getElementById('done-copy').textContent = 'Synced ' + data.synced.threads + ' chats and ' + data.synced.messages + ' messages. Look at your glasses.';
    } catch (err) { say(err.message, true); }
  }

  document.getElementById('verify').addEventListener('click', function () {
    if (cleanCode(document.getElementById('phone-code').value).length < 4) { say('Enter the code Telegram sent you.', true); return; }
    verify(undefined);
  });

  document.getElementById('password-next').addEventListener('click', function () {
    var password = document.getElementById('password').value;
    if (!password) { say('Enter your two-step password.', true); return; }
    verify(password);
  });

  document.getElementById('resend').addEventListener('click', function () { show('step-telegram'); say(''); });
  document.getElementById('done-close').addEventListener('click', function () { show('step-done'); say('You can close this tab.'); });

  if (state.code.length === 6) {
    show('step-telegram');
    if (!state.telegram) { say('Telegram is not configured on this server. Demo mode still works.', true); document.getElementById('send-code').disabled = true; }
  }
})();
</script>
</body>
</html>`
}
