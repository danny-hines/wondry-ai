// Render a small subset of markdown to HTML for chat bubbles, and strip markdown
// for text that gets read aloud (so TTS never speaks asterisks / hyphens).
function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}
function mdInline(s: string): string {
  return escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
export function mdToHtml(src: string): string {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let html = '',
    list: string | null = null;
  const closeList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m: RegExpMatchArray | null;
    if (!line.trim()) {
      closeList();
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const n = m[1].length;
      html += `<h${n}>${mdInline(m[2])}</h${n}>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${mdInline(m[1])}</li>`;
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${mdInline(m[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${mdInline(line)}</p>`;
  }
  closeList();
  return html;
}
export function stripMarkdown(s: string): string {
  return (
    String(s)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      // Em/en dashes (and "--") read oddly aloud; turn them into a comma pause.
      .replace(/\s*(?:—|–|--+)\s*/g, ', ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{2,}/g, '. ')
      .replace(/\s+([.,])/g, '$1')
      .replace(/,\s*,/g, ',')
      .trim()
  );
}
