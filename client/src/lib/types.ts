export interface Profile {
  id: string; name: string; initials: string; color: string;
  age: number | null; reading_level: string | null;
  voice?: string | null; persona?: string | null; theme?: 'light' | 'dark';
  interests?: string | null; disabled_types?: string | null;
}
export type ArtifactStatus = 'generating' | 'ready' | 'failed';
export type ArtifactType = 'page' | 'reading';
export interface Artifact {
  id: string; title: string; prompt?: string; profile_id: string | null;
  source: string; status: ArtifactStatus; type?: ArtifactType; subject?: string; reading_level?: string | null;
  plan?: string; emoji?: string | null; color?: string | null; error?: string | null;
  published?: number; created_at: number; ready_at?: number | null;
  audience?: string[]; seen?: number; finished?: number; profile_name?: string | null;
  cost?: number;
}

// ----- Reading practice -----
export interface ReadingPage { illustration: string; lines: string[]; }
export interface ReadingLesson { id?: string; title: string; emoji: string; interest: string; level: number; pages: ReadingPage[]; }
export interface WordMark { word: string; ok: boolean; }
export interface ReadingAttempt {
  pageIndex: number; lineIndex: number; expected: string; transcript: string; score: number; perWord: WordMark[];
}
// ----- declarative widget kit -----
export interface SceneShape {
  type: 'path' | 'circle' | 'ellipse' | 'rect' | 'line' | 'polygon' | 'polyline';
  d?: string; points?: string;
  cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  x?: number; y?: number; width?: number; height?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  fill?: string; stroke?: string; strokeWidth?: number; strokeLinecap?: string; strokeLinejoin?: string; opacity?: number;
}
export interface SceneIconData { viewBox: string; shapes: SceneShape[]; }
export interface SceneNode {
  label: string; emoji: string; blurb?: string; facts?: string[];
  x?: number; y?: number; size?: number; color?: string; icon?: SceneIconData;
}
export type DeclBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'flashcards'; cards: { front: string; back: string; hint?: string }[] }
  | { type: 'quiz'; question: string; options: string[]; answer: number }
  | { type: 'scene'; layout: 'orbit' | 'map' | 'cycle'; nodes: SceneNode[]; center?: SceneNode; backdrop?: 'body' | 'plant' | 'globe'; caption?: string }
  | { type: 'image'; query: string; alt: string; caption?: string; mediaId?: string; credit?: string };
export interface DeclarativeDoc { id?: string; type?: string; title: string; emoji: string; subject?: string; blocks: DeclBlock[] }

// ----- memory game (native) -----
export interface MemoryGameContent { id?: string; type?: string; title: string; emoji: string; theme: string; pairs: { emoji: string; label: string }[] }

// A field in a content type's admin "create" form.
export interface CreateFormField { key: string; label: string; type: string; placeholder?: string }
// Client-facing manifest for a registered content type (from /api/content-types).
export interface ContentTypeManifest {
  id: string; label: string; emoji: string;
  renderer: 'native' | 'declarative' | 'sandbox-html';
  uses: { mic?: boolean; media?: boolean; network?: boolean };
  createForm: CreateFormField[]; triggersHelp: string | null;
  authorable: boolean; enabled: boolean;
}

export interface ReadingReportRow {
  id: string; name: string; initials: string; color: string; reading_level: string | null;
  count: number; avg: number | null; recentAvg: number | null; recentCount: number;
  missWords: { word: string; n: number }[];
}
// A device-global scheduled item: a countdown timer or a wall-clock reminder/alarm.
export interface ScheduleItem {
  id: string; kind: 'timer' | 'reminder'; label: string | null; message: string | null;
  duration_ms: number | null; fire_at: number; recurrence: string | null;
  status: 'pending' | 'fired' | 'cancelled'; created_by: 'voice' | 'parent';
  pretty: string | null;   // human duration for timers, e.g. "5 minutes"
  when: string;            // friendly fire time for reminders, e.g. "Today 7:00 PM"
}
export interface TurnResponse {
  kind: 'chat' | 'artifact' | 'timer' | 'reminder'; reply: string;
  artifactId?: string; artifact?: Artifact; blocked?: boolean; timer?: ScheduleItem; reminder?: ScheduleItem;
}
export interface TrayResponse { artifacts: Artifact[]; unseen: number; }
export interface UsageBucket { cost: number; inTok: number; outTok: number; n: number; }
export interface UsageReport {
  today: UsageBucket; week: UsageBucket; month: UsageBucket; lifetime: UsageBucket;
  byModelMonth: { model: string | null; cost: number; n: number }[];
}
export interface RichnessTier { id: string; label: string; description: string; provider: string; maxTokens: number; }
export interface RichnessConfig { selected: string; default: string; dailyCap: number; tiers: RichnessTier[]; }
export interface WakeConfig { enabled: boolean; phrase: string; phrases: { key: string; label: string }[]; }
export interface AdminConfig {
  systemPrompt: string; defaultSystemPrompt: string;
  chatSystemPrompt: string; defaultChatSystemPrompt: string;
  readingSystemPrompt: string; defaultReadingSystemPrompt: string;
  routing: Record<string, string>; providers: string[]; liveGeneration: boolean;
  richness: RichnessConfig; wake: WakeConfig; kioskPin: string;
  timezone: string; detectedTimezone: string; timezones: string[]; serverTime: number;
}
export interface LogMessage {
  id: string; role: string; kind: string; text: string; created_at: number;
  profile_id: string; profile_name: string; initials: string; color: string;
  artifact_title?: string | null; safety_flag: number;
}
export interface SafetyEntry { id: string; verdict: string; reason: string | null; sample: string | null; created_at: number; }
export interface WSMessage { type: string; artifact?: Artifact; schedule?: ScheduleItem; at: number; announce?: boolean; state?: 'present' | 'absent'; changed?: boolean; }
