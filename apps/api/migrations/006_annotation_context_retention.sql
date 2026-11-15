-- Retain verified contexts before the first note save so offline drafts remain syncable.
CREATE TABLE annotation_contexts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('feed','fulltext')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL,
  title text NOT NULL,
  content_html text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,article_id,mode,content_hash),
  FOREIGN KEY (article_id,user_id) REFERENCES articles(id,user_id) ON DELETE CASCADE
);
INSERT INTO annotation_contexts(user_id,article_id,mode,content_hash,source_url,title,content_html)
SELECT user_id,article_id,mode,content_hash,source_url,title,content_html FROM annotations
ON CONFLICT DO NOTHING;
