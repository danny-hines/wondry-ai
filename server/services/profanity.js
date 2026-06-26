// Profanity mask for kid/avatar text and any topic that becomes a page title or is
// spoken aloud. Token-based (whole words only) so it never mangles innocent words
// like "class" or "bass". Dependency-free so it's unit-testable in isolation.
// Keep this list in sync with client/src/lib/profanity.ts.
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
const normWord = (w) => w.toLowerCase().replace(/['’]/g, '');
const WORD_RE = /[A-Za-z][A-Za-z'’]*/g;

export function maskProfanity(text) {
  if (!text) return text;
  return String(text).replace(WORD_RE, (w) => (SWEARS.has(normWord(w)) ? '****' : w));
}
export function hasProfanity(text) {
  if (!text) return false;
  return (String(text).match(WORD_RE) || []).some((w) => SWEARS.has(normWord(w)));
}
