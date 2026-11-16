-- Additive positive-witness index; the full-content 010 index stays in place.
-- Stop API/worker/import writers for the checksum runner's maintenance window.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  extension_schema text;
  articles_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='pg_trgm';
  IF extension_schema IS NULL THEN
    RAISE EXCEPTION '011_search_prefix_index requires pg_trgm from migration 010; apply 010 first';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(extension_schema, 'USAGE') THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='011_search_prefix_index requires USAGE on the existing pg_trgm schema; grant it to the migration role without moving the extension';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_opclass o
      JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
      JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod
      JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_opclass'::regclass AND d.objid=o.oid AND d.deptype='e'
      JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid AND d.refclassid='pg_catalog.pg_extension'::regclass
    WHERE n.nspname=extension_schema AND o.opcname='gin_trgm_ops' AND a.amname='gin' AND e.extname='pg_trgm'
  ) THEN
    RAISE EXCEPTION '011_search_prefix_index requires the pg_trgm GIN operator class; repair the extension before retrying';
  END IF;
  SELECT n.nspname INTO STRICT articles_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid='articles'::regclass;
  EXECUTE format('LOCK TABLE %I.articles IN SHARE MODE', articles_schema);
  -- Keep the constant/expression identical to article-search.ts. Indexing this
  -- additional OR branch preserves rare-pattern bitmap-OR eligibility.
  EXECUTE format('CREATE INDEX articles_content_prefix_trgm ON %I.articles USING gin ((left(content_text,256)) %I.gin_trgm_ops)', articles_schema, extension_schema);
END $$;
