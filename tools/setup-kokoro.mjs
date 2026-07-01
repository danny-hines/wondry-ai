// Setup for the Kokoro TTS sidecar (optional, more-natural voice). Run: npm run setup-kokoro
// 1) installs kokoro-onnx + onnxruntime into a dedicated venv (.venv-kokoro) — no torch
// 2) downloads the quantized (int8) Kokoro model + voices into ./kokoro
// 3) points Wondry at it (.env KOKORO_URL) and prints how to run it (now + as a service)
// The sidecar (tools/kokoro/server.py) exposes the OpenAI-compatible endpoint the app
// already speaks. Degrades gracefully: on any failure it prints manual steps.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KDIR = path.join(ROOT, 'kokoro');
fs.mkdirSync(KDIR, { recursive: true });

const VENV = path.join(ROOT, '.venv-kokoro');
const venvPython = path.join(VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const PORT = process.env.KOKORO_PORT || '8880';
const KOKORO_URL = `http://127.0.0.1:${PORT}/v1/audio/speech`;

// int8 = fastest/smallest; swap to kokoro-v1.0.fp16.onnx if int8 quality disappoints.
const REL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const FILES = ['kokoro-v1.0.int8.onnx', 'voices-v1.0.bin'];

const log = (...a) => console.log(...a);
function findPython() {
  for (const py of (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])) {
    if (spawnSync(py, ['--version'], { encoding: 'utf8' }).status === 0) return py;
  }
  return null;
}
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;

async function download(name) {
  const dest = path.join(KDIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { log(`  • ${name} (present)`); return true; }
  process.stdout.write(`  • ${name} … `);
  try {
    const res = await fetch(`${REL}/${name}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    log('ok'); return true;
  } catch (e) { log(`✗ ${e.message}`); return false; }
}

(async () => {
  log('Wondry — Kokoro sidecar setup\n');
  const py = findPython();
  let engineOk = false;
  if (!py) {
    log('✗ Python 3 not found. Install it, then re-run.');
  } else {
    if (!fs.existsSync(venvPython)) {
      log(`→ Creating venv at ${VENV} …`);
      if (!run(py, ['-m', 'venv', VENV])) log('✗ venv failed. On Debian/Pi: sudo apt-get install -y python3-venv, then re-run.');
    }
    if (fs.existsSync(venvPython)) {
      log('→ Installing kokoro-onnx + onnxruntime into the venv (this can take a few minutes on a Pi) …');
      run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      engineOk = run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'kokoro-onnx', 'onnxruntime']);
    }
  }

  log('\n→ Downloading the Kokoro model + voices into ./kokoro …');
  let got = 0;
  for (const f of FILES) if (await download(f)) got++;

  // Point Wondry at the sidecar (idempotent; harmless if the server isn't running yet —
  // only kids whose Voice is a "kokoro:" one use it, and they fall back to browser if down).
  const envPath = path.join(ROOT, '.env');
  try {
    const cur = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (!/^KOKORO_URL=/m.test(cur)) { fs.appendFileSync(envPath, `${cur.endsWith('\n') || !cur ? '' : '\n'}KOKORO_URL=${KOKORO_URL}\n`); log(`\n✓ Added KOKORO_URL to .env`); }
    else log(`\n• KOKORO_URL already in .env`);
  } catch { log('\n! Could not edit .env — add this line yourself: KOKORO_URL=' + KOKORO_URL); }

  const nodeBin = process.execPath;
  log('\n──────────────────────────────────────────');
  log(`Model files: ${got}/${FILES.length}   Engine: ${engineOk ? 'kokoro-onnx (venv)' : 'NOT installed'}`);
  if (!engineOk || got < FILES.length) {
    log('\nFinish manually:');
    if (!engineOk) log('  • sudo apt-get install -y python3-venv && npm run setup-kokoro   (re-run)');
    if (got < FILES.length) log(`  • download the model files from ${REL} into ./kokoro`);
  } else {
    log('\nTest it now (leave running in one terminal):');
    log(`  ${venvPython} ${path.join('tools', 'kokoro', 'server.py')}`);
    log('  # then in another terminal:');
    log(`  curl -s -o /tmp/k.wav -w "synth time: %{time_total}s\\n" -X POST ${KOKORO_URL} \\`);
    log(`    -H 'content-type: application/json' -d '{"input":"How natural does Kokoro sound now.","voice":"af_bella"}'`);
    log('  # (that clip is ~2.5s of audio — under that synth time = faster than real-time = gapless)');
    log('\nRun it on boot as a service (paste this block):');
    log(`  sudo tee /etc/systemd/system/wondry-kokoro.service >/dev/null <<UNIT
  [Unit]
  Description=Wondry Kokoro TTS sidecar
  After=network.target
  [Service]
  WorkingDirectory=${ROOT}
  Environment=KOKORO_PORT=${PORT}
  ExecStart=${venvPython} ${path.join(ROOT, 'tools', 'kokoro', 'server.py')}
  Restart=always
  User=${process.env.USER || 'pi'}
  [Install]
  WantedBy=multi-user.target
  UNIT
  sudo systemctl enable --now wondry-kokoro`);
    log('\nThen:  wondry restart   →   parent console → Kids → Voice → Kokoro → pick one → ▶ Hear voice.');
  }
  void nodeBin;
})();
