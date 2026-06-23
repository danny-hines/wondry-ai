// Registers all built-in content types. Import this module for its side effects
// (both the generator and the conversation router do) so the registry is populated
// before anything dispatches through it. Adding a new type = drop a module in
// ./types and register it here.
import { registerType } from './registry.js';
import page from './types/page.js';
import reading from './types/reading.js';
import flashcards from './types/flashcards.js';
import memory from './types/memory.js';
import explorable from './types/explorable.js';

registerType(page);
registerType(reading);
registerType(flashcards);
registerType(memory);
registerType(explorable);
