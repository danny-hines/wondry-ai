import type { Profile, TurnResponse, TrayResponse, Artifact, AdminConfig, LogMessage, SafetyEntry, ReadingAttempt, ReadingReportRow, ContentTypeManifest, UsageReport, ScheduleItem, EvalsResponse, EvalSuggestion, PromptVersion } from './types';

const j = <T>(r: Response): Promise<T> => r.json() as Promise<T>;

// ----- public (kiosk) -----
export const getProfiles = () => fetch('/api/profiles').then(j<{ profiles: Profile[] }>).then((d) => d.profiles);
export const getTray = (profileId: string) => fetch(`/api/artifacts?profileId=${profileId}`).then(j<TrayResponse>);
export const postTurn = (profileId: string, text: string) =>
  fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, text }) }).then(j<TurnResponse>);
export const markEngagement = (id: string, kind: 'seen' | 'opened' | 'finished', profileId: string) =>
  fetch(`/api/artifacts/${id}/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId }) });
export const ttsArrayBuffer = async (text: string, profileId?: string, voice?: string): Promise<ArrayBuffer | null> => {
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, profileId, voice }) });
    // 204 = on-device "browser" voice: no audio body; returning null routes the caller
    // through useSpeech's speakFallback (window.speechSynthesis), same as a Piper miss.
    if (r.status === 204 || !r.ok) return null;
    return await r.arrayBuffer();
  } catch { return null; }
};
export const getVoices = () => fetch('/api/voices').then(j<{ voices: string[]; available: boolean; browserVoice?: string }>).catch(() => ({ voices: [] as string[], available: false, browserVoice: undefined }));

// ----- schedules (device-global timers + wall-clock reminders/alarms) -----
// Kiosk: just the countdown timers (for the chips).
export const getTimers = () =>
  fetch('/api/timers').then(j<{ timers: ScheduleItem[] }>).catch(() => ({ timers: [] as ScheduleItem[] }));
// Console: every active schedule (timers + reminders).
export const getSchedules = () =>
  fetch('/api/schedules').then(j<{ schedules: ScheduleItem[] }>).catch(() => ({ schedules: [] as ScheduleItem[] }));
export const createTimer = (durationMs: number, label?: string | null, createdBy: 'voice' | 'parent' = 'voice') =>
  fetch('/api/timers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ durationMs, label, createdBy }) }).then(j<{ schedule: ScheduleItem }>);
// atLocal is a datetime-local value ("YYYY-MM-DDTHH:mm"); the server reads it in the configured timezone.
export const createReminder = (atLocal: string, message?: string | null, label?: string | null) =>
  fetch('/api/reminders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ atLocal, message, label, createdBy: 'parent' }) }).then(j<{ schedule: ScheduleItem; error?: string }>);
export const cancelSchedule = (id: string) =>
  fetch(`/api/schedules/${id}/cancel`, { method: 'POST' }).then(j<{ schedule: ScheduleItem }>).catch(() => null);

// ----- kiosk parent controls (PIN-gated update/reload from the touchscreen) -----
export const getHealth = () => fetch('/api/health').then(j<{ ok: boolean; boot?: number; managed?: boolean; liveGeneration?: boolean; tts?: boolean }>);
export const kioskVerifyPin = (pin: string) =>
  fetch('/api/kiosk/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) }).then(j<{ ok: boolean; managed: boolean }>);
export const kioskUpdate = (pin: string) =>
  fetch('/api/kiosk/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) })
    .then(j<{ status: 'up-to-date' | 'updating' | 'unmanaged' | 'bad-pin' | 'error'; rev?: string; error?: string }>);

// ----- structured content (kiosk: reading, flashcards, games, …) -----
export const getContent = <T = unknown>(id: string) => fetch(`/api/content/${id}`).then(j<T>);
export const getContentTypes = () => fetch('/api/content-types').then(j<{ types: ContentTypeManifest[] }>).catch(() => ({ types: [] as ContentTypeManifest[] }));
// Record a scored interaction; the server's content type interprets the event.
export const postContentEvent = (id: string, profileId: string, event: ReadingAttempt | Record<string, unknown>) =>
  fetch(`/api/content/${id}/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, event }) }).catch(() => {});
// Server STT (whisper.cpp on the Pi). Returns empty text when unconfigured so the
// caller falls back to the browser's Web Speech recognition.
export const serverTranscribe = async (audio?: Blob): Promise<{ text: string; available: boolean }> => {
  try {
    const ct = audio?.type || 'application/octet-stream';
    const r = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': ct }, body: audio });
    if (!r.ok) return { text: '', available: false };
    return await r.json();
  } catch { return { text: '', available: false }; }
};

// ----- admin (password header) -----
export class AdminApi {
  constructor(private pw: string) {}
  private h() { return { 'content-type': 'application/json', 'x-admin-password': this.pw }; }
  private req(path: string, opts: RequestInit = {}) { return fetch('/api/admin' + path, { ...opts, headers: { ...this.h(), ...(opts.headers || {}) } }); }
  async ok(): Promise<boolean> { return (await this.req('/config')).ok; }
  config = () => this.req('/config').then(j<AdminConfig>);
  saveConfig = (body: { systemPrompt?: string; chatSystemPrompt?: string; readingSystemPrompt?: string; richness?: string; dailyCap?: number; wake?: { enabled?: boolean; phrase?: string }; kioskPin?: string; timezone?: string; promptAuthor?: string }) => this.req('/config', { method: 'POST', body: JSON.stringify(body) });
  promptHistory = (key: string) => this.req(`/prompt-history?key=${key}`).then(j<{ versions: PromptVersion[] }>);
  log = () => this.req('/log').then(j<{ messages: LogMessage[]; safety: SafetyEntry[] }>);
  artifacts = () => this.req('/artifacts').then(j<{ artifacts: Artifact[]; kids: Profile[] }>);
  setAudience = (id: string, profileId: string, on: boolean) => this.req(`/artifacts/${id}/audience`, { method: 'POST', body: JSON.stringify({ profileId, on }) });
  deleteArtifact = (id: string) => this.req(`/artifacts/${id}/delete`, { method: 'POST' });
  author = (topic: string) => this.req('/author', { method: 'POST', body: JSON.stringify({ topic }) }).then(j<{ ok: boolean; artifactId: string }>);
  authorReading = (body: { interest?: string; level?: number; profileId?: string }) =>
    this.req('/author-reading', { method: 'POST', body: JSON.stringify(body) }).then(j<{ ok: boolean; artifactId: string }>);
  createContent = (body: { typeId: string; params?: Record<string, unknown>; profileId?: string; richness?: string }) =>
    this.req('/content', { method: 'POST', body: JSON.stringify(body) }).then(j<{ ok: boolean; artifactId: string }>);
  readingReport = () => this.req('/reading-report').then(j<{ report: ReadingReportRow[] }>);
  usage = () => this.req('/usage').then(j<UsageReport>);
  evals = (kind: string) => this.req(`/evals?kind=${kind}`).then(j<EvalsResponse>);
  runEvals = (body: { mode?: 'benchmark' | 'live'; kind?: string; reeval?: boolean }) =>
    this.req('/evals/run', { method: 'POST', body: JSON.stringify(body) }).then(j<{ started?: boolean; error?: string }>);
  suggestPrompt = (kind: string) =>
    this.req('/evals/suggest', { method: 'POST', body: JSON.stringify({ kind }) }).then(j<EvalSuggestion>);
  profiles = () => this.req('/profiles').then(j<{ profiles: Profile[] }>);
  saveProfile = (p: Partial<Profile> & { disabledTypes?: string[] }) => this.req('/profiles', { method: 'POST', body: JSON.stringify(p) });
  contentTypes = () => this.req('/content-types').then(j<{ types: ContentTypeManifest[] }>);
  setContentTypeEnabled = (id: string, enabled: boolean) => this.req(`/content-types/${id}`, { method: 'POST', body: JSON.stringify({ enabled }) });
  deleteProfile = (id: string) => this.req(`/profiles/${id}/delete`, { method: 'POST' });
}
export const login = (password: string) =>
  fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
