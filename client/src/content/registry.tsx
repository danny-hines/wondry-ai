// Client content registry: maps a content type id to the React component that
// renders it. Anything NOT here (e.g. 'page') has no native renderer and is shown
// in the sandboxed iframe instead. Adding a native/declarative type = register it.
import type { ComponentType } from 'react';
import type { ContentRendererProps } from './types';
import Reader from '../kiosk/Reader';
import DeclarativeRenderer from './DeclarativeRenderer';
import MemoryGame from './MemoryGame';

export const RENDERERS: Record<string, ComponentType<ContentRendererProps>> = {
  reading: Reader,
  flashcards: DeclarativeRenderer,
  explorable: DeclarativeRenderer,
  memory: MemoryGame,
};

export function rendererFor(type?: string | null): ComponentType<ContentRendererProps> | undefined {
  return type ? RENDERERS[type] : undefined;
}
