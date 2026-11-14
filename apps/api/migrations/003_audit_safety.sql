ALTER TABLE articles ADD COLUMN restored_at timestamptz;
ALTER TABLE images ADD COLUMN restored_at timestamptz;
ALTER TABLE feeds ADD COLUMN icon_file_key text;
ALTER TABLE feeds ADD COLUMN icon_original_url text;
ALTER TABLE ebooks ADD COLUMN delivery_state text NOT NULL DEFAULT 'not_sent'
  CHECK (delivery_state IN ('not_sent','sending','unknown','sent','not_delivered'));
UPDATE ebooks SET delivery_state = CASE
  WHEN sent_at IS NOT NULL THEN 'sent'
  WHEN error ILIKE '%outcome%unknown%' OR error ILIKE '%delivery interrupted%' THEN 'unknown'
  ELSE 'not_sent' END;
