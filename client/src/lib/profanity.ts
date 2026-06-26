// Final-gate profanity mask for anything rendered on screen or spoken aloud. Kids
// (and mis-transcriptions — e.g. whisper hearing "foxes" as an expletive) can put
// swears into the text path; this blanks them to **** at the render/TTS boundary.
// Token-based (whole words only) so it can't mangle innocent words like "class".
// Keep this list in sync with server/services/safety.js.
const SWEARS = new Set([
  'fuck', 'fucks', 'fucker', 'fuckers', 'fucking', 'fucked', 'fuckin', 'motherfucker', 'motherfuckers', 'clusterfuck',
  'shit', 'shits', 'shitty', 'shitting', 'shithead', 'shithole', 'bullshit', 'dipshit',
  'bitch', 'bitches', 'bitching', 'bitchy', 'cunt', 'cunts',
  'asshole', 'assholes', 'dumbass', 'jackass', 'asshat', 'ass', 'asses',
  'dick', 'dicks', 'dickhead', 'dickheads', 'pussy', 'pussies', 'cock', 'cocks', 'cocksucker',
  'piss', 'pissed', 'pissing', 'bastard', 'bastards', 'prick', 'pricks', 'slut', 'sluts', 'whore', 'whores',
  'goddamn', 'goddamned', 'damn', 'damned', 'dammit', 'wanker', 'bollocks', 'twat', 'twats', 'douche', 'douchebag',
  'faggot', 'faggots', 'fag', 'fags', 'retard', 'retarded', 'retards', 'nigger', 'niggers', 'nigga', 'niggas',
]);
const norm = (w: string) => w.toLowerCase().replace(/['’]/g, '');
const WORD = /[A-Za-z][A-Za-z'’]*/g;

export function maskProfanity(text: string): string {
  if (!text) return text;
  return text.replace(WORD, (w) => (SWEARS.has(norm(w)) ? '****' : w));
}
export function hasProfanity(text: string): boolean {
  if (!text) return false;
  return (text.match(WORD) || []).some((w) => SWEARS.has(norm(w)));
}
