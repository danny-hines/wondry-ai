// Registers built-in media sources. Import for side effects. Add a source =
// drop an adapter in ./sources and register it here.
import { registerSource } from './registry.js';
import wikimedia from './sources/wikimedia.js';

registerSource(wikimedia);
