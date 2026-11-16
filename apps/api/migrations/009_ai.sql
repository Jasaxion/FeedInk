-- Optional AI never alters original articles, annotation contexts or annotations.
CREATE TABLE ai_configs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  base_url text NOT NULL DEFAULT '' CHECK (length(base_url) <= 2048),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
  encrypted_key text,
  target_language text NOT NULL DEFAULT 'zh-CN' CHECK (target_language IN ('zh-CN','en','ja','ko','fr','de','es')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz
);
CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('feed','fulltext')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  cache_key text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  config_revision integer NOT NULL,
  prompt_version text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('summary','translate')),
  target_language text NOT NULL CHECK (target_language IN ('zh-CN','en','ja','ko','fr','de','es')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','skipped','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued',
  completed_chunks integer NOT NULL DEFAULT 0 CHECK (completed_chunks >= 0),
  total_chunks integer NOT NULL DEFAULT 0 CHECK (total_chunks >= completed_chunks),
  detected_language text,
  source_html text NOT NULL,
  source_title text NOT NULL,
  source_url text NOT NULL,
  result jsonb,
  error_code text,
  lease_token uuid,
  lease_until timestamptz,
  started_at timestamptz,
  call_in_flight boolean NOT NULL DEFAULT false,
  provider_calls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (article_id,user_id) REFERENCES articles(id,user_id) ON DELETE CASCADE,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (result IS NULL OR status IN ('succeeded','skipped'))
);
CREATE UNIQUE INDEX ai_jobs_active_key ON ai_jobs(user_id,cache_key) WHERE status IN ('queued','running');
CREATE INDEX ai_jobs_queue ON ai_jobs(created_at,id) WHERE status='queued';
CREATE INDEX ai_jobs_leases ON ai_jobs(lease_until,id) WHERE status='running';
CREATE INDEX ai_jobs_owner_active ON ai_jobs(user_id,status) WHERE status IN ('queued','running');
CREATE INDEX ai_jobs_cache ON ai_jobs(user_id,cache_key,created_at DESC,id) WHERE status IN ('succeeded','skipped');
CREATE INDEX ai_jobs_terminal_cleanup ON ai_jobs(updated_at,id) WHERE status NOT IN ('queued','running');
CREATE INDEX ai_jobs_owner_history ON ai_jobs(user_id,created_at,id);
CREATE INDEX ai_jobs_article_owner ON ai_jobs(article_id,user_id);
