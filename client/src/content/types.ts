// Props every native/declarative content renderer receives from the kiosk shell.
// The shell owns the avatar, speech, and mood; renderers drive the interaction.
import type { Profile } from '../lib/types';

export interface ContentRendererProps {
  artifactId: string;
  profile: Profile | null;
  speak: (text: string, profileId?: string, token?: string, voice?: string, onProgress?: (f: number) => void) => Promise<void>;
  speakingId: string | null;
  setMood: (m: 'idle' | 'listening' | 'thinking') => void;
}
