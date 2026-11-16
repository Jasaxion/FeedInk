-- Maintenance-window migration: stop API/worker/import writers before deploying.
-- The checksum runner wraps this file in one transaction. Never use CONCURRENTLY here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
LOCK TABLE users, feeds, subscriptions, tags, articles, article_tags IN ACCESS EXCLUSIVE MODE;

-- Empty keys mean untagged dimension / feedless; '*' means all feeds. UUID text
-- cannot collide with either marker. A base (empty tag) bucket includes ALL articles.
CREATE TABLE article_counts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_key text NOT NULL,
  feed_key text NOT NULL,
  total bigint NOT NULL CHECK (total >= 0),
  unread bigint NOT NULL CHECK (unread BETWEEN 0 AND total),
  saved bigint NOT NULL CHECK (saved BETWEEN 0 AND total),
  PRIMARY KEY (user_id, tag_key, feed_key)
);
CREATE TABLE article_count_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  valid boolean NOT NULL DEFAULT true
);
INSERT INTO article_count_state(user_id) SELECT id FROM users;

CREATE FUNCTION scale_new_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO article_count_state(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER scale_new_owner AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION scale_new_owner();

CREATE FUNCTION scale_count_delta(owner_id uuid, tag text, feed text, n bigint, u bigint, s bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF n = 0 AND u = 0 AND s = 0 THEN RETURN; END IF;
  -- A user cascade may already have removed the owner and its counters. Never
  -- recreate or update children of a deleted owner: repeated same-transaction
  -- updates can recheck this FK during cascades. Live negative/missing buckets fail closed.
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=owner_id) THEN RETURN; END IF;
  UPDATE article_counts SET total=total+n, unread=unread+u, saved=saved+s
    WHERE user_id=owner_id AND tag_key=tag AND feed_key=feed;
  IF NOT FOUND THEN
    INSERT INTO article_counts(user_id,tag_key,feed_key,total,unread,saved)
      SELECT owner_id,tag,feed,n,u,s FROM users WHERE id=owner_id
      ON CONFLICT(user_id,tag_key,feed_key) DO UPDATE
        SET total=article_counts.total+EXCLUDED.total,
            unread=article_counts.unread+EXCLUDED.unread,
            saved=article_counts.saved+EXCLUDED.saved;
  END IF;
END $$;

CREATE FUNCTION scale_article_delta(a articles, tag text, direction integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Account/tag aggregate first, then feed slice: stable order across writers.
  PERFORM scale_count_delta(a.user_id,tag,'*',direction,
    direction * (NOT a.read)::integer,direction * a.saved::integer);
  PERFORM scale_count_delta(a.user_id,tag,COALESCE(a.feed_id::text,''),direction,
    direction * (NOT a.read)::integer,direction * a.saved::integer);
END $$;

CREATE FUNCTION scale_article_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- FK cascades run AFTER parent removal; remove memberships while the article
  -- still exists so their triggers can read its owner/feed/state exactly once.
  DELETE FROM article_tags WHERE article_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER scale_article_before_delete BEFORE DELETE ON articles
  FOR EACH ROW EXECUTE FUNCTION scale_article_before_delete();

CREATE FUNCTION scale_article_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tag text;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (OLD.user_id,OLD.feed_id,OLD.read,OLD.saved) IS NOT DISTINCT FROM
     (NEW.user_id,NEW.feed_id,NEW.read,NEW.saved) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.user_id <> NEW.user_id AND EXISTS (
    SELECT 1 FROM article_tags at JOIN tags t ON t.id=at.tag_id
    WHERE at.article_id=NEW.id AND t.user_id<>NEW.user_id
  ) THEN RAISE EXCEPTION 'Article tag owner mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM scale_article_delta(OLD,'',-1); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM scale_article_delta(NEW,'',1); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR tag IN SELECT tag_id::text FROM article_tags WHERE article_id=NEW.id ORDER BY tag_id LOOP
      PERFORM scale_article_delta(OLD,tag,-1);
      PERFORM scale_article_delta(NEW,tag,1);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scale_article_change AFTER INSERT OR UPDATE OR DELETE ON articles
  FOR EACH ROW EXECUTE FUNCTION scale_article_change();

CREATE FUNCTION scale_tag_membership_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a articles; owner_id uuid;
BEGIN
  -- Match state writers BEFORE changing membership. The AFTER delta below is
  -- essential: ON CONFLICT DO NOTHING must not increment a skipped insertion.
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO a FROM articles WHERE id=OLD.article_id FOR UPDATE;
    PERFORM 1 FROM article_counts WHERE user_id=a.user_id AND tag_key='' AND feed_key='*' FOR UPDATE;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO a FROM articles WHERE id=NEW.article_id FOR UPDATE;
    PERFORM 1 FROM article_counts WHERE user_id=a.user_id AND tag_key='' AND feed_key='*' FOR UPDATE;
    SELECT user_id INTO owner_id FROM tags WHERE id=NEW.tag_id;
    IF a.id IS NULL OR owner_id IS NULL OR owner_id<>a.user_id THEN
      RAISE EXCEPTION 'Article tag owner mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER scale_tag_membership_lock BEFORE INSERT OR UPDATE OR DELETE ON article_tags
  FOR EACH ROW EXECUTE FUNCTION scale_tag_membership_lock();

CREATE FUNCTION scale_tag_membership_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a articles;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO a FROM articles WHERE id=OLD.article_id;
    IF FOUND THEN PERFORM scale_article_delta(a,OLD.tag_id::text,-1); END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO a FROM articles WHERE id=NEW.article_id;
    PERFORM scale_article_delta(a,NEW.tag_id::text,1);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scale_tag_membership_delta AFTER INSERT OR UPDATE OR DELETE ON article_tags
  FOR EACH ROW EXECUTE FUNCTION scale_tag_membership_delta();

CREATE FUNCTION scale_tag_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM article_tags WHERE tag_id=OLD.id;
  DELETE FROM article_counts WHERE user_id=OLD.user_id AND tag_key=OLD.id::text;
  RETURN OLD;
END $$;
CREATE TRIGGER scale_tag_before_delete BEFORE DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION scale_tag_before_delete();

CREATE FUNCTION scale_feed_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM article_counts WHERE user_id=OLD.user_id AND feed_key=OLD.id::text;
  RETURN OLD;
END $$;
CREATE TRIGGER scale_feed_after_delete AFTER DELETE ON feeds
  FOR EACH ROW EXECUTE FUNCTION scale_feed_after_delete();

-- TRUNCATE is not application DML. Fail closed rather than silently discarding
-- counters; operator tooling must invalidate and rebuild before reopening reads.
CREATE FUNCTION scale_invalidate_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE article_count_state SET valid=false; RETURN NULL; END $$;
CREATE TRIGGER scale_articles_truncated AFTER TRUNCATE ON articles
  FOR EACH STATEMENT EXECUTE FUNCTION scale_invalidate_counts();
CREATE TRIGGER scale_memberships_truncated AFTER TRUNCATE ON article_tags
  FOR EACH STATEMENT EXECUTE FUNCTION scale_invalidate_counts();

-- Authoritative reconciliation intentionally scans the archive, never the hot
-- read path. GROUPING SETS produces both feed slices and account/tag aggregates.
CREATE VIEW article_counts_authoritative AS
SELECT user_id,tag_key,
  CASE WHEN grouping(feed_key)=1 THEN '*' ELSE feed_key END AS feed_key,
  count(*)::bigint AS total,
  count(*) FILTER (WHERE NOT read)::bigint AS unread,
  count(*) FILTER (WHERE saved)::bigint AS saved
FROM (
  SELECT a.user_id,''::text AS tag_key,COALESCE(a.feed_id::text,'') AS feed_key,a.read,a.saved FROM articles a
  UNION ALL
  SELECT a.user_id,t.id::text,COALESCE(a.feed_id::text,''),a.read,a.saved
    FROM articles a JOIN article_tags at ON at.article_id=a.id JOIN tags t ON t.id=at.tag_id AND t.user_id=a.user_id
) dimensions
GROUP BY GROUPING SETS ((user_id,tag_key,feed_key),(user_id,tag_key));

CREATE FUNCTION scale_rebuild_counts() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Call in a short operator-controlled maintenance window with bounded waits.
  LOCK TABLE users, feeds, subscriptions, tags, articles, article_tags, article_counts, article_count_state IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM article_tags at JOIN articles a ON a.id=at.article_id JOIN tags t ON t.id=at.tag_id WHERE a.user_id<>t.user_id) THEN
    RAISE EXCEPTION 'Article tag owner mismatch' USING ERRCODE='23514';
  END IF;
  DELETE FROM article_counts;
  INSERT INTO article_counts SELECT * FROM article_counts_authoritative;
  INSERT INTO article_count_state(user_id,valid) SELECT id,true FROM users
    ON CONFLICT(user_id) DO UPDATE SET valid=true;
END $$;

CREATE FUNCTION scale_audit_counts() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE drift bigint;
BEGIN
  -- Lock before reading both sides and invalidating, avoiding false positives
  -- from concurrent legitimate commits and racing rebuild/marker updates.
  LOCK TABLE users, feeds, subscriptions, tags, articles, article_tags, article_counts, article_count_state IN ACCESS EXCLUSIVE MODE;
  WITH mismatches AS (
    SELECT COALESCE(c.user_id,a.user_id) AS user_id FROM article_counts c
    FULL JOIN article_counts_authoritative a USING(user_id,tag_key,feed_key)
    WHERE (COALESCE(c.total,0),COALESCE(c.unread,0),COALESCE(c.saved,0)) IS DISTINCT FROM
          (COALESCE(a.total,0),COALESCE(a.unread,0),COALESCE(a.saved,0))
    UNION
    SELECT u.id FROM users u LEFT JOIN article_count_state s ON s.user_id=u.id WHERE s.user_id IS NULL OR NOT s.valid
    UNION
    SELECT a.user_id FROM article_tags at JOIN articles a ON a.id=at.article_id JOIN tags t ON t.id=at.tag_id WHERE a.user_id<>t.user_id
  ), invalidated AS (
    INSERT INTO article_count_state(user_id,valid) SELECT DISTINCT user_id,false FROM mismatches
    ON CONFLICT(user_id) DO UPDATE SET valid=false RETURNING user_id
  ) SELECT count(*) INTO drift FROM invalidated;
  RETURN drift;
END $$;

SELECT scale_rebuild_counts();

-- Tenant/feed keysets and state subsets; reverse membership supports tag lookup
-- and parent deletion. These add write cost; hosted plans/size budgets must verify.
CREATE INDEX articles_user_feed_date ON articles(user_id,feed_id,published_at,id);
CREATE INDEX articles_user_unread_date ON articles(user_id,published_at,id) WHERE NOT read;
CREATE INDEX articles_user_saved_date ON articles(user_id,published_at,id) WHERE saved;
CREATE INDEX article_tags_tag_article ON article_tags(tag_id,article_id);
CREATE INDEX images_pending_article ON images(article_id,id) WHERE status='pending';
CREATE INDEX images_file_key ON images(file_key) WHERE file_key IS NOT NULL;
CREATE INDEX ebooks_file_key ON ebooks(file_key) WHERE file_key IS NOT NULL;
CREATE INDEX feeds_icon_file_key ON feeds(icon_file_key) WHERE icon_file_key IS NOT NULL;
CREATE INDEX sessions_expiry ON sessions(expires_at);
