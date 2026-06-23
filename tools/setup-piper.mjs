// Auto-setup for Piper TTS. Run: npm run setup-piper
// 1) installs the piper-tts engine via pip (cross-platform wheels: Windows, Linux, Pi/aarch64)
// 2) downloads a set of natural-sounding voices into ./voices
// Degrades gracefully: if a step fails it prints manual instructions and the app still
// runs (kiosk falls back to browser speech until Piper is ready).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICES = path.join(ROOT, 'voices');
fs.mkdirSync(VOICES, { recursive: true });

// Prefer "-high" quality (much less robotic than "-medium"); a couple of well-liked
// voices for variety. Browse more at https://rhasspy.github.io/piper-samples/
const WANT = [
  'en_US-lessac-high',       // clear, natural (default)
  'en_US-ryan-high',         // warm male
  'en_GB-jenny_dioco-medium',// friendly British female
  'en_US-amy-medium',        // light, gentle
  'en_US-hfc_female-medium', // neutral female
];
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const log = (...a) => console.log(...a);

function findPython() {
  for (const py of (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])) {
    if (spawnSync(py, ['--version'], { encoding: 'utf8' }).status === 0) return py;
  }
  return null;
}
function run(py, args) { return spawnSync(py, args, { stdio: 'inherit' }).status === 0; }

// voiceId "en_US-amy-medium" -> "en/en_US/amy/medium/en_US-amy-medium"
function hfPath(id) {
  const [lang, name, quality] = id.split('-');
  return `${lang.split('_')[0]}/${lang}/${name}/${quality}/${id}`;
}
async function manualDownload(id) {
  for (const ext of ['.onnx', '.onnx.json']) {
    const dest = path.join(VOICES, id + ext);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { log(`  • ${id}${ext} (present)`); continue; }
    process.stdout.write(`  • ${id}${ext} … `);
    const res = await fetch(`${HF}/${hfPath(id)}${ext}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    log('ok');
  }
}

(async () => {
  log('Wondry — Piper setup');
  const py = findPython();
  let engineOk = false;
  if (py) { log(`\n→ Installing piper-tts via ${py} -m pip …`); engineOk = run(py, ['-m', 'pip', 'install', '--upgrade', 'piper-tts']); }
  else log('\n✗ Python not found. Install Python 3, then re-run — or set PIPER_CMD in .env to a piper binary.');

  log('\n→ Downloading voices into ./voices …');
  let got = 0;
  if (engineOk) {
    // official downloader: resolves paths correctly and verifies files
    if (run(py, ['-m', 'piper.download_voices', ...WANT, '--data-dir', VOICES])) {
      got = WANT.filter((id) => fs.existsSync(path.join(VOICES, id + '.onnx'))).length;
    }
  }
  if (got === 0) {
    // fallback: fetch from Hugging Face directly
    for (const id of WANT) {
      try { await manualDownload(id); got++; } catch (e) { log(`  ✗ ${id}: ${e.message}`); }
    }
  }

  log('\n──────────────────────────────────────────');
  log(`Voices ready: ${got}/${WANT.length}   Engine: ${engineOk ? 'piper-tts (python -m piper)' : 'NOT installed'}`);
  if (!engineOk) {
    log('\nFinish the engine install manually:');
    log('  • pip install piper-tts');
    log('  • or set PIPER_CMD in .env to a piper binary path');
  }
  log('\nTune the voice in config.json -> tts.synthArgs, e.g.:');
  log('  ["--sentence-silence","0.4","--length-scale","1.1"]   (length-scale > 1 = slower/calmer)');
  log('Restart the server (npm start), then use the ▶ buttons in the Kids tab to compare voices.');
})();
