CREATE TABLE users (
  id bigserial PRIMARY KEY,
  username varchar(20) NOT NULL,
  password_hash text NOT NULL,
  best_score integer NOT NULL DEFAULT 0,
  best_score_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_username_unique UNIQUE (username),
  CONSTRAINT users_username_format_check
    CHECK (username ~ '^[a-z0-9_]{3,20}$'),
  CONSTRAINT users_best_score_check
    CHECK (best_score BETWEEN 0 AND 3960 AND best_score % 10 = 0),
  CONSTRAINT users_best_score_time_check
    CHECK (
      (best_score = 0 AND best_score_at IS NULL)
      OR (best_score > 0 AND best_score_at IS NOT NULL)
    )
);

CREATE INDEX users_leaderboard_order_idx
  ON users (best_score DESC, best_score_at ASC, id ASC)
  WHERE best_score > 0;

CREATE TABLE user_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX user_sessions_expire_idx
  ON user_sessions (expire);
