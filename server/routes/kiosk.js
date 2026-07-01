// Kiosk-side parent controls — lets a parent update/reload from the touchscreen
// without SSH. PIN-gated (the PIN lives in the KV store; default 0000, set in the
// parent console). Deliberately low-stakes: nothing here can break content/data.
//
// Update with no sudo: the systemd unit runs with Restart=always, so after a
// successful git pull + build the server simply exits and systemd brings it back
// up on the new code. We only act when running under systemd (INVOCATION_ID is set
// for service units), so a dev `npm start` can't accidentally kill itself.
import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKV } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
// npm sits next to the running node binary (true for NodeSource on the Pi and nvm).
const NPM = path.join(
  path.dirname(process.execPath),
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
);

export const router = express.Router();

const pin = () => String(getKV('kiosk_pin', '0000'));
export const isManaged = () => !!process.env.INVOCATION_ID; // set by systemd for service units
const okPin = (req) => String((req.body || {}).pin || '') === pin();

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(cmd, args, { cwd: ROOT });
    } catch (e) {
      return resolve({ code: -1, out: String(e) });
    }
    p.stdout?.on('data', (d) => {
      out += d;
    });
    p.stderr?.on('data', (d) => {
      out += d;
    });
    p.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const git = (...a) => run('git', a);

// Validate the PIN and report whether self-update is possible (so the kiosk can
// hide the Update option in dev / non-systemd runs).
router.post('/kiosk/verify', (req, res) => {
  res.json({ ok: okPin(req), managed: isManaged() });
});

router.post('/kiosk/update', async (req, res) => {
  if (!okPin(req)) return res.status(401).json({ status: 'bad-pin', error: 'Incorrect PIN.' });
  if (!isManaged())
    return res.status(400).json({ status: 'unmanaged', error: 'Updates run on the device only.' });

  const before = (await git('rev-parse', 'HEAD')).out.trim();
  const pull = await git('pull', '--rebase', '--autostash'); // --autostash keeps local config.json edits
  if (pull.code !== 0)
    return res.status(500).json({ status: 'error', error: pull.out.trim().slice(-400) });
  const after = (await git('rev-parse', 'HEAD')).out.trim();
  const rev = (await git('rev-parse', '--short', 'HEAD')).out.trim();
  if (before === after) return res.json({ status: 'up-to-date', rev });

  // Changed: tell the kiosk we're updating, then rebuild and self-exit in the
  // background. The kiosk polls /api/health and reloads once `boot` changes.
  res.json({ status: 'updating', rev });
  setImmediate(async () => {
    const install = await run(NPM, ['install', '--no-fund', '--no-audit']);
    if (install.code !== 0)
      return console.error('[kiosk update] npm install failed:\n' + install.out.slice(-800));
    const build = await run(NPM, ['run', 'build']);
    if (build.code !== 0)
      return console.error('[kiosk update] build failed:\n' + build.out.slice(-800));
    console.log(`[kiosk update] built ${rev} — exiting for systemd restart`);
    process.exit(0);
  });
});

export default router;
