/** Shared grammar for the intentionally small, article-scoped style editor. */
export const ARTICLE_CSS_PROPERTIES = new Set(['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-indent', 'word-break', 'overflow-wrap', 'white-space', 'margin', 'margin-top', 'margin-bottom', 'padding', 'padding-top', 'padding-bottom', 'border', 'border-color', 'border-width', 'border-style', 'border-radius', 'max-width']);
export const ARTICLE_CSS_SELECTOR = /^(?:(?:p|div|span|h[1-6]|a|img|figure|figcaption|blockquote|pre|code|ul|ol|li|table|th|td|strong|em|small|hr|details|summary)(?:\.[a-zA-Z][\w-]*)?)(?:\s+(?:(?:p|div|span|a|img|pre|code|li|strong|em)|\.[a-zA-Z][\w-]*))*$/;
const forbidden = /[\\@<>]|\/\*|\*\/|(?:url|expression|var)\s*\(/i;
function declarations(value: string): boolean {
  const entries = value.split(';').map(item => item.trim()).filter(Boolean);
  return entries.length > 0 && entries.every(entry => {
    const match = entry.match(/^([a-z-]+)\s*:\s*(.+)$/is);
    return !!match && ARTICLE_CSS_PROPERTIES.has(match[1].toLowerCase()) && /^[#\p{L}\p{N}\s.,%()'"+/-]+$/u.test(match[2]);
  });
}
export function isSafeArticleCss(css: string): boolean {
  if (!css.trim()) return true;
  if (css.length > 2000 || forbidden.test(css)) return false;
  if (!/[{}]/.test(css)) return declarations(css);
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  let end = 0, found = false;
  for (const match of css.matchAll(rules)) {
    if (css.slice(end, match.index).trim() || !match[1].split(',').every(selector => ARTICLE_CSS_SELECTOR.test(selector.trim())) || !declarations(match[2])) return false;
    found = true; end = match.index! + match[0].length;
  }
  return found && !css.slice(end).trim();
}
