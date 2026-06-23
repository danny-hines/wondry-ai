// Content richness: a parent-configurable quality tier for generated interactive
// pages. Each tier (defined in config.json -> richness.tiers) bundles a model, a
// token budget, and a prompt "emphasis" that steers how rich/animated the page is.
// The globally-selected tier lives in config_kv (admin Settings); parents can
// override it per-page from the Create form, and the on-demand (kid) path can be
// capped per day so a child can't run up the most-expensive tier indefinitely.
import { getRichness, resolveProviderByName } from '../config.js';
import { db, getKV } from '../db.js';

// The globally-selected tier id (admin Settings), defaulting to config's default.
export function selectedTierId() {
  const r = getRichness();
  const id = getKV('content_richness', r.default || 'standard');
  return r.tiers && r.tiers[id] ? id : (r.default || 'standard');
}

// Daily cap on full-richness on-demand page generations. 0 / blank = unlimited.
export function dailyCap() {
  const v = parseInt(getKV('richness_daily_cap', '0'), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// On-demand (kid-initiated) generations of ANY type since local midnight — so the
// cap can't be bypassed by asking for diagrams/games instead of pages.
function onDemandToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE source='on_demand' AND created_at >= ?")
    .get(start.getTime()).n;
}

// Has the kid's daily on-demand cap been exceeded? Parent/override generations and
// the unlimited setting are never capped. Used to degrade pages AND to drop the
// expensive icon pass on explorable scenes. The current artifact row already exists
// when this runs, so it's counted — the (cap+1)th generation is the first capped.
export function overCap({ source = 'on_demand', override } = {}) {
  if (override || source !== 'on_demand') return false;
  const cap = dailyCap();
  return cap > 0 && onDemandToday() > cap;
}

// Resolve the effective richness for one page generation.
//  - `override` (parent Create form) wins and bypasses the daily cap.
//  - otherwise the global tier is used; on-demand kid requests degrade to the
//    `degradeTo` tier once the daily cap is exceeded.
export function resolveRichness({ source = 'on_demand', override } = {}) {
  const r = getRichness();
  const tiers = r.tiers || {};
  let id = override && tiers[override] ? override : selectedTierId();
  let degraded = false;

  if (overCap({ source, override })) {
    const to = r.degradeTo && tiers[r.degradeTo] ? r.degradeTo : 'simple';
    if (tiers[to] && to !== id) { id = to; degraded = true; }
  }

  const tier = tiers[id] || {};
  return {
    id,
    label: tier.label || id,
    maxTokens: tier.maxTokens || undefined,
    emphasis: tier.emphasis || '',
    provider: resolveProviderByName(tier.provider || 'claude'),
    degraded,
  };
}
