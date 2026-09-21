// Admin sign-in: password, then a 2FA step that is either first-time enrolment
// or a returning-user code check. The server decides which.
(function () {
  'use strict';

  // Left empty when there's no ?next, so the SERVER decides where to land —
  // an administrator goes to /admin, a sales rep to /sales. Hard-coding /admin
  // here would send a rep to a page their role cannot open.
  const nextUrl = new URLSearchParams(location.search).get('next') || '';
  let pending = null;              // short-lived token tying the two steps together
  let recoveryMode = false;

  // The pending token the server issues lives five minutes. Scanning a QR code
  // and writing down eight recovery codes routinely takes longer, and what used
  // to happen then was the worst of both worlds: "Session expired. Please start
  // again." appeared above an enrolment form that stayed on screen, so the
  // obvious next move — reload, or type the code anyway — regenerated the secret
  // and silently invalidated the eight codes the user had just written out.
  // These two hold the deadline so the page can warn BEFORE that happens and
  // put the user back where starting again actually begins.
  const ENROL_TTL_MS = 5 * 60 * 1000;
  let enrolDeadline = 0;
  let enrolTimer = null;

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
      claim: $('claim')?.value.trim() || undefined,   // only used on first-login enrolment
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
      startEnrolCountdown();
      showStep('enrol');
    } else {
      showStep('verify');
    }
  });

  /**
   * Count the enrolment window down in plain sight.
   *
   * The deadline is real either way; the only question is whether the user finds
   * out about it before or after they have finished copying the codes.
   */
  function startEnrolCountdown() {
    clearInterval(enrolTimer);
    enrolDeadline = Date.now() + ENROL_TTL_MS;
    const note = $('enrol-timer');
    const tick = () => {
      const left = Math.max(0, enrolDeadline - Date.now());
      if (left <= 0) { clearInterval(enrolTimer); return enrolExpired(); }
      const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
      if (note) {
        note.textContent = `Finish within ${m}:${String(sec).padStart(2, '0')} — after that these recovery codes stop working and you will be given a new set.`;
        note.classList.toggle('warn', left < 60000);
        note.classList.remove('hidden');
      }
    };
    tick();
    enrolTimer = setInterval(tick, 1000);
  }

  function stopEnrolCountdown() {
    clearInterval(enrolTimer);
    enrolTimer = null;
    $('enrol-timer')?.classList.add('hidden');
  }

  /**
   * The window closed. Put the user back at the password step — which is where
   * starting again actually starts — and blank the codes, so nobody carries on
   * copying down eight strings that no longer open anything.
   */
  function enrolExpired() {
    stopEnrolCountdown();
    pending = null;
    $('recovery-codes').replaceChildren();
    $('enrol-secret').textContent = '';
    $('enrol-qr-img').removeAttribute('src');
    $('enrol-code').value = '';
    $('password').value = '';
    showStep('password');
    showError('That setup window closed before it was confirmed, so those recovery codes are no longer valid. Sign in again and you will be given a fresh QR code and a fresh set of codes to write down.');
  }

  // ── Step 2a: confirm enrolment ────────────────────────────────────────────────
  forms.enrol.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = $('btn-enrol'); btn.disabled = true; btn.textContent = 'Verifying…';

    const { ok, status, data } = await post('/login/enrol', {
      pending, token: $('enrol-code').value.trim(), next: nextUrl,
    });
    btn.disabled = false; btn.textContent = 'Confirm & sign in';

    // 440 is the server saying the pending token is gone. Leaving the enrolment
    // form on screen under that message was the trap — there is nothing on it
    // that can still work.
    if (status === 440) return enrolExpired();
    if (!ok) return showError(data.error || 'That code did not match.');
    stopEnrolCountdown();
    location.href = data.next || '/admin';
  });

  // Starting over is offered rather than left to a reload, and it says what it
  // costs first — a reload was doing exactly this, silently.
  $('enrol-restart')?.addEventListener('click', () => {
    if (!confirm('Start the setup again?\n\nYou will get a new QR code and a new set of recovery codes. The eight codes on screen now will stop working.')) return;
    enrolExpired();
    clearError();
  });

  // ── Step 2b: verify code / recovery ───────────────────────────────────────────
  forms.verify.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = $('btn-verify'); btn.disabled = true; btn.textContent = 'Signing in…';

    const { ok, status, data } = await post('/login/verify', {
      pending, token: $('verify-code').value.trim(), recovery: recoveryMode, next: nextUrl,
    });
    btn.disabled = false; btn.textContent = 'Sign in';

    // Same dead end on this step: the code field cannot be made to work once
    // the pending token has gone, so send the user back to the password.
    if (status === 440) {
      pending = null;
      $('verify-code').value = '';
      $('password').value = '';
      showStep('password');
      return showError('That sign-in took too long and timed out. Enter your password again.');
    }
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
      // pattern="[0-9]*" has to go with them. A recovery code is hex with
      // dashes (xxxxx-xxxxx-xxxxx), so with the digits-only pattern still on the
      // field the browser refused to submit the form at all and showed its own
      // "match the requested format" tooltip — the lost-phone path was dead.
      codeInput.removeAttribute('maxlength');
      codeInput.removeAttribute('inputmode');
      codeInput.removeAttribute('pattern');
      codeInput.placeholder = 'xxxxx-xxxxx-xxxxx';
      $('use-recovery').textContent = 'Use your authenticator code instead';
      codeInput.style.letterSpacing = 'normal'; codeInput.style.fontSize = '15px';
    } else {
      $('verify-label').textContent = 'Authentication code';
      $('verify-sub').textContent = 'Enter the 6-digit code from your authenticator app.';
      codeInput.setAttribute('maxlength', '6');
      codeInput.setAttribute('inputmode', 'numeric');
      codeInput.setAttribute('pattern', '[0-9]*');
      codeInput.removeAttribute('placeholder');
      $('use-recovery').textContent = 'Lost your phone? Use a recovery code';
      codeInput.style.letterSpacing = ''; codeInput.style.fontSize = '';
    }
    codeInput.value = ''; codeInput.focus();
  });
})();
