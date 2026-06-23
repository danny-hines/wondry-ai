// Single in-process event bus. The websocket layer subscribes and broadcasts
// every event to connected kiosks/portals. Generation is event-driven so it
// can outlive the conversation view (idle timeout) and still announce/badge.
import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
bus.setMaxListeners(50);
export function emit(type, payload) { bus.emit('event', { type, ...payload, at: Date.now() }); }
