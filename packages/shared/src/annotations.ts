import type { Page as InkPage } from '@feedink/ink/types';
export type { Page as InkPage, Stroke as InkStroke, Point as InkPoint } from '@feedink/ink/types';

export type AnnotationMode = 'feed' | 'fulltext';
export type TextMarkKind = 'highlight' | 'underline' | 'wave' | 'note';
export type MarkColor = 'yellow' | 'green' | 'blue' | 'lilac';
export interface TextQuoteAnchor {
  kind: 'text-quote-v1'; exact: string; prefix: string; suffix: string;
  start: number; end: number;
}
export interface TextAnnotation {
  id: string; kind: TextMarkKind; color: MarkColor;
  anchor: TextQuoteAnchor | null;
  text: string;
  createdAt: number; updatedAt: number;
}
export interface AnnotationVersion {
  contentHash: string; revision: number; updatedAt: string;
  markCount: number; strokeCount: number;
}
export interface AnnotationContext {
  articleId: string; mode: AnnotationMode; contentHash: string;
  sourceUrl: string; title: string; contentHtml: string;
}
export interface AnnotationPayload {
  schemaVersion: 1;
  contentHash: string;
  ink: InkPage | null;
  marks: TextAnnotation[];
}
export interface AnnotationDocument extends AnnotationPayload {
  id: string | null;
  context: AnnotationContext;
  revision: number; updatedAt: string | null;
  versions: AnnotationVersion[];
}
export interface AnnotationSummary {
  id: string; articleId: string; mode: AnnotationMode; contentHash: string;
  title: string; sourceUrl: string; revision: number; updatedAt: string;
  markCount: number; strokeCount: number; excerpt: string;
}
export interface NotesBackup {
  format: 'feedink-notes'; version: 1;
  source: { url: string; title: string; mode: AnnotationMode; contentHash: string };
  ink: InkPage | null;
  marks: TextAnnotation[];
}
export const ANNOTATION_LIMITS = {
  bytes: 8 * 1024 * 1024, marks: 5000, quote: 8192, context: 64, text: 32768,
  previewWidth: 1400, previewHeight: 1800,
} as const;
export type McpScope = 'articles:read' | 'notes:read';
export interface McpAccessToken {
  id: string; name: string; scopes: McpScope[]; createdAt: string;
  expiresAt: string; lastUsedAt: string | null;
}
export interface CreatedMcpToken { token: string; access: McpAccessToken }
