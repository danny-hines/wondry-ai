// Loads .env (if present), then config.json, and resolves a provider per task.
// If a key-backed provider has no key set, we transparently fall back to mock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// Minimal .env loader (no dependency, no Node-version flag needed).
// Parses KEY=VALUE lines; ignores blanks/comments; strips surrounding quotes.
// Does not overwrite vars already present in the real environment.
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

let fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

export function getConfig() {
  return fileConfig;
}
export function getRichness() {
  return fileConfig.richness || { default: 'standard', tiers: {} };
}

// Resolve a provider object by its name in config.providers, injecting the API key
// (or transparently falling back to mock when a key-backed provider has no key).
export function resolveProviderByName(name) {
  const cfg = fileConfig;
  let provider = cfg.providers[name];
  if (!provider) provider = cfg.providers[cfg.fallbackProvider];
  // Any key-backed provider (anthropic, openai, …): inject the key, or fall back to
  // mock if it isn't set so the app still runs.
  if (provider.api_key_env) {
    const key = process.env[provider.api_key_env];
    if (!key) {
      return { ...cfg.providers[cfg.fallbackProvider], _fellBackFrom: name, _reason: 'no-api-key' };
    }
    return { ...provider, _apiKey: key };
  }
  return provider;
}

// Resolve the provider object to actually use for a given task.
export function resolveProvider(task) {
  const cfg = fileConfig;
  // Unknown tasks fall back to routing.default (so new content types work without
  // a per-type routing entry), then to the global fallback provider.
  const name = cfg.routing[task] || cfg.routing.default || cfg.fallbackProvider;
  return resolveProviderByName(name);
}

export function liveGenerationEnabled() {
  return Object.values(fileConfig.providers).some(
    (p) => p.api_key_env && process.env[p.api_key_env],
  );
}

export const PORT = process.env.PORT || fileConfig.port || 8080;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wondry';
