import { createContext, useContext } from 'react';
import type { ArticleDetail, ArticleStatePatch, ArticleSummary, ReaderSettings, Session } from '@feedink/shared';
import type { Library, OfflineStore } from './offline';

export interface AppContextValue {
  session: Session;
  library: Library;
  store: OfflineStore;
  online: boolean;
  articles: ArticleSummary[];
  article: ArticleDetail | null;
  navigate: (path: string, replace?: boolean) => void;
  notify: (message: string, error?: boolean) => void;
  task: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  refresh: () => void;
  updateSettings: (settings: Partial<ReaderSettings>) => Promise<void>;
  updateSession: (session: Session) => void;
  patchArticle: (article: ArticleSummary, patch: ArticleStatePatch) => Promise<void>;
  openArticle: (id: string) => void;
  logout: () => Promise<void>;
  cacheArticle: (article: ArticleDetail) => Promise<void>;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppContext missing');
  return value;
}
