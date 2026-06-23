import type { Profile, TurnResponse, TrayResponse, Artifact, AdminConfig, LogMessage, SafetyEntry, ReadingAttempt, ReadingReportRow, ContentTypeManifest, UsageReport } from './types';

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
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch { return null; }
};
export const getVoices = () => fetch('/api/voices').then(j<{ voices: string[]; available: boolean }>).catch(() => ({ voices: [], available: false }));

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
  saveConfig = (body: { systemPrompt?: string; chatSystemPrompt?: string; readingSystemPrompt?: string; richness?: string; dailyCap?: number }) => this.req('/config', { method: 'POST', body: JSON.stringify(body) });
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
  profiles = () => this.req('/profiles').then(j<{ profiles: Profile[] }>);
  saveProfile = (p: Partial<Profile> & { disabledTypes?: string[] }) => this.req('/profiles', { method: 'POST', body: JSON.stringify(p) });
  contentTypes = () => this.req('/content-types').then(j<{ types: ContentTypeManifest[] }>);
  setContentTypeEnabled = (id: string, enabled: boolean) => this.req(`/content-types/${id}`, { method: 'POST', body: JSON.stringify({ enabled }) });
  deleteProfile = (id: string) => this.req(`/profiles/${id}/delete`, { method: 'POST' });
}
export const login = (password: string) =>
  fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
