// ─── BluePrint EventPrint — shared front-end helpers ──────────────────────────
//
// admin.js and sales.js had grown their own copies of the same six or seven
// helpers, and the copies had already drifted: sales.js knew how to treat a 401
// as "your session ended, go and sign in", admin.js did not and rendered an
// empty dashboard instead; sales.js had a working `money()`, admin.js called one
// that was never defined and threw mid-broadcast. One copy, loaded before both
// pages, is what stops that happening again.
//
// A plain global script rather than a module: admin.js is a 3,800-line global
// script and the pages load their scripts with <script src>, so `window.UI` is
// the shape both can reach without restructuring either.
(function (global) {
  'use strict';

  // ── Text ────────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  /** Build an element. Text is set as a TEXT node — never as markup. */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const byId = (id) => document.getElementById(id);

  // ── Money ───────────────────────────────────────────────────────────────────
  // The symbol belongs to the SHOW, not to this file: Europe prices in euros,
  // North America in dollars, and a number printed with the wrong symbol is
  // wrong in front of a client. '€' until a show says otherwise, so a show that
  // has never set one prints exactly as it always did.
  let CURRENCY = '€';

  /** Called from the pages whenever the show's settings arrive. */
  function setCurrency(symbol) { if (symbol) CURRENCY = String(symbol); }
  const currency = () => CURRENCY;

  /**
   * Format a price for display.
   *
   * Null/blank/unparseable becomes an em dash rather than "€NaN" — an empty
   * deal price is a normal state, not an error. Matches the signature sales.js
   * already used, because the admin's Move preview called a `money()` that was
   * never defined at all: picking both dropdowns threw, and because that ran
   * inside the state:full handler every later broadcast threw with it, freezing
   * the search list, the tag counts and the plan repaint until a reload.
   */
  const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)))
    ? '—'
    : CURRENCY + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  // ── Toast ───────────────────────────────────────────────────────────────────
  // Two pages, two existing toast elements and two class conventions, so the
  // element and its classes are parameters rather than baked in.
  const toastTimers = new Map();

  function toast(msg, kind = '', opts = {}) {
    const id = opts.id || 'toast';
    const base = opts.cls || 'toast';
    const shown = opts.show || '';
    const ms = opts.ms || 3200;

    let node = byId(id);
    if (!node) {
      node = el('div', base);
      node.id = id;
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.replaceChildren(document.createTextNode(msg));
    node.className = [base, shown, kind].filter(Boolean).join(' ');
    node.classList.remove('hidden');

    clearTimeout(toastTimers.get(id));
    toastTimers.set(id, setTimeout(() => {
      node.className = base;
      if (!shown) node.classList.add('hidden');
    }, ms));
    return node;
  }

  /**
   * A toast carrying one action, for a change that should be reversible for a
   * moment rather than permanent the instant it happens.
   *
   * Resolves when the window closes either way, so the caller can clean up.
   */
  function toastAction(msg, { label, onAction, kind = '', ms = 10000, id = 'toast', cls = 'toast', show = '' } = {}) {
    const node = toast(msg, kind, { id, cls, show, ms });
    if (!label || typeof onAction !== 'function') return node;

    const btn = el('button', 'toast-action', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      clearTimeout(toastTimers.get(id));
      node.className = cls;
      if (!show) node.classList.add('hidden');
      onAction();
    });
    node.appendChild(btn);

    // A countdown, because "you have a few seconds" is only useful if you can
    // see how many are left.
    const left = el('span', 'toast-count', '');
    node.appendChild(left);
    const until = Date.now() + ms;
    const tick = () => {
      const s = Math.ceil((until - Date.now()) / 1000);
      if (s <= 0 || !node.contains(left)) return clearInterval(timer);
      left.textContent = `${s}s`;
    };
    const timer = setInterval(tick, 500);
    tick();
    setTimeout(() => clearInterval(timer), ms + 100);
    return node;
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────
  /**
   * Fetch wrapper that treats an auth failure as an auth failure.
   *
   * A 401 means the 12h session expired mid-session; bouncing to the login page
   * is the only useful response. Without this the admin console rendered "No
   * enquiries yet", an empty team table and "No events yet" — an expired cookie
   * presented as a genuinely empty event, which is the most misleading thing it
   * could have said. A 403 means the account isn't allowed here at all, which
   * is a different message and NOT a redirect (a rep bounced to /login just
   * loops back).
   */
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: opts.body ? { 'Content-Type': 'application/json', ...(opts.headers || {}) }
                         : (opts.headers || {}),
      ...opts,
    });
    if (res.status === 401) {
      const next = location.pathname + location.search;
      location.href = '/login?next=' + encodeURIComponent(next);
      throw new Error('Your session has ended — signing you back in.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* an empty body is fine on a 200 */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // ── Socket ──────────────────────────────────────────────────────────────────
  /**
   * socket.emit with its acknowledgement as a promise.
   *
   * Always resolves — never rejects — so a caller can `await` it and branch on
   * `ok` without a try/catch around every action. A server that never answers
   * resolves as a failure rather than leaving a button disabled forever, which
   * is what a bare emit+callback does when the connection drops mid-action.
   */
  function emitAck(socket, event, payload, { timeout = 20000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
      const timer = setTimeout(() => finish({
        ok: false, error: 'The server did not answer. Check your connection and try again.',
      }), timeout);
      try {
        socket.emit(event, payload, (res) => finish(res || { ok: false, error: 'No response from the server.' }));
      } catch (e) {
        finish({ ok: false, error: e.message || 'Could not send that action.' });
      }
    });
  }

  // ── Double-submit guard ─────────────────────────────────────────────────────
  /**
   * Run an action with its button held down until it finishes.
   *
   * Ten forms had no guard at all, and the second click of an impatient
   * double-click was genuinely sent: Split answered "done" and then "already
   * split — reset it first", and Add administrator answered 409. The button,
   * not a module-level flag, holds the state, so two different forms can still
   * be submitted at once.
   */
  async function withPending(btn, fn) {
    if (!btn) return fn();
    if (btn.dataset.pending === '1') return undefined;   // the duplicate click
    btn.dataset.pending = '1';
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-pending');
    try {
      return await fn();
    } finally {
      delete btn.dataset.pending;
      btn.disabled = wasDisabled;
      btn.classList.remove('is-pending');
    }
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────────
  // Passwords and the recovery key were typed into window.prompt(), which shows
  // them in clear text and leaves them in the browser's dialog history. A
  // <dialog> with a real password field masks the value and keeps it out of any
  // history, and — unlike prompt() — it can say what the password is FOR.
  //
  // The styles are injected from here rather than from admin.css/sales.css so
  // one definition covers both pages and neither can drift.
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'bp-ui-styles';
    style.textContent = `
      .bp-dialog { border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 0;
        background: #111928; color: #f1f5f9; font-family: 'Raleway', system-ui, sans-serif;
        width: min(420px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(0,0,0,.55); }
      .bp-dialog::backdrop { background: rgba(3,6,12,.66); backdrop-filter: blur(2px); }
      .bp-dialog-body { padding: 22px 22px 16px; }
      .bp-dialog-title { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
      .bp-dialog-msg { font-size: 13px; line-height: 1.55; color: #cbd5e1; white-space: pre-wrap; }
      .bp-dialog-field { margin-top: 14px; }
      .bp-dialog-field label { display: block; font-size: 10.5px; text-transform: uppercase;
        letter-spacing: .07em; color: #64748b; margin-bottom: 6px; }
      .bp-dialog-field input { width: 100%; background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 10px 12px;
        color: inherit; font-family: inherit; font-size: 14px; outline: none; }
      .bp-dialog-field input:focus { border-color: #6366f1; }
      .bp-dialog-foot { display: flex; justify-content: flex-end; gap: 8px;
        padding: 12px 22px 18px; }
      .bp-dialog-btn { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05);
        color: inherit; font-family: inherit; font-size: 13px; font-weight: 600;
        padding: 9px 16px; border-radius: 8px; cursor: pointer; }
      .bp-dialog-btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
      .bp-dialog-btn.danger  { background: #b91c1c; border-color: #b91c1c; color: #fff; }
      .bp-dialog-btn:hover { filter: brightness(1.12); }
      .is-pending { opacity: .6; cursor: progress !important; }
      .toast-action { margin-left: 12px; border: 1px solid currentColor; background: transparent;
        color: inherit; font-family: inherit; font-size: 12px; font-weight: 700; padding: 3px 10px;
        border-radius: 6px; cursor: pointer; }
      .toast-count { margin-left: 8px; font-size: 11px; opacity: .7; }
    `;
    document.head.appendChild(style);
  }

  /** Build a <dialog>, run it, and always clean it up. */
  function runDialog(build) {
    injectStyles();
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'bp-dialog';
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        try { dlg.close(); } catch { /* already closed */ }
        dlg.remove();
      };
      build(dlg, close);
      document.body.appendChild(dlg);
      // Escape fires 'cancel'; treat it as "no", the same as the Cancel button.
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      dlg.showModal();
    });
  }

  /**
   * Ask for a password or recovery key. Resolves with the string, or null if
   * the operator backed out — the same contract prompt() had, so every call
   * site's "cancelled" branch still reads the same way.
   */
  function askSecret(message, { title = 'Confirm it is you', label = 'Password', confirmLabel = 'Confirm' } = {}) {
    return runDialog((dlg, close) => {
      const body = el('div', 'bp-dialog-body');
      body.append(el('div', 'bp-dialog-title', title), el('div', 'bp-dialog-msg', message));

      const field = el('div', 'bp-dialog-field');
      const id = 'bp-secret-' + Math.random().toString(36).slice(2, 8);
      const lab = el('label', null, label); lab.htmlFor = id;
      const input = document.createElement('input');
      input.type = 'password';                       // masked, and never in dialog history
      input.id = id;
      input.autocomplete = 'current-password';
      field.append(lab, input);
      body.appendChild(field);

      const foot = el('div', 'bp-dialog-foot');
      const cancel = el('button', 'bp-dialog-btn', 'Cancel'); cancel.type = 'button';
      const go = el('button', 'bp-dialog-btn primary', confirmLabel); go.type = 'button';
      cancel.addEventListener('click', () => close(null));
      go.addEventListener('click', () => close(input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close(input.value); } });
      foot.append(cancel, go);

      dlg.append(body, foot);
      setTimeout(() => input.focus(), 30);
    });
  }

  /**
   * Confirm a consequential action. Resolves true/false.
   *
   * Takes the same place window.confirm() did, but the message can be several
   * lines and the confirm button can be named for the thing it does — "Retire
   * this event" reads as what will happen in a way "OK" never did.
   */
  function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
    return runDialog((dlg, close) => {
      const body = el('div', 'bp-dialog-body');
      body.append(el('div', 'bp-dialog-title', title), el('div', 'bp-dialog-msg', message));

      const foot = el('div', 'bp-dialog-foot');
      const cancel = el('button', 'bp-dialog-btn', 'Cancel'); cancel.type = 'button';
      const go = el('button', `bp-dialog-btn ${danger ? 'danger' : 'primary'}`, confirmLabel); go.type = 'button';
      cancel.addEventListener('click', () => close(false));
      go.addEventListener('click', () => close(true));
      foot.append(cancel, go);

      dlg.append(body, foot);
      setTimeout(() => go.focus(), 30);
    }).then(v => v === true);
  }

  global.UI = {
    esc, cap, el, byId,
    money, setCurrency, currency,
    toast, toastAction,
    api, emitAck, withPending,
    askSecret, confirmDialog,
  };
})(window);
