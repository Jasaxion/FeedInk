/** Optional, explicitly requested account-scoped AI reading operations. */
export type AiOperation = 'summary' | 'translate';
export type AiLanguage = 'zh-CN' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es';
export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  targetLanguage: AiLanguage;
  revision: number;
  updatedAt: string | null;
}
export interface AiJob {
  id: string;
  articleId: string;
  mode: 'feed' | 'fulltext';
  /** Same canonical selected-context identity as annotations, not the ingest body hash. */
  contentHash: string;
  operation: AiOperation;
  targetLanguage: AiLanguage;
  status: 'queued' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
  stage: string;
  completedChunks: number;
  totalChunks: number;
  detectedLanguage: AiLanguage | 'mixed' | 'unknown' | null;
  createdAt: string;
  updatedAt: string;
  result?: { summaryText?: string; bilingualHtml?: string; sourceTitle: string; sourceUrl: string };
  error?: { code: string; message: string };
}
