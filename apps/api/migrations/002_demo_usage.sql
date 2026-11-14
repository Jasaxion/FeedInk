CREATE TABLE demo_outbound_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,bucket)
);
