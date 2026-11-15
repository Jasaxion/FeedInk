import type { AnnotationDocument } from '@feedink/shared';
import { buildInkPreviews } from '@feedink/ink/preview';
import { backupOf, markLabels, validateAnnotations } from './annotationData';
import { downloadBlob, HttpError } from './api';
import { assertAuthEpoch, authEpoch } from './authEpoch';
import { annotationPath } from './annotationSync';

export function exportNotesJson(document: AnnotationDocument) {
  downloadBlob(new Blob([JSON.stringify(backupOf(document), null, 2)], { type: 'application/json' }), `FeedInk-notes-${document.contentHash.slice(0, 12)}.json`);
}
export async function exportNotesMarkdown(document: AnnotationDocument) {
  const epoch = authEpoch(), path = annotationPath(document.context).replace('/annotations?', '/annotations/export?');
  const response = await fetch(`/api${path}&format=markdown`, { credentials: 'same-origin', cache: 'no-store' });
  assertAuthEpoch(epoch);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('feedink:unauthorized'));
    throw new HttpError(response.status, `Markdown 导出失败 (${response.status})；当前草稿未丢失`);
  }
  const blob = await response.blob(); assertAuthEpoch(epoch); downloadBlob(blob, 'FeedInk-notes.zip');
}
/** Presentation report only: every raw stroke is inventoried, never restored from SVG. */
export function printNotes(document: AnnotationDocument) {
  const epoch = authEpoch();
  const snapshot = validateAnnotations(document);
  const previews: ReturnType<typeof buildInkPreviews>['groups'] = [];
  if (snapshot.ink) {
    let offset: number | null = 0;
    do {
      const page: ReturnType<typeof buildInkPreviews> = buildInkPreviews(snapshot.ink, { groupOffset: offset, groupLimit: 20, maxWidth: 1000, maxHeight: 1400 });
      previews.push(...page.groups);
      if (previews.length > 200 || previews.reduce((sum, group) => sum + group.width * group.height, 0) > 40_000_000) throw new Error('打印笔迹超过展示预算，请导出完整 JSON 或服务器 Markdown 包；未生成不完整报告');
      if (page.nextGroupOffset !== null && page.nextGroupOffset <= offset) throw new Error('笔迹预览分页未前进，未生成不完整报告');
      offset = page.nextGroupOffset;
    } while (offset !== null);
    const represented = new Set(previews.flatMap(group => group.strokeIds));
    if (snapshot.ink.strokes.some(stroke => !represented.has(stroke.id))) throw new Error('部分笔迹无法预览；请导出 JSON 保留全部数据，未生成不完整报告');
  }
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('浏览器阻止打印窗口，请允许弹出窗口后重试');
  popup.opener = null;
  const cancel = () => { popup.close(); cleanup(); };
  const cleanup = () => { window.removeEventListener('feedink:identity-lock', cancel); window.removeEventListener('feedink:annotation-context-retired', cancel); };
  window.addEventListener('feedink:identity-lock', cancel); window.addEventListener('feedink:annotation-context-retired', cancel);
  popup.addEventListener('pagehide', cleanup, { once: true });
  const doc = popup.document; doc.title = `${snapshot.context.title} · 批注报告`;
  doc.documentElement.lang = 'zh-CN'; doc.body.replaceChildren();
  const style = doc.createElement('style');
  style.textContent = '@page{size:A4;margin:16mm}body{font:16px/1.65 system-ui,sans-serif;color:#111;background:white;max-width:180mm;margin:20px auto;padding:0 12px}h1{font-size:24px}section,figure{break-inside:avoid;margin:20px 0}blockquote{border-left:3px solid #777;padding-left:12px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere}img{display:block;max-width:100%;max-height:235mm;object-fit:contain}small{color:#444}button{padding:12px} @media print{button{display:none}body{margin:0;padding:0}}';
  doc.head.append(style);
  const add = (tag: string, text: string, parent: HTMLElement = doc.body) => { const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node; };
  add('h1', snapshot.context.title || '批注报告');
  add('p', `来源：${snapshot.context.sourceUrl}\n模式：${snapshot.context.mode} · 内容 ${snapshot.contentHash}\n服务器基线修订 ${snapshot.revision} · 含当前草稿`);
  add('p', '此 PDF 是批注展示报告，不是可恢复备份。引用与备注全部列出；笔迹按原始锚点分组，不宣称与当前正文排版重合。未定位笔迹也保留原始预览。请另存 JSON 以恢复全部数据。');
  const button = add('button', '正在准备打印图片…') as HTMLButtonElement; button.disabled = true;
  for (const mark of snapshot.marks) {
    const section = add('section', ''); add('h2', markLabels[mark.kind], section);
    if (mark.anchor) add('blockquote', mark.anchor.exact, section);
    else add('small', '整篇备注（无文字选区）', section);
    if (mark.text) add('p', mark.text, section);
  }
  const images: Promise<void>[] = [];
  for (const group of previews) {
    const figure = add('figure', '');
    add('figcaption', `笔迹组 · ${group.strokeIds.length} 笔 · ${group.unlocated ? '未定位 / 原始预览' : '原始锚点预览（非当前正文定位）'}`, figure);
    const image = doc.createElement('img'); image.alt = `笔迹组 ${group.id}`; image.width = group.width; image.height = group.height;
    const url = URL.createObjectURL(new Blob([group.svg], { type: 'image/svg+xml' }));
    images.push(new Promise<void>((resolve, reject) => { image.onload = () => { URL.revokeObjectURL(url); resolve(); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('笔迹图片加载失败')); }; }));
    image.src = url; figure.append(image);
  }
  void Promise.all([...images, doc.fonts.ready]).then(() => { assertAuthEpoch(epoch); if (popup.closed) return; doc.body.dataset.testid = 'annotation-print-view'; button.disabled = false; button.textContent = '打印 / PDF'; button.onclick = () => popup.print(); }).catch(() => { button.textContent = '预览失败，报告不完整；请关闭并导出 JSON'; });
}
