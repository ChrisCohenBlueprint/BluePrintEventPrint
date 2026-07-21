// Admin sign-in: password, then a 2FA step that is either first-time enrolment
// or a returning-user code check. The server decides which.
(function () {
  'use strict';

  const nextUrl = new URLSearchParams(location.search).get('next') || '/admin';
  let pending = null;              // short-lived token tying the two steps together
  let recoveryMode = false;

  const $ = (id) => document.getElementById(id);
  const errBox = $('err');
  const forms = { password: $('form-password'), enrol: $('form-enrol'), verify: $('form-verify') };

  function showError(msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); }
  function clearError() { errBox.classList.add('hidden'); errBox.textContent = ''; }

  function showStep(step) {
    Object.values(forms).forEach(f => f.classList.add('hidden'));
    forms[step].classList.remove('hidden');
    const focusEl = { password: 'username', enrol: 'enrol-code', verify: 'verify-code' }[step];
    setTimeout(() => $(focusEl)?.focus(), 30);
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // ── Step 1: password ────────────────────────────────────────────────────────
  forms.password.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = $('btn-password'); btn.disabled = true; btn.textContent = 'Checking…';

    const { ok, data } = await post('/login', {
      username: $('username').value.trim(), password: $('password').value,
    });
    btn.disabled = false; btn.textContent = 'Continue';

    if (!ok) return showError(data.error || 'Sign in failed.');
    pending = data.pending;

    if (data.step === 'enrol') {
      if (data.qr) $('enrol-qr-img').src = data.qr;
      $('enrol-secret').textContent = data.secret || '';
      $('recovery-codes').replaceChildren(...(data.recoveryCodes || []).map(c => {
        const d = document.createElement('div'); d.textContent = c; return d;
      }));
      showStep('enrol');
    } else {
      showStep('verify');
    }
  });

  // ── Step 2a: confirm enrolment ────────────────────────────────────────────────
  forms.enrol.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = $('btn-enrol'); btn.disabled = true; btn.textContent = 'Verifying…';

    const { ok, data } = await post('/login/enrol', {
      pending, token: $('enrol-code').value.trim(), next: nextUrl,
    });
    btn.disabled = false; btn.textContent = 'Confirm & sign in';

    if (!ok) return showError(data.error || 'That code did not match.');
    location.href = data.next || '/admin';
  });

  // ── Step 2b: verify code / recovery ───────────────────────────────────────────
  forms.verify.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = $('btn-verify'); btn.disabled = true; btn.textContent = 'Signing in…';

    const { ok, data } = await post('/login/verify', {
      pending, token: $('verify-code').value.trim(), recovery: recoveryMode, next: nextUrl,
    });
    btn.disabled = false; btn.textContent = 'Sign in';

    if (!ok) return showError(data.error || 'Incorrect code.');
    location.href = data.next || '/admin';
  });

  // Toggle to recovery-code entry if the phone is lost.
  $('use-recovery').addEventListener('click', () => {
    recoveryMode = !recoveryMode;
    const codeInput = $('verify-code');
    if (recoveryMode) {
      $('verify-label').textContent = 'Recovery code';
      $('verify-sub').textContent = 'Enter one of the recovery codes you saved during setup.';
      codeInput.removeAttribute('maxlength'); codeInput.removeAttribute('inputmode');
      $('use-recovery').textContent = 'Use your authenticator code instead';
      codeInput.style.letterSpacing = 'normal'; codeInput.style.fontSize = '15px';
    } else {
      $('verify-label').textContent = 'Authentication code';
      $('verify-sub').textContent = 'Enter the 6-digit code from your authenticator app.';
      codeInput.setAttribute('maxlength', '6'); codeInput.setAttribute('inputmode', 'numeric');
      $('use-recovery').textContent = 'Lost your phone? Use a recovery code';
      codeInput.style.letterSpacing = ''; codeInput.style.fontSize = '';
    }
    codeInput.value = ''; codeInput.focus();
  });
})();
