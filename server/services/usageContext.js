// Async-local context so LLM cost can be attributed to the artifact being
// generated WITHOUT threading an id through every generate/provider signature.
// generator.js runs each generation inside `usageContext.run({artifactId}, …)`;
// the provider layer reads `currentArtifactId()` when it records usage. The store
// propagates across awaits, so deeply-nested API calls still see the right id.
// Calls made outside any generation (intent, chat) just see null.
import { AsyncLocalStorage } from 'node:async_hooks';

export const usageContext = new AsyncLocalStorage();

export function currentArtifactId() {
  const s = usageContext.getStore();
  return (s && s.artifactId) || null;
}
