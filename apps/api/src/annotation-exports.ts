import sharp from 'sharp';
import { buildInkPreviews, type InkPreviewGroup } from '@feedink/ink/preview';
import type { AnnotationDocument } from '@feedink/shared';
import { ApiFailure } from './core.js';
import { notesBackup } from './annotations.js';
import { makeZip } from './zip.js';

const previewFailure = () => new ApiFailure(422, 'INK_RENDER_LIMIT', 'Raw handwriting cannot be rendered within the preview budget; export JSON to preserve all data');
export function previewGroups(doc: AnnotationDocument, groupOffset = 0, groupLimit = 1) {
  try {
    return doc.ink ? buildInkPreviews(doc.ink, { groupOffset, groupLimit }) : { groups: [], totalGroups: 0, nextGroupOffset: null };
  } catch { throw previewFailure(); }
}
/** Only the shared geometry builder supplies SVG; callers cannot submit markup. */
async function rasterPreview(group: InkPreviewGroup): Promise<Buffer> {
  try {
    const bytes = await sharp(Buffer.from(group.svg), { limitInputPixels: 1400 * 1800, failOn: 'warning', density: 72 })
      .png().toBuffer();
    if (bytes.length > 4 * 1024 * 1024) throw new Error();
    return bytes;
  } catch { throw previewFailure(); }
}
export async function notePreview(doc: AnnotationDocument, groupOffset = 0) {
  const result = previewGroups(doc, groupOffset, 1), group = result.groups[0];
  if (!group) throw new ApiFailure(404, 'NOT_FOUND', 'Handwriting preview group not found');
  return { bytes: await rasterPreview(group), totalGroups: result.totalGroups, nextGroupOffset: result.nextGroupOffset, group };
}
export const markdownText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
const quote = (s: string) => s.split(/\r\n|\r|\n/).map(line => `> ${markdownText(line)}`).join('\n');
export async function markdownNotes(doc: AnnotationDocument): Promise<Buffer> {
  const lines = [`# ${markdownText(doc.context.title)}`, '', `Source: ${markdownText(doc.context.sourceUrl)}`, `Mode: ${doc.context.mode}`, `Content: ${doc.contentHash}`, `Revision: ${doc.revision}`, '', 'This report contains raw capture previews, not current article placement. No handwriting recognition is implied. The included notes.json is the restorable source.', ''];
  for (const mark of doc.marks) {
    lines.push(`## ${mark.kind} (${mark.color})`, `ID: ${markdownText(mark.id)}`, `Created: ${mark.createdAt}; updated: ${mark.updatedAt}`, '');
    if (mark.anchor) lines.push(quote(mark.anchor.exact), '');
    else lines.push('Unanchored note.', '');
    if (mark.text) lines.push(quote(mark.text), '');
  }
  const files: { name: string; data: Buffer }[] = [{ name: 'notes.json', data: Buffer.from(JSON.stringify(notesBackup(doc))) }];
  let offset: number | null = 0, bytes = files[0].data.length, pixels = 0;
  while (offset !== null) {
    const page = previewGroups(doc, offset, 1);
    // Full exports either consume every group or fail explicitly before returning a ZIP.
    if (page.totalGroups > 100) throw previewFailure();
    for (const group of page.groups) {
      pixels += group.width * group.height;
      if (pixels > 32_000_000) throw previewFailure();
      const data = await rasterPreview(group);
      bytes += data.length;
      if (bytes > 48 * 1024 * 1024) throw previewFailure();
      const name = `ink/${group.id}.png`;
      files.push({ name, data });
      lines.push(`## Handwriting ${group.id}`, 'Raw / unlocated capture. Not a current-DOM placement claim.', `Strokes: ${group.strokeIds.map(markdownText).join(', ')}`, '', `![Raw handwriting capture](${name})`, '');
    }
    offset = page.nextGroupOffset;
  }
  files.unshift({ name: 'notes.md', data: Buffer.from(lines.join('\n')) });
  return makeZip(files);
}
