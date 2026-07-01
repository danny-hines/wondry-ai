// Media source registry — a small sibling of the content-type registry. Each
// source is an adapter that knows how to fetch images from ONE trusted provider.
// The model never talks to these; it only describes the image it wants (a query),
// and a source resolves that to validated bytes + attribution.
//
// A source adapter:
//   {
//     id, label,
//     capabilities: 'one-line blurb injected into generation prompts so the model
//                    requests source-appropriate images',
//     async resolve(query, { maxBytes }) -> { bytes, mime, ext, credit, license, sourceUrl } | null
//   }
const sources = new Map();
export function registerSource(s) {
  if (s && s.id) sources.set(s.id, s);
}
export function getSource(id) {
  return sources.get(id);
}
export function allSources() {
  return [...sources.values()];
}
