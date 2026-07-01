import type { Artifact } from '../lib/types';
export type View = 'idle' | 'conversation' | 'split';
export type Item =
  | { key: string; kind: 'bubble'; role: 'kid' | 'avatar'; text: string }
  | { key: string; kind: 'card'; artifact: Artifact };
export type Reveal = { key: string; pending: boolean; shown: number };
