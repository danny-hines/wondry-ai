// Content-quality eval CLI. An AI judge (Opus) scores generated content and chat
// replies; results land in the evals table so you can see what's weak and why,
// tighten the prompts, and re-run to watch the numbers move.
//
// Usage:
//   node --experimental-sqlite tools/eval-content.mjs                  # judge un-evaluated pages
//   node --experimental-sqlite tools/eval-content.mjs --kind reading
//   node --experimental-sqlite tools/eval-content.mjs --reeval         # re-judge with the current rubric
//   node --experimental-sqlite tools/eval-content.mjs --matrix         # generate a page subject×level grid + judge
//   node --experimental-sqlite tools/eval-content.mjs --chat           # run the conversation suite + judge
//   node --experimental-sqlite tools/eval-content.mjs --summary --kind chat
//
// Flags: --kind <page|reading|chat>  --limit N  --concurrency N  --batch NAME  --reeval  --matrix  --chat  --summary
import { liveGenerationEnabled } from '../server/config.js';
import { initSchema, evalSummary, listEvals } from '../server/db.js';
import { EVAL_DIMS } from '../server/services/evalJudge.js';
import { runContentEvals, runMatrixEvals, runChatEvals, runChatHistoryEvals } from '../server/services/evalRunner.js';

const has = (name) => process.argv.includes(`--${name}`);
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const kind = has('chat') ? 'chat' : (['page', 'reading', 'chat'].includes(arg('kind')) ? arg('kind') : 'page');

const fmt = (v) => (v == null ? '  — ' : v.toFixed(2).padStart(4));
function printSummary() {
  const s = evalSummary(kind);
  if (!s.n) { console.log(`\nNo ${kind} evals yet.`); return; }
  const cols = EVAL_DIMS[kind].map(([k, label]) => `${label} ${fmt(s.dims[k])}`).join('   ');
  console.log(`\n${kind} quality (latest per item, n=${s.n}):`);
  console.log(`  overall ${fmt(s.overall)}   ${cols}`);
  if (s.safetyConcerns) console.log(`  ⚠ ${s.safetyConcerns} item(s) flagged for safety`);
  const worst = listEvals(kind, 8).filter((e) => e.overall != null);
  if (worst.length) {
    console.log('\nWeakest:');
    for (const e of worst) console.log(`  ${fmt(e.overall)}  ${String(e.label || '').slice(0, 44).padEnd(44)}  ${String(e.verdict || '').slice(0, 56)}`);
  }
}

async function main() {
  initSchema();
  if (has('summary')) { printSummary(); return; }
  if (!liveGenerationEnabled()) {
    console.error('No API key set — the judge needs a live model (set ANTHROPIC_API_KEY in .env). Aborting.');
    process.exit(1);
  }

  const onProgress = (p) => process.stdout.write(`\r  ${p.done}/${p.total}  ${String(p.label || '').slice(0, 50).padEnd(50)}`);
  const t0 = Date.now();
  let res;
  if (has('matrix')) { console.log('Generating + judging a page matrix…'); res = await runMatrixEvals({ onProgress }); }
  else if (kind === 'chat' && has('history')) { console.log('Judging real conversations since the chat prompt last changed…'); res = await runChatHistoryEvals({ reeval: has('reeval'), onProgress }); }
  else if (kind === 'chat') { console.log('Running + judging the conversation suite…'); res = await runChatEvals({ onProgress }); }
  else {
    console.log(`Judging ${has('reeval') ? 'all' : 'un-evaluated'} ${kind} content…`);
    res = await runContentEvals({ kind, reeval: has('reeval'), limit: parseInt(arg('limit', '200'), 10), concurrency: parseInt(arg('concurrency', '4'), 10), batch: arg('batch'), onProgress });
  }
  process.stdout.write('\n');
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s — ${JSON.stringify(res)}`);
  printSummary();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
