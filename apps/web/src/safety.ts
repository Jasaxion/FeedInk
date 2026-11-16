import DOMPurify from 'dompurify';
import { ARTICLE_CSS_PROPERTIES, isSafeArticleCss } from '@feedink/shared';
import { ownedAssetUrl, safeExternalUrl } from './logic';

export function sanitizeArticle(html: string, lazyImages = true): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption', 'picture', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'class'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const template = document.createElement('template'); template.innerHTML = clean;
  for (const element of template.content.querySelectorAll('[class]')) {
    const classes = ['CODE', 'PRE'].includes(element.tagName) ? [...element.classList].filter(name => /^(?:language|lang)-[a-zA-Z0-9_-]{1,40}$/.test(name)) : [];
    if (classes.length) element.className = classes.join(' '); else element.removeAttribute('class');
  }
  for (const anchor of template.content.querySelectorAll('a')) {
    const href = safeExternalUrl(anchor.getAttribute('href') || '');
    if (href) { anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } else anchor.removeAttribute('href');
  }
  for (const image of template.content.querySelectorAll('img')) {
    const src = ownedAssetUrl(image.getAttribute('src') || '');
    if (src) { image.src = src; image.dataset.asset = src; image.referrerPolicy = 'no-referrer'; image.loading = lazyImages ? 'lazy' : 'eager'; }
    else { image.removeAttribute('src'); image.alt = image.alt || '图片未归档，请尝试重新抓取图片或访问原文'; }
  }
  return template.innerHTML;
}

const properties = ARTICLE_CSS_PROPERTIES;
/** Parse, whitelist, and scope declarations. No imports, URLs, variables, positioning, or selectors outside article content. */
export function scopedCss(css: string): string {
  if (!css.trim()) return '';
  if (/[\\@<>]|url\s*\(|expression\s*\(|var\s*\(/i.test(css)) throw new Error('自定义 CSS 不允许 @规则、URL、转义、变量或活动内容');
  if (!isSafeArticleCss(css)) throw new Error('自定义 CSS 不允许此选择器或属性');
  const declarationsOnly = !/[{}]/.test(css);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(declarationsOnly ? `p{${css}}` : css);
  const output: string[] = [];
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule)) throw new Error('只允许正文样式规则');
    const selectors = rule.selectorText.split(',').map(value => value.trim());
    if (selectors.some(value => !/^(?:(?:p|div|span|h[1-6]|a|img|figure|figcaption|blockquote|pre|code|ul|ol|li|table|th|td|strong|em|small|hr|details|summary)(?:\.[a-zA-Z][\w-]*)?)(?:\s+(?:(?:p|div|span|a|img|pre|code|li|strong|em)|\.[a-zA-Z][\w-]*))*$/.test(value))) throw new Error('选择器只能是正文元素（例如 p、h2、pre code）');
    const declarations: string[] = [];
    for (const property of rule.style) {
      const value = rule.style.getPropertyValue(property);
      if (!properties.has(property) || /[{};]|(?:fixed|absolute|sticky)/i.test(value)) throw new Error(`不允许样式属性：${property}`);
      declarations.push(`${property}:${value}`);
    }
    output.push(`${declarationsOnly ? '.article-content' : selectors.map(selector => `.article-content ${selector}`).join(',')}{${declarations.join(';')}}`);
  }
  return output.join('\n');
}
