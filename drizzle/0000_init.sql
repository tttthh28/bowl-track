-- Bowl Track schema（隔離於 DreamFinder public.*）
CREATE SCHEMA IF NOT EXISTS bowl_track;

CREATE TABLE IF NOT EXISTS bowl_track.users (
  id text PRIMARY KEY NOT NULL,
  email text NOT NULL UNIQUE,
  name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS bowl_track.bowling_sessions (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES bowl_track.users(id) ON DELETE cascade,
  name text NOT NULL,
  corners jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS bowling_sessions_user_idx ON bowl_track.bowling_sessions (user_id);

CREATE TABLE IF NOT EXISTS bowl_track.shots (
  id text PRIMARY KEY NOT NULL,
  session_id text NOT NULL REFERENCES bowl_track.bowling_sessions(id) ON DELETE cascade,
  created_at bigint NOT NULL,
  points jsonb NOT NULL,
  estimate jsonb NOT NULL,
  source text NOT NULL
);

CREATE INDEX IF NOT EXISTS shots_session_idx ON bowl_track.shots (session_id);
