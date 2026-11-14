CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, is_admin boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE folders (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, position integer NOT NULL DEFAULT 0, settings jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE feeds (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL, title text NOT NULL, site_url text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  etag text, last_modified text, last_fetched_at timestamptz, last_error text,
  status text NOT NULL DEFAULT 'pending', failures integer NOT NULL DEFAULT 0,
  next_fetch_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,url)
);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id uuid NOT NULL UNIQUE REFERENCES feeds(id), title text NOT NULL,
  folder_id uuid REFERENCES folders(id) ON DELETE SET NULL, position integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE articles (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id uuid REFERENCES feeds(id), guid text NOT NULL, feed_title text NOT NULL,
  title text NOT NULL, url text NOT NULL, author text, published_at timestamptz NOT NULL,
  summary text NOT NULL DEFAULT '', content_html text NOT NULL, fulltext_html text,
  content_text text NOT NULL, content_hash text NOT NULL, fulltext_hash text,
  fulltext_fetched_at timestamptz, fulltext_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz NOT NULL DEFAULT now(),
  word_count integer NOT NULL DEFAULT 0, enclosures jsonb NOT NULL DEFAULT '[]',
  read boolean NOT NULL DEFAULT false, saved boolean NOT NULL DEFAULT false,
  progress real NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1), UNIQUE(feed_id,guid)
);
CREATE INDEX articles_user_date ON articles(user_id,published_at,id);
CREATE INDEX articles_search ON articles USING gin(to_tsvector('simple', title || ' ' || content_text));
CREATE TABLE images (
  id uuid PRIMARY KEY, article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  original_url text NOT NULL, status text NOT NULL DEFAULT 'pending', content_type text,
  file_key text, content_hash text, last_error text, captured_at timestamptz,
  UNIQUE(article_id,original_url)
);
CREATE TABLE tags (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, color text NOT NULL DEFAULT '#861dd4', UNIQUE(user_id,name)
);
CREATE TABLE article_tags (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(article_id,tag_id)
);
CREATE TABLE ebooks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL, article_count integer NOT NULL, file_key text, created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz, error text, schedule_key text, UNIQUE(user_id,schedule_key)
);
CREATE TABLE ebook_articles (
  ebook_id uuid NOT NULL REFERENCES ebooks(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE, PRIMARY KEY(ebook_id,article_id)
);
CREATE INDEX feeds_due ON feeds(next_fetch_at);
