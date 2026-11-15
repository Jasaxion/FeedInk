-- Annotation context ownership is enforced independently of route validation.
ALTER TABLE articles ADD CONSTRAINT articles_id_user_unique UNIQUE (id,user_id);
CREATE TABLE annotations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('feed','fulltext')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL,
  title text NOT NULL,
  content_html text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  ink jsonb,
  marks jsonb NOT NULL CHECK (jsonb_typeof(marks)='array'),
  mark_count integer NOT NULL CHECK (mark_count BETWEEN 0 AND 5000),
  stroke_count integer NOT NULL CHECK (stroke_count BETWEEN 0 AND 5000),
  search_text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (article_id,user_id) REFERENCES articles(id,user_id) ON DELETE CASCADE,
  UNIQUE (user_id,article_id,mode,content_hash)
);
CREATE INDEX annotations_owner_updated ON annotations(user_id,updated_at DESC,id);
-- Bound FTS lexeme storage; complete literal search still covers all stored text.
CREATE INDEX annotations_search ON annotations USING gin(to_tsvector('simple',left(search_text,65536)));
CREATE TABLE mcp_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 2 AND scopes <@ ARRAY['articles:read','notes:read']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX mcp_tokens_owner ON mcp_tokens(user_id);
