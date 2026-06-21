-- D1 Database Schema for Stats Tracker
-- Run this in your D1 database before deploying the worker.
--   wrangler d1 execute 🔧 your-stats-db --file=src/schema.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,              -- Unix ms timestamp
  type TEXT NOT NULL,               -- 'pageview' | 'video_play' | 'video_progress' | 'video_complete' | 'contact_submit'
  page TEXT,                        -- URL path (e.g. '/about.html')
  video_id TEXT,                    -- Video filename or identifier
  video_pos INTEGER,                -- Playback position in seconds
  referrer_host TEXT,               -- Referring hostname (no protocol)
  country TEXT,                     -- ISO 2-letter country code
  region TEXT,                      -- Region/state code
  device TEXT,                      -- 'desktop' | 'mobile' | 'tablet' | 'unknown'
  session_hash TEXT NOT NULL,       -- Daily-rotating anonymous session ID (16 chars)
  domain TEXT                       -- The domain the event came from
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_hash);
CREATE INDEX IF NOT EXISTS idx_events_video ON events(video_id);
CREATE INDEX IF NOT EXISTS idx_events_page ON events(page);

-- Optional: contact form messages
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  page TEXT,
  referrer_host TEXT,
  country TEXT,
  region TEXT,
  device TEXT,
  domain TEXT,
  status TEXT DEFAULT 'new'         -- 'new' | 'read' | 'replied'
);

CREATE INDEX IF NOT EXISTS idx_contact_ts ON contact_messages(ts);

-- Optional: daily snapshots for historical comparison
CREATE TABLE IF NOT EXISTS daily_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,               -- 'YYYY-MM-DD'
  visitors INTEGER DEFAULT 0,
  pageviews INTEGER DEFAULT 0,
  video_plays INTEGER DEFAULT 0,
  video_completes INTEGER DEFAULT 0,
  total_watch_seconds INTEGER DEFAULT 0,
  contact_submits INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL       -- Unix ms
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_date ON daily_snapshots(date);
