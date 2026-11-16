import { createElement, useMemo, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import type { ArticleDetail } from '@feedink/shared';
import { AssetImage } from './components';
import { ownedAssetUrl, safeExternalUrl } from './logic';

const tags = ['section', 'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'];
const languages = new Set(['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es']);

/** Server HTML is untrusted. No generated URL, CSS, active content or annotation identity survives. */
export function sanitizeAiBilingual(html: string, sourceHtml: string, article: Pick<ArticleDetail, 'images' | 'url'>): DocumentFragment {
  const source = document.createElement('template');
  source.innerHTML = DOMPurify.sanitize(sourceHtml, { ALLOWED_TAGS: ['a', 'img'], ALLOWED_ATTR: ['href', 'src'] });
  const links = new Set([safeExternalUrl(article.url), ...Array.from(source.content.querySelectorAll('a'), node => safeExternalUrl(node.getAttribute('href') || ''))].filter((value): value is string => !!value));
  const sourceAssets = new Set(Array.from(source.content.querySelectorAll('img'), node => ownedAssetUrl(node.getAttribute('src') || '')));
  const images = new Set(article.images.filter(image => image.status === 'cached' && sourceAssets.has(image.url) && ownedAssetUrl(image.url)).map(image => image.url));
  const fragment = DOMPurify.sanitize(html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'class', 'lang'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  // A disclosure has one native, direct activation target. Extra/misnested summaries
  // are content, not additional controls. The API uses inline pairs inside this target.
  for (const summary of fragment.querySelectorAll('summary')) {
    if (summary.parentElement?.tagName !== 'DETAILS' || summary.parentElement.querySelector(':scope > summary') !== summary) summary.replaceWith(...summary.childNodes);
  }
  for (const node of fragment.querySelectorAll('*')) {
    const inlinePair = node.tagName === 'SPAN' && node.parentElement?.tagName === 'SUMMARY' && node.parentElement.parentElement?.tagName === 'DETAILS';
    const pairContent = node.tagName === 'DIV' || inlinePair;
    const marker = node.tagName === 'SECTION' ? 'feedink-ai-pair' : pairContent && node.classList.contains('feedink-ai-source') ? 'feedink-ai-source' : pairContent ? 'feedink-ai-target' : '';
    if (marker && node.classList.contains(marker)) node.setAttribute('class', marker); else node.removeAttribute('class');
    const lang = node.getAttribute('lang') || '';
    if (!pairContent || !node.hasAttribute('class') || !(marker === 'feedink-ai-target' ? languages.has(lang) : /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(lang))) node.removeAttribute('lang');
    // Strip URL attributes even from an unexpected allowed tag (e.g. a src on a div).
    const href = safeExternalUrl(node.getAttribute('href') || ''); node.removeAttribute('href');
    if (node.tagName === 'A' && href && links.has(href)) { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    const src = node.getAttribute('src') || ''; node.removeAttribute('src');
    if (node.tagName === 'IMG') { if (images.has(src)) node.setAttribute('src', src); else node.remove(); }
    for (const attribute of ['colspan', 'rowspan']) if (node.hasAttribute(attribute) && !/^[1-9]\d?$/.test(node.getAttribute(attribute)!)) node.removeAttribute(attribute);
  }
  return fragment;
}
function renderNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;
  if (node.tagName === 'IMG') return <AssetImage key={key} src={node.getAttribute('src')} alt={node.getAttribute('alt') || '归档图片'} />;
  const props: Record<string, string> = { key };
  for (const name of ['href', 'target', 'rel', 'title', 'lang']) if (node.hasAttribute(name)) props[name] = node.getAttribute(name)!;
  if (node.hasAttribute('class')) props.className = node.getAttribute('class')!;
  for (const [attribute, prop] of [['colspan', 'colSpan'], ['rowspan', 'rowSpan']]) if (node.hasAttribute(attribute)) props[prop] = node.getAttribute(attribute)!;
  const children = Array.from(node.childNodes, (child, index) => renderNode(child, `${key}.${index}`));
  return createElement(node.tagName.toLowerCase(), props, ...children);
}
export function AiBilingual({ html, sourceHtml, article }: { html: string; sourceHtml: string; article: ArticleDetail }) {
  const children = useMemo(() => Array.from(sanitizeAiBilingual(html, sourceHtml, article).childNodes, (node, index) => renderNode(node, String(index))), [html, sourceHtml, article.images, article.url]);
  return <div className="ai-bilingual" data-testid="ai-bilingual">{children}</div>;
}
