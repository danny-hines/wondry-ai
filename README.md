# Wondry

An educational AI agent for kids — a Raspberry Pi + touchscreen kiosk with a friendly
block-grid avatar that talks, answers questions, and **builds interactive learning pages
on the fly**. Parents review, author, and publish content per-child from a LAN console.

Runs end-to-end on a normal PC. Generation works with **no API key** (a keyless mock) until
you add one; voice works with the **browser's speech** until you install Piper. Everything
hardware-bound is behind interfaces so the same code runs on your PC and the Pi.

## Run it

```bash
git clone https://github.com/danny-hines/wondry-ai.git
cd wondry-ai
npm install
npm run seed       # placeholder kids + a few sample lessons
npm start
```

- **Kiosk:** http://localhost:8080/
- **Parent console:** http://localhost:8080/admin/  (password: `wondry`)

> Requires **Node 22.5+** (uses the built-in `node:sqlite` — no native build step). The scripts
> pass `--experimental-sqlite`; the one experimental warning is expected.
>
> **Restart `npm start` after any change** — static files refresh from disk instantly, but the
> Node server only picks up code changes on restart.

### Try this flow
1. On the kiosk, type **"teach me about volcanoes"** (or tap 🎤 to speak in Chrome).
2. The avatar replies and a **progress card** appears in the chat; it fills as it generates.
3. When ready it announces, a **toast** appears, and the **app-tray badge** (bottom-right) bumps.
4. Tap the card (or the tray) to open the lesson in the **split view**. Tap cards inside it —
   they speak via the avatar (tap-to-hear). Hit **⤢** for fullscreen, **✕** to close.
5. Tap the **initials** (bottom-right) to switch kid — the frame + avatar color change and a
   fresh conversation starts.
6. In the **parent console** → **Create Content**, describe a page (free-text, no kid picker).
   It's generated and held under **Pages**; **Preview** it, then tap a child's name chip to
   publish it to them — tap more than one to share the same page across kids. Tap again to
   un-publish. Each page also has a **Delete** (with confirmation). Under **Kids** you can
   **Remove** a child (confirms; deletes their activity but keeps their pages, now unassigned),
   and set a **per-kid voice** with a ▶ preview button.

## Tests

```bash
npm test       # integration suite (boots the real server, mock provider, temp DB)
npm run verify # fast integrity check: trailing-NUL corruption + JS syntax across all source
```

The suite exercises the full surface over HTTP + WebSocket: health, profiles, admin auth gate,
chat + artifact turns, generation→ready, the CSP sandbox + self-containment of generated pages,
live `artifact.created`/`completed` events, safety blocking, the tray + seen/engagement,
per-child publish/share/unpublish, delete-content, remove-child cascade, per-kid theme
(light/dark), and the editable system prompt. **16/16 passing.** Needs Node 22.5+ (built-in
test runner + `node:sqlite`).

## Voice (Piper TTS)

The avatar speaks with [Piper](https://github.com/OHF-Voice/piper1-gpl) when it's installed,
falling back to the browser's built-in speech otherwise. One-time setup:

```bash
npm run setup-piper      # installs the piper-tts engine (pip) + downloads a few voices
npm start                # the banner shows "TTS: Piper" once voices are present
```

`setup-piper` installs the cross-platform `piper-tts` engine via pip (Windows now, Pi/aarch64
later) and downloads voices into `voices/` using Piper's official downloader. If pip isn't
available it falls back to fetching from Hugging Face and prints how to finish — either
`pip install piper-tts` or point `PIPER_CMD` in `.env` at a Piper binary. `PIPER_VOICES_DIR`
relocates the voices folder.

**Per-kid voices:** parent console → **Kids** → each child has a **Voice** dropdown of installed
voices with a **▶ preview** button (blank = the default in `config.json` → `tts.defaultVoice`).
The kiosk fetches each spoken line from `/api/tts` for the current child's voice, plays the WAV
through Web Audio, and drives the avatar's mouth from a real `AnalyserNode` (amplitude lip-sync).
If Piper is unavailable it silently uses browser speech + the synthetic-envelope mouth — nothing
breaks. Same path on the Pi.

**🤖 Robot (on-device) voice:** the dropdown also offers a reserved Robot voice that skips Piper.
It's synthesized server-side with **`espeak-ng`** — instant (no model inference), reliable, and it
drives the avatar's lip-sync through the normal audio pipeline like any Piper voice. Its robotic tone
suits the dot-matrix avatar, so it's a good low-latency option. It needs the `espeak-ng` binary
(installed by `install.sh`; on an already-running device: `sudo apt-get install -y espeak-ng` then
`wondry restart`). If `espeak-ng` is absent (e.g. a dev laptop) `/api/tts` returns `204` and the kiosk
falls back to the browser's built-in `SpeechSynthesis` instead — which works on macOS/Windows but is
unreliable in Linux Chromium, hence the server-side espeak path on the Pi. (The saved voice id stays
`browser` for back-compat.) For a faster *Piper* voice instead, `setup-piper` also pulls
`en_US-lessac-low` (same speaker as the default, smaller/snappier model).

**Making it sound less robotic:** Piper's `-high` voices are far more natural than `-medium`
(`setup-piper` pulls high-tier voices by default). Pacing/prosody are tuned via `config.json` →
`tts.synthArgs`; the default adds `--sentence-silence 0.4`. To slow it down and calm it, try
`["--sentence-silence","0.4","--length-scale","1.1"]` (length-scale > 1 = slower). Edit, restart,
and A/B voices instantly with the ▶ buttons. Piper is a fast offline model so it's flatter than
cloud TTS by nature — high voices + a little length-scale get it most of the way there.

## Live generation (Claude)

Out of the box, generation uses a **keyless mock** that produces real interactive lessons, so the
app is demonstrable offline. To use Claude:

```bash
cp .env.example .env          # then set ANTHROPIC_API_KEY=sk-ant-...
npm start
```

The console header switches from `generation: mock` to `generation: LIVE`. Provider routing per
task is in `config.json` (`artifact` → Claude, `plan`/`intent` → Haiku). Swapping local-vs-cloud
is a config edit, never a code change — the `{base_url, model, api_key}` abstraction.

**Anthropic or OpenAI** (or any OpenAI-compatible endpoint): add `OPENAI_API_KEY` to `.env`, then point
any `routing`/`richness` entry at the `openai` / `openai-mini` providers in `config.json` (the abstraction
has both an `anthropic` and an `openai` adapter, incl. the tool-use loop). Kid-facing tasks default to
Claude for the safety model, so switching those is a deliberate choice.

### Content richness (parent console → Settings)

How rich the **interactive pages** are is a parent-set tier, not a code constant. Each tier
(defined in `config.json` → `richness.tiers`) bundles a **model**, a **token budget**, and a prompt
**emphasis** that steers the output — from lightweight cards up to immersive, animated, simulation-style
pages (e.g. the solar system as orbiting, tappable planets rather than a list):

| Tier | Model | Tokens | Feel |
|---|---|---|---|
| Simple | Haiku | 2k | Quick, cheap, focused — youngest kids |
| Standard *(default)* | Sonnet | 8k | Real illustrations + interactions — recommended |
| Rich | Opus | 16k | Immersive simulations/animation — best visuals, priciest |

Pick the default in **Settings**; parents can override it per page from the **Create** form. A
**daily cap** limits how many full-richness pages a *child* can request before on-demand pages fall
back to the simplest tier for the rest of the day (parent-authored pages are never capped). All tiers
stay pinned to Claude, preserving the safety model. *(TODO: an estimated-cost dashboard — daily/weekly/
monthly/lifetime — in the console.)*

### Explorable diagrams (the `explorable` content type)

The richest *reusable* visual isn't freeform HTML — it's a vetted **widget**. The `scene` block in the
declarative kit renders an **explorable diagram**: a spatial set of focusable things a child taps to
zoom in on and hear about, with the avatar narrating. The model emits only **data** (a layout + nodes
with an emoji, a spoken blurb, and tap-to-hear facts); a trusted React renderer does all the motion.
Three layouts cover a huge range:

- **orbit** — nodes revolve around a center: *the solar system* (sun + planets you tap to focus on),
  a planet and its moons, an atom.
- **map** — nodes pinned at x/y: *the human body*, parts of a plant, a place or diagram. A
  curated silhouette **backdrop** (`body` / `plant` / `globe`) can be drawn behind them so the
  scene reads as a real figure; without one, positions auto-fit to fill the stage.
- **cycle** — a loop/sequence: *the water cycle*, a life cycle, the seasons, a food chain.

A child saying **“show me a diagram of the solar system”** (or **“explore the human body”**) routes here
automatically; parents can also author one under **Create → Explorable diagram**. Because it's pure data
behind a trusted renderer, it's safe, consistent, and animated for free — the same widget serves every
subject. It works offline too (keyless mock scenes for space, the body, and the water cycle).

**Node icons (beyond emoji).** Emoji often misrepresent things (there's no “rib” emoji, so a skeleton
ends up with lungs). So a node can carry an **`icon`** — a small **vector drawing the model composes
from whitelisted shape primitives** (`path`/`circle`/`rect`/`line`/…), which the renderer maps to real
SVG. It's still pure data, never raw markup: geometry is range-clamped, path/points are charset-checked,
colors are whitelisted, and anything else (script, `href`, `style`, `url()`, event handlers) is stripped
server-side — so an icon can only ever *draw*, never execute or fetch (see `test/declarative.test.js`).
Live result: a skeleton renders ribs as actual rib lines and the spine as stacked vertebrae instead of 🫁/🐍.

## What's real vs. mocked

| Subsystem | This MVP (PC) | On the Pi |
|---|---|---|
| Avatar (block-grid, amplitude lip-sync) | ✅ real | same |
| Conversation, intent routing, safety checks | ✅ real | same |
| Artifact generation + CSP sandbox + persistence | ✅ real | same |
| App tray, per-child publishing, engagement | ✅ real | same |
| Parent console (log, authoring, profiles, prompt) | ✅ real | same |
| **TTS** (text→speech) | ✅ Piper (or browser fallback) | Piper |
| **STT** (speech→text) | browser Web Speech | ✅ whisper.cpp adapter (browser fallback) |
| **Presence** (greet on approach) | manual `POST /api/presence` | ✅ Hailo sidecar → `/api/presence` → WS greet |
| **LLM** | mock (or Claude with a key) | small model on Pi CPU + Claude |

STT and presence now have real adapters (`server/services/stt.js`, `server/services/presence.js`) that
activate from config/env on the Pi and fall back cleanly on a PC — see **Deploy on the Raspberry Pi** below.

## Architecture (where things are)

```
server/
  index.js            Express + WebSocket; static hosting; health
  config.js           .env loader + config.json + provider resolution (mock fallback)
  db.js               node:sqlite schema + per-child audience + helpers
  events.js           in-process event bus -> broadcast over WS
  routes/
    conversation.js   POST /api/turn : safety -> intent -> chat or generate
    artifacts.js      tray (by audience), engagement, CSP-sandboxed /api/artifact/:id
    profiles.js       public profile list
    tts.js            POST /api/tts (per-kid Piper voice + preview), GET /api/voices
    admin.js          password-gated: log, pages, per-child publish, authoring, profiles, prompt
  services/
    providers.js      LLM abstraction (anthropic + mock)
    mockArtifact.js   keyless interactive-lesson generator
    systemPrompt.js   the artifact-generation system prompt (editable in console)
    generator.js      generation pipeline (event-driven; audience-aware)
    safety.js         input keyword check + output network-egress scan
    tts.js            Piper adapter (shell out -> WAV) + voice resolution + synthArgs
    hardware.js       STT/presence interfaces with mock backends (Pi adapters go here)
client/               React + TypeScript SPA (Vite) — see "Frontend" section below
  src/kiosk/          Avatar engine, useSpeech, the 4-state machine
  src/admin/          parent console (router + login + five route pages)
tools/
  setup-piper.mjs     npm run setup-piper
  verify.sh           npm run verify
```

### Safety model (defense in depth)
1. **CSP sandbox** is the hard boundary — artifacts are served same-origin under a strict CSP and
   rendered in a `sandbox="allow-scripts"` iframe, so a generated page physically can't reach the net.
2. Kid-facing generation is **pinned to Claude** in `config.json` routing.
3. **System prompt** enforces age-tailoring + child-safety framing (editable in the console).
4. **Input/output checks** — keyword pre-filter + an output scan rejecting remote-resource loads.
5. **Everything is logged and reviewable**; parent-authored content is held until you publish it.

## Deploy on the Raspberry Pi

One command on a fresh **Raspberry Pi OS Lite (Bookworm, 64-bit)** — SSH in and run:

```bash
curl -fsSL https://raw.githubusercontent.com/danny-hines/wondry-ai/main/install.sh | bash
```

`install.sh` installs Node 22, clones + builds the app, walks you through the `.env` (API key, parent
password, port), runs the server as a **systemd service**, sets up the **full-screen kiosk on boot**
(a minimal X11 stack — Xorg + Openbox + Chromium, autologin → `startx -- -nocursor`, no desktop), and
prompts to install **Piper** (TTS) and **whisper.cpp** (STT). It's
**idempotent** — re-run it any time to update (it does `git pull` + rebuild). For an unattended install,
pass secrets as env vars: `curl -fsSL …/install.sh | ANTHROPIC_API_KEY=sk-… ADMIN_PASSWORD=… bash`.
(Prefer to read before you run? `git clone` the repo and run `./install.sh` from the checkout.)

Each hardware adapter falls back gracefully if its dependency is missing, so a half-configured Pi still
boots. What the installer wires up (and how to do it by hand):

- **Voice (TTS):** Piper — `npm run setup-piper` (see the Voice section above).
- **Speech-in (STT):** [whisper.cpp](https://github.com/ggerganov/whisper.cpp); the server reads
  `WHISPER_HTTP_URL` (a running whisper server) or `WHISPER_CMD` + `WHISPER_MODEL` (the CLI) from `.env`.
  Point the kiosk at the on-device path by opening it as `…/?stt=server` (the installer does this when you
  add whisper). No whisper → browser Web Speech. The server transcodes the browser's audio to WAV with
  **ffmpeg** (installed alongside whisper) before whisper reads it. Any USB mic works as the capture
  device — including the built-in mic on a **USB camera+mic combo** (it's just the default ALSA/PipeWire
  source); no per-device config needed.
- **Presence (greet on approach):** run your Hailo person-detection sidecar and have it POST
  `{"state":"present"}` / `{"state":"absent"}` to `http://localhost:8080/api/presence` — the idle avatar
  greets (throttled). No camera code runs in this app. Test it on any machine with
  `curl -XPOST localhost:8080/api/presence -H 'content-type: application/json' -d '{"state":"present"}'`.
- **Familiar faces (auto child-switch):** off by default — turn it on in the console (**Familiar faces**
  tab). A vision sidecar (fork Hailo's `hailo-apps` face-recognition pipeline, USB-camera input) detects
  faces, computes 512-d ArcFace embeddings, and POSTs each frame's faces to `/api/faces/observe`:
  `{"faces":[{"embedding":[…512 floats…],"thumb":"data:image/jpeg;base64,…","trackId":"t7","quality":0.9}]}`.
  Send `thumb` only occasionally (≈ once/few-seconds per track) — a thumb means "bank this for enrollment";
  embeddings without a thumb are identify-only. The app clusters the banked samples; in the console the
  parent maps each cluster to a child. Then a recognized face makes the kiosk switch to that child's profile
  **from the idle screen only** (sticky session — a second kid entering frame won't hijack it). All face
  data (embeddings + tiny thumbnails) stays on the device; nothing is uploaded. Match thresholds are in
  `config.json` → `faces` (tune on hardware). The whole server pipeline is unit-tested with synthetic
  embeddings (`test/faces.test.js`); the sidecar is the only part that needs the Pi + camera.
  - **Try it without the Pi (two dev testers):** with the app running, `node tools/faces-sim.mjs seed`
    invents a few synthetic people so you can watch the **Familiar faces** tab fill up, assign clusters to
    kids, then `node tools/faces-sim.mjs walk Ada` to make the kiosk switch. To use your *real* face on a
    dev machine, open **`/faces-cam.html`** (e.g. `http://localhost:5173/faces-cam.html`): it runs face
    detection + embeddings in the browser (face-api.js) off your webcam and POSTs to the same endpoint —
    a non-Hailo stand-in for the sidecar (its 128-d embeddings differ from ArcFace, so tune `faces`
    thresholds for dev).

The systemd unit and kiosk launcher (`tools/kiosk.sh`) are written by the installer; tweak them there.

### Updating

The installer drops a `wondry` management command. To update the device to the latest code:

```bash
wondry update     # git pull (keeps local config edits) → rebuild → restart the service
```

`update` no-ops cleanly if you're already current. Other verbs: `wondry logs` (follow the server log),
`wondry status`, `wondry restart`, `wondry version`, `wondry url`. (Re-running `install.sh` also updates,
but `wondry update` is the lightweight path — it skips the apt/Node/prompt steps.) Local edits to tracked
files like `config.json` are auto-stashed across the pull, so your provider/routing tweaks survive updates.

**Update from the kiosk (no SSH):** press and hold the avatar for 5 seconds to open a parent menu,
enter the 4-digit PIN (default `0000`, change it in the parent console → **Settings → Kiosk access PIN**),
and pick **Update** or **Reload**. Update does the same `git pull` + rebuild as `wondry update`, then the
server self-exits and systemd (`Restart=always`) relaunches it on the new code — the kiosk watches
`/api/health` and reloads itself once it's back (or shows "Already up to date"). The menu only offers
Update when running as the installed service (detected via systemd's `INVOCATION_ID`), so a local
`npm start` shows Reload only. The PIN is low-stakes by design — it just keeps kids out of the menu.

## Known gaps / next steps (deferred by design)
- Hardware adapters above need validation on real Pi hardware (built + unit-tested, but not run on a Pi).
- Proactive nightly generation + interest model (reuses the authoring→review→publish pipeline).
- Content sequencing / reading plans (schema keeps stable artifact IDs so it bolts on later).
- Vision-suggested user switching (currently manual tap-to-switch).
- Auth is a single shared parent password (fine for a home LAN; not multi-account).

## Performance / responsiveness

Speech is tuned to start fast and avoid dead air:

- **Warm Piper server.** On startup the server launches `python -m piper.http_server` once and keeps
  the voice model loaded, so each line skips the per-call model reload (the big win, especially on
  the Pi). Override with `PIPER_HTTP_URL` to point at an externally-run Piper server, or
  `PIPER_HTTP_PORT` to change the managed port. Falls back to spawn-per-call, then browser speech.
- **Gapless sentence pipeline.** The kiosk splits a reply into sentences, keeps a few syntheses in
  flight ahead of playback, and as each clip decodes schedules it on the Web Audio timeline to start
  the instant the previous one ends — so first audio is fast (sentence 1 alone) *and* there's no
  decode/scheduling gap between sentences. Each Piper clip keeps its own trailing silence, so the
  pacing stays natural.
- **Instant "thinking" filler.** The moment a child submits, the avatar says a short cached line
  ("Hmm, let me think!") to mask the Claude round-trip; the real reply supersedes it when it lands.
- **Phrase cache.** Repeated lines (fillers, announcements) are cached in memory and replay instantly.

**Pi synthesis-speed levers** (in `config.json` → `tts`, restart after editing) — if raw Piper synthesis
is the bottleneck on the Pi rather than the gaps:
- `defaultVoice` — a `-medium` voice (e.g. `en_US-amy-medium`) synthesizes ~2–3× faster than `-high`,
  and `en_US-lessac-low` is the fastest (all installed by `setup-piper`; a per-kid voice overrides it).
- `synthesis.length_scale` — below `1.0` speaks faster (shorter clips), above is calmer.
- `serverEnv` — extra env for the warm Piper server, e.g. `{"OMP_NUM_THREADS":"4"}` to push all Pi
  cores (experimental — onnxruntime already multi-threads, so measure it).

If speech still feels slow to *start*, the remaining gap is usually Claude generating the reply text
(`chat` routing) — that's independent of TTS.

## Frontend (React + TypeScript) — current architecture

The UI was migrated from vanilla HTML/JS to **React 18 + TypeScript + Vite**, with the parent
console as a `react-router` SPA (reload keeps you on `/admin/pages` etc.). The old `public/`
folder is **legacy and no longer served** — you can delete it.

```
client/
  index.html, vite.config.ts, tsconfig.json
  src/
    main.tsx            BrowserRouter: "/" = Kiosk, "/admin/*" = console (Log/Pages/Create/Kids/Settings)
    index.css
    lib/  types.ts · api.ts (typed client + AdminApi) · markdown.ts (render + strip-for-TTS)
    kiosk/  Kiosk.tsx (state machine) · Avatar.tsx + avatarEngine.ts (canvas) · useSpeech.ts · kiosk.css
    admin/  Admin.tsx (login + nav + Outlet) · pages.tsx (5 routes) · AdminContext.ts · admin.css
```

### Dev (hot reload)
```bash
npm install            # server deps
npm run build          # installs client deps + builds (first time / for prod)
npm run dev            # Express (:8080) + Vite (:5173, HMR) together
```
Open the app at the **Vite URL (http://localhost:5173)** during development — it proxies `/api`
and `/ws` to Express, so edits hot-reload while talking to the real backend.

### Production
```bash
npm run build          # -> client/dist
npm start              # Express serves client/dist (with SPA history fallback) on :8080
```
`npm start` serves the built app at `/` (kiosk) and `/admin` (console). If no build exists, the
root page tells you to build or run dev. The Node backend is unchanged; `npm test` still covers it.

## License

[MIT](LICENSE) © Danny Hines
