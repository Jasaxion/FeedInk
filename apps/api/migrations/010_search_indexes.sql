-- Maintenance window: stop API/worker/import writers before the checksum runner.
-- One transaction; ordinary GIN builds, never CREATE INDEX CONCURRENTLY here.
-- Covers every literal OR branch without changing FTS, escaping or exact totals.
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
    BEGIN
      -- Explicit target: an isolated application search_path need not include public.
      -- Operators may instead preinstall in a trusted schema of their choice.
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION USING ERRCODE='42501',
          MESSAGE='010_search_indexes requires pg_trgm; have the database owner preinstall it in a trusted schema and grant the migration role USAGE on that schema';
      WHEN undefined_file OR feature_not_supported THEN
        RAISE EXCEPTION USING ERRCODE='0A000',
          MESSAGE='010_search_indexes requires server-side pg_trgm extension files; provision PostgreSQL contrib/extension support before retrying';
      WHEN invalid_schema_name THEN
        RAISE EXCEPTION USING ERRCODE='3F000',
          MESSAGE='010_search_indexes cannot install pg_trgm in public; have the database owner preinstall it in an existing trusted schema';
    END;
    SELECT n.nspname INTO extension_schema
      FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname='pg_trgm';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(extension_schema, 'USAGE') THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='010_search_indexes requires USAGE on the existing pg_trgm schema; grant it to the migration role without moving the extension';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_opclass o
      JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
      JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod
      JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_opclass'::regclass AND d.objid=o.oid AND d.deptype='e'
      JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid AND d.refclassid='pg_catalog.pg_extension'::regclass
    WHERE n.nspname=extension_schema AND o.opcname='gin_trgm_ops' AND a.amname='gin' AND e.extname='pg_trgm'
  ) THEN
    RAISE EXCEPTION '010_search_indexes requires the pg_trgm GIN operator class; repair the extension before retrying';
  END IF;

  SELECT n.nspname INTO STRICT articles_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid='articles'::regclass;
  -- SHARE blocks writes while allowing reads. All three scans/builds share the
  -- 15-minute DO statement budget; timeout rolls back the entire migration.
  EXECUTE format('LOCK TABLE %I.articles IN SHARE MODE', articles_schema);
  EXECUTE format('CREATE INDEX articles_title_trgm ON %I.articles USING gin (title %I.gin_trgm_ops)', articles_schema, extension_schema);
  EXECUTE format('CREATE INDEX articles_content_text_trgm ON %I.articles USING gin (content_text %I.gin_trgm_ops)', articles_schema, extension_schema);
  EXECUTE format('CREATE INDEX articles_url_trgm ON %I.articles USING gin (url %I.gin_trgm_ops)', articles_schema, extension_schema);
END $$;
