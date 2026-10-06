/**
 * Run the real `node server.js` for a suite, against the in-memory database
 * (test/stub-db-preload.js), on a free port.
 *
 * What only the process itself can show — the Socket.IO server's options, what
 * shutdown waits for — is tested here rather than against a copy of it.
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { io: connect } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * Start the server. Resolves once it is listening, to
 * { base, output(), waitFor(re, ms), exited, kill(signal), client(opts) }.
 */
async function start(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'stub-db-preload.js'), 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, SHOW_ID: 'LEX', SHOWS: '', PORT: String(port), NOTIFY_WEBHOOK: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));

  const waitFor = (re, ms = 8000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (re.test(out)) return resolve(true);
      if (proc.exitCode !== null || Date.now() - started > ms) return reject(new Error(`never saw ${re}:\n${out}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  await waitFor(/port \d+/);

  const base = `http://127.0.0.1:${port}`;
  const opened = [];
  const client = async ({ cookie = null } = {}) => {
    const s = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false,
      query: { show: 'lex' }, extraHeaders: cookie ? { cookie } : {} });
    opened.push(s);
    await new Promise((resolve, reject) => { s.once('ready', resolve); s.once('connect_error', reject); });
    return s;
  };
  const kill = (signal = 'SIGTERM') => { opened.forEach(s => s.disconnect()); proc.kill(signal); return exited; };
  return { base, output: () => out, waitFor, exited, kill, client };
}

/** Emit with an acknowledgement; { timeout: true } if none comes. */
const ask = (s, event, payload, ms = 4000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), ms);
  s.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
});

module.exports = { start, ask };
