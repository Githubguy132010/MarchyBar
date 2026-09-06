import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.mjs';
const socketPath = process.env.MARCHYBAR_SOCKET || path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'marchybar', 'control.sock');
const args = process.argv.slice(2), command = args.shift();
let nextId = 1;
const pending = new Map();
const socket = net.createConnection(socketPath);
socket.setEncoding('utf8');
let buffer = '';
socket.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error)); } } });
function request(method, params = {}, revision) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ id, method, params, revision }) + '\n'); }); }
const timer = setTimeout(() => { console.error('MarchyBar request timed out'); socket.destroy(); process.exitCode = 1; }, 20000);
try {
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let result;
  switch (command) {
    case 'status': { const s = await request('get'); result = { status: s.status, activePreset: s.activePreset, reason: s.reason, error: s.error }; break; }
    case 'list': result = (await request('get')).presets.map(p => ({ id: p.id, name: p.name, customized: p.customized })); break;
    case 'apply': result = await request('preset.apply', { id: args[0] }); break;
    case 'auto': result = await request('automatic'); break;
    case 'enable': result = await request('hardware.enable'); break;
    case 'disable': result = await request('hardware.disable'); break;
    case 'diagnostics': result = await request('diagnostics'); break;
    case 'import': { const s = await request('get'); result = await request('preset.import', { preset: JSON.parse(fs.readFileSync(args[0], 'utf8')) }, s.revision); break; }
    case 'export': if (!args[0] || !args[1]) throw new Error('Usage: marchybar export ID FILE'); result = await request('preset.export', { id: args[0] }); atomicWrite(path.resolve(args[1]), result); result = { exported: path.resolve(args[1]) }; break;
    case 'request': result = await request(args[0], args[1] ? JSON.parse(args[1]) : {}, (await request('get')).revision); break;
    default: throw new Error('Unknown command. Run marchybar help.');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message.includes('ENOENT') ? 'MarchyBar is not running. Enable the Omarchy plugin or run marchybar daemon.' : e.message); process.exitCode = 1; }
finally { clearTimeout(timer); socket.destroy(); }
