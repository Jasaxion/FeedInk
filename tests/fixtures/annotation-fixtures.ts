import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import type {
  AnnotationContext, AnnotationDocument, AnnotationPayload, InkStroke, NotesBackup,
  Session, TextAnnotation, TextMarkKind,
} from '../../packages/shared/src/index.js';
import { csrf, detail, subscribe, waitForArticles } from '../e2e/helpers.js';

// Only first-party upstream.mjs content and generated notes belong in this fixture.
export const fixturePassword = 'FeedInk-annotation-fixture-2026!';
export const fixtureTitle = '墨水屏上的安静阅读';
export const fixtureParagraph = '持久存档应该保留正文与图片，即使订阅源后来删除了旧文章。FeedInk 阅读测试。';
export const fixtureQuote = '持久存档应该保留正文与图片';
export const fixtureRemark = '验收备注：重新阅读这一段。ANNOTATION_PRINT_WITNESS';
export const fixtureUnlocatedQuote = '这段自有测试引文不在当前正文中';
export const fixtureLiteralNote = '<img src=x onerror=alert(1)> & [自有备注](javascript:alert(1))';

export async function createAnnotationUser(api: APIRequestContext): Promise<Session> {
  const response = await api.post('/api/auth/register', { data: {
    email: `annotation-${randomUUID()}@example.test`, password: fixturePassword, name: '批注验收用户',
  } });
  // Credential responses must never be interpolated into assertion diagnostics.
  expect(response.status(), 'synthetic account registration status').toBe(201);
  return response.json();
}

export async function seedAnnotationArticles(api: APIRequestContext, session: Session) {
  const subscription = await subscribe(api, session);
  const list = await waitForArticles(api, subscription.id, 2);
  const first = list.items.find(item => item.title === fixtureTitle);
  const second = list.items.find(item => item.title === '第二篇：慢慢读');
  if (!first || !second) throw new Error('Owned RSS fixture did not produce both articles');
  return { first: await detail(api, first.id), second: await detail(api, second.id) };
}

export function annotationPath(articleId: string, mode = 'feed', contentHash?: string, suffix = '') {
  const params = new URLSearchParams({ mode });
  if (contentHash) params.set('contentHash', contentHash);
  return `/api/articles/${encodeURIComponent(articleId)}/annotations${suffix}?${params}`;
}

export async function getAnnotation(api: APIRequestContext, articleId: string, mode = 'feed', contentHash?: string, origin?: string): Promise<AnnotationDocument> {
  const path = annotationPath(articleId, mode, contentHash);
  const response = await api.get(origin ? new URL(path, origin).href : path);
  expect(response.status(), 'owned annotation GET status').toBe(200);
  return response.json();
}

export async function putAnnotation(api: APIRequestContext, session: Session, document: AnnotationDocument, payload: AnnotationPayload): Promise<AnnotationDocument> {
  const response = await api.put(annotationPath(document.context.articleId, document.context.mode), {
    headers: { ...csrf(session), 'If-Match': `"${document.revision}"` }, data: payload,
  });
  expect(response.status(), 'owned conditional annotation PUT status').toBe(200);
  return response.json();
}

export function textMark(kind: TextMarkKind, text = '', quote = fixtureQuote): TextAnnotation {
  const start = fixtureParagraph.indexOf(quote);
  return {
    id: randomUUID(), kind, color: 'yellow', text,
    anchor: { kind: 'text-quote-v1', exact: quote, prefix: '', suffix: '', start: Math.max(0, start), end: Math.max(0, start) + quote.length },
    createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
  };
}

/** Raw page-plane strokes deliberately require a labelled unlocated preview, not DOM projection. */
export function fixtureStrokes(): InkStroke[] {
  return [
    { color: '#dc2626', tool: 'pen' as const, opacity: 1, y: 40 },
    { color: '#2563eb', tool: 'pen' as const, opacity: 1, y: 110 },
    { color: '#16a34a', tool: 'highlighter' as const, opacity: 0.35, y: 180 },
  ].map(({ color, tool, opacity, y }) => ({
    id: randomUUID(), createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    tool, color, width: tool === 'pen' ? 9 : 18, opacity,
    points: [{ x: 40, y, p: 0.2 }, { x: 90, y: y + 25, p: 0.65 }, { x: 180, y: y + 5, p: 0.9 }],
    anchor: { kind: 'page-v1', basis: [1, 0, 0, 1, 0, 0], reason: 'owned acceptance raw preview' },
  }));
}

export function annotationFixture(context: AnnotationContext): AnnotationPayload {
  return {
    schemaVersion: 1, contentHash: context.contentHash,
    marks: [textMark('highlight'), textMark('underline'), textMark('wave'), textMark('note', fixtureRemark),
      textMark('note', fixtureLiteralNote), textMark('note', '未定位引文必须保留。', fixtureUnlocatedQuote)],
    ink: { version: 1, url: context.sourceUrl, title: context.title, updatedAt: 1_800_000_000_000, layoutWidth: 800, strokes: fixtureStrokes() },
  };
}

export function notesBackup(document: AnnotationDocument): NotesBackup {
  return {
    format: 'feedink-notes', version: 1,
    source: { url: document.context.sourceUrl, title: document.context.title, mode: document.context.mode, contentHash: document.contentHash },
    ink: document.ink, marks: document.marks,
  };
}

export function pngDimensions(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  expect(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature').toBe(true);
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  expect(width).toBeGreaterThan(0); expect(width).toBeLessThanOrEqual(1400);
  expect(height).toBeGreaterThan(0); expect(height).toBeLessThanOrEqual(1800);
  return { width, height };
}

export interface Raster { width: number; height: number; channels: number; pixels: Uint8Array }
/** Independent pixel witness used for decoded PNGs and Poppler-rasterized PDF pages. */
export function colorInventory(rasters: Raster[]) {
  return ['red', 'blue', 'green'].map(color => {
    let count = 0, widest = 0, tallest = 0, clipped = false;
    for (const { width, height, channels, pixels } of rasters) {
      let left = width, right = -1, top = height, bottom = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * channels;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        const match = color === 'red' ? r - g > 35 && r - b > 35 : color === 'blue' ? b - r > 35 && b - g > 20 : g - r > 20 && g - b > 15;
        if (!match) continue;
        count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      if (right >= 0) {
        widest = Math.max(widest, right - left); tallest = Math.max(tallest, bottom - top);
        clipped ||= left === 0 || top === 0 || right === width - 1 || bottom === height - 1;
      }
    }
    return { color, count, widest, tallest, clipped };
  });
}

export function assertAllStrokeColors(rasters: Raster[]) {
  for (const result of colorInventory(rasters)) {
    expect(result.count, `${result.color} stroke pixel count`).toBeGreaterThan(30);
    expect(result.widest, `${result.color} stroke horizontal geometry`).toBeGreaterThan(15);
    expect(result.tallest, `${result.color} stroke vertical geometry`).toBeGreaterThan(5);
    expect(result.clipped, `${result.color} stroke must not touch output boundary`).toBe(false);
  }
}

/** Poppler's binary RGB PPM avoids a test-only image-decoder dependency. */
export function parsePpm(buffer: Buffer): Raster {
  let offset = 0;
  function token() {
    while (offset < buffer.length) {
      if (buffer[offset] === 35) { while (offset < buffer.length && buffer[offset] !== 10) offset++; }
      else if (buffer[offset] <= 32) offset++;
      else break;
    }
    const start = offset;
    while (offset < buffer.length && buffer[offset] > 32) offset++;
    return buffer.subarray(start, offset).toString('ascii');
  }
  if (token() !== 'P6') throw new Error('Expected a Poppler RGB raster');
  const width = Number(token()), height = Number(token()), maximum = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 20_000_000 || maximum !== 255) throw new Error('Unexpected PDF raster geometry');
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2; else offset++;
  const pixels = buffer.subarray(offset);
  if (pixels.length !== width * height * 3) throw new Error('Incomplete PDF raster');
  return { width, height, channels: 3, pixels };
}
