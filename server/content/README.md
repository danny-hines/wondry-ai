# Content types

Wondry's content is organized as **content types** — drop-in modules that the
generator, conversation router, and parent console all dispatch through. Adding a
new kind of content (math lessons, a language game, a new puzzle) means adding a
type, not editing core code.

## The three render strata — pick one

| `renderer`     | What it is                                                                                                                      | Use for                                                                                | Trust                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `declarative`  | Model emits JSON composed of the **widget kit** (`server/content/declarative.js`); the client's `DeclarativeRenderer` draws it. | Most educational content: study sets, illustrated explainers, quizzes, math, language. | Pure data — safest; OK for less-trusted contributions. |
| `native`       | A hand-built React component fed by generated JSON config.                                                                      | Real interaction logic / device features: games, anything using the mic.               | Code in the kiosk — first-party / reviewed only.       |
| `sandbox-html` | Model writes arbitrary HTML, served behind the CSP sandbox iframe.                                                              | One-off freeform creativity nothing else fits.                                         | Sealed by CSP, but unpredictable — the escape hatch.   |

**Prefer `declarative`.** Reach for `native` only when you need logic the widget
kit can't express; extend the kit (a new widget) before adding a native type.

## Add a type (server)

Create `server/content/types/<id>.js` exporting a default object, then register it
in `server/content/index.js`. Shape (all hooks optional except `generate`):

```js
export default {
  id: 'mathdrill',
  label: 'Math drill',
  emoji: '➗',
  renderer: 'declarative',
  ext: 'json',
  uses: { mic: false, media: false, network: false }, // capability surface (shown to parents)
  defaultColor: '#f59e0b',
  triggersHelp: 'e.g. "practice adding"',
  createForm: [{ key: 'skill', label: 'Skill', type: 'text', placeholder: 'addition to 10' }],

  matchIntent: (text) => (/practice (math|adding)/i.test(text) ? { skill: '...' } : null),
  intentReply: (params) => `Let's practice ${params.skill}!`,
  prepare: ({ params, profile }) => ({ ...params }), // resolve/augment once (optional)
  plan: ({ params, profile }) => ({ title, emoji, color, subject, plan }), // placeholder card (optional)
  async generate({ params, profile }) {
    // REQUIRED
    // declarative: build a doc, normalizeDoc + checkDeclarativeContent + (optional) resolveDocImages
    return { data, meta: { title, emoji, color, subject, plan } };
  },
  recordEvent({ artifactId, profileId, event }) {
    /* recordProgressEvent(...) */
  }, // optional
  summary(profileId) {
    /* progressEvents(profileId, id) -> rollup */
  }, // optional
};
```

- `generate` returns `{ data, meta }`. `data` is a string for `sandbox-html` (HTML)
  or an object for `declarative`/`native` (written to `artifacts/<id>.json`).
- Use `runStructured(task, { system, prompt, mock })` for JSON generation — always
  pass a keyless `mock` so the type works offline. New types route to
  `routing.default` (Claude) automatically; add a `routing.<id>` entry only to override.
- **Safety:** scan any model text you store (`checkDeclarativeContent` for the kit).
  Media: emit `{type:'image', query}` blocks and call `resolveDocImages` — never let
  the model emit URLs.

## Add the renderer (client)

For `native`/`declarative` types, map the id to a component in
`client/src/content/registry.tsx`. Declarative types reuse `DeclarativeRenderer`;
native types ship their own. Renderers receive `ContentRendererProps`
(`artifactId`, `profile`, `speak`, `speakingId`, `setMood`) and fetch their content
with `getContent(artifactId)`. `sandbox-html` types need no renderer (the kiosk
shows them in the iframe).

## Vetting

Types are enabled/disabled globally (Settings) and per-child (Kids). Because server
modules run with full privileges and renderers run in the kiosk, **trust is by
review, not sandboxing** — declarative (data-only) types are the safe unit for
outside contributions; native/`sandbox-html` types should stay first-party.
