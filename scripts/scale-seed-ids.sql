-- Synthetic custom UUIDv8: MD5 supplies deterministic payload bits, never keys.
-- Explicit version 8 and RFC variant 10xx make every linked ID cursor-valid.
CREATE FUNCTION scale_seed_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT overlay(overlay(md5(value) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
