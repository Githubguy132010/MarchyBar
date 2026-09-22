import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MarchyBar } from '../backend/server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(ROOT, 'index.html'));
const METHODS = new Set(['get', 'simulate', 'preset.apply', 'automatic', 'page']);

// The same session the reference editor shows before an app rule matches.
export const REFERENCE_SESSION = {
  app: '',
  title: '',
  workspace: 1,
  workspaces: [1, 2, 3, 4, 5].map(id => ({ id })),
  volume: 62,
  brightness: 48,
  keyboard: 30,
  battery: 81,
  charging: false,
  cpu: 14,
  memory: 46,
  media: {},
};

export async function startEmulator({
  port = 8765,
  host = '127.0.0.1',
  open = false,
  runtimeDir = path.join('/tmp', 'marchybar-emulator'),
} = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const framePath = path.join(runtimeDir, 'frame.png');
  const app = new MarchyBar({
    socketPath: path.join(runtimeDir, 'control.sock'),
    configDir: path.join(runtimeDir, 'config'),
    stateDir: path.join(runtimeDir, 'state'),
    previewOnly: true,
    live: false,
  });
  await app.start();
  await app.handle({ id: 0, method: 'simulate', params: { data: REFERENCE_SESSION } });

  let chain = Promise.resolve();
  const exclusive = job => {
    const run = chain.then(job);
    chain = run.then(() => {}, () => {});
    return run;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/frame.png') {
      exclusive(() => {
        app.capturePreview(framePath);
        const body = fs.readFileSync(framePath);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': body.length });
        res.end(body);
      }).catch(error => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error.message);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        exclusive(async () => {
          let message;
          try { message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch { throw new Error('Invalid JSON'); }
          if (!METHODS.has(message.method)) throw new Error('Unknown emulator request');
          await app.handle({ id: 1, method: message.method, params: message.params || {} });
          const body = JSON.stringify({ ok: true, state: app.snapshot() });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        }).catch(error => {
          const body = JSON.stringify({ ok: false, error: error.message });
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        });
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  const clock = setInterval(() => {
    exclusive(() => app.handle({ id: 1, method: 'simulate', params: {} })).catch(() => {});
  }, 1000);

  async function stop() {
    clearInterval(clock);
    await new Promise(resolve => server.close(resolve));
    await chain.catch(() => {});
    await app.stop();
  }

  if (open) openWindow(url);
  return { url, port: actualPort, stop, app };
}

function openWindow(url) {
  if (!process.env.DISPLAY) return;
  const chrome = process.env.MARCHYBAR_CHROME || 'google-chrome';
  const child = spawn(chrome, [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--force-device-scale-factor=1',
    `--user-data-dir=${path.join('/tmp', 'marchybar-emulator-chrome')}`,
    '--window-size=1880,980',
    '--window-position=20,40',
    '--class=marchybar-emulator',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 8765;
  startEmulator({ port, open: !process.argv.includes('--no-open') }).then(emulator => {
    console.log(`MarchyBar Touch Bar emulator ${emulator.url}`);
    const shutdown = () => emulator.stop().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
