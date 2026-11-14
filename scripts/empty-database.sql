-- PostgreSQL reserves OIDs below FirstNormalObjectId (16384) for bootstrap objects.
-- Inspect database-scoped object catalogs, not just relations/dependencies: a cast
-- between built-in types, a collation, or a handler-free FDW can otherwise escape.
-- Shared cluster roles/databases/tablespaces are intentionally not database contents.
WITH object_ids AS (
  SELECT oid FROM pg_class
  UNION ALL SELECT oid FROM pg_proc
  UNION ALL SELECT oid FROM pg_type
  UNION ALL SELECT oid FROM pg_namespace
  UNION ALL SELECT oid FROM pg_am
  UNION ALL SELECT oid FROM pg_attrdef
  UNION ALL SELECT oid FROM pg_cast
  UNION ALL SELECT oid FROM pg_collation
  UNION ALL SELECT oid FROM pg_constraint
  UNION ALL SELECT oid FROM pg_conversion
  UNION ALL SELECT oid FROM pg_default_acl
  UNION ALL SELECT oid FROM pg_event_trigger
  UNION ALL SELECT oid FROM pg_extension
  UNION ALL SELECT oid FROM pg_foreign_data_wrapper
  UNION ALL SELECT oid FROM pg_foreign_server
  UNION ALL SELECT oid FROM pg_language
  UNION ALL SELECT oid FROM pg_operator
  UNION ALL SELECT oid FROM pg_opclass
  UNION ALL SELECT oid FROM pg_opfamily
  UNION ALL SELECT oid FROM pg_policy
  UNION ALL SELECT oid FROM pg_publication
  UNION ALL SELECT oid FROM pg_publication_namespace
  UNION ALL SELECT oid FROM pg_publication_rel
  UNION ALL SELECT oid FROM pg_rewrite
  UNION ALL SELECT oid FROM pg_statistic_ext
  UNION ALL SELECT oid FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  UNION ALL SELECT oid FROM pg_transform
  UNION ALL SELECT oid FROM pg_trigger
  UNION ALL SELECT oid FROM pg_ts_config
  UNION ALL SELECT oid FROM pg_ts_dict
  UNION ALL SELECT oid FROM pg_ts_parser
  UNION ALL SELECT oid FROM pg_ts_template
  UNION ALL SELECT oid FROM pg_user_mapping
)
SELECT (SELECT count(*) FROM object_ids WHERE oid >= 16384) +
  -- Large objects have no bootstrap entries and lo_create permits an explicit low OID.
  (SELECT count(*) FROM pg_largeobject_metadata);
