function toIsoTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toStanding(row) {
  return Object.freeze({
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    username: row.username,
    bestScore: Number(row.best_score),
    bestScoreAt: toIsoTimestamp(row.best_score_at),
  });
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit 必须是 1 到 100 的整数');
  }
}

export function createLeaderboardRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createLeaderboardRepository 需要可查询的 pool');
  }

  async function raiseBestScore({ userId, score }) {
    const result = await pool.query(
      `
        UPDATE public.users
        SET best_score = $2,
            best_score_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND best_score < $2
        RETURNING id
      `,
      [userId, score],
    );

    return result.rowCount === 1;
  }

  async function findTop({ limit = 100 } = {}) {
    validateLimit(limit);
    const result = await pool.query(
      `
        WITH ranked AS (
          SELECT
            id,
            username,
            best_score,
            best_score_at,
            ROW_NUMBER() OVER (
              ORDER BY best_score DESC, best_score_at ASC, id ASC
            ) AS rank
          FROM public.users
          WHERE best_score > 0
        )
        SELECT rank, username, best_score, best_score_at
        FROM ranked
        ORDER BY best_score DESC, best_score_at ASC, id ASC
        LIMIT $1
      `,
      [limit],
    );

    return Object.freeze(result.rows.map(toStanding));
  }

  async function findUserStandingById(userId) {
    const result = await pool.query(
      `
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              ORDER BY best_score DESC, best_score_at ASC, id ASC
            ) AS rank
          FROM public.users
          WHERE best_score > 0
        )
        SELECT
          ranked.rank,
          users.username,
          users.best_score,
          users.best_score_at
        FROM public.users AS users
        LEFT JOIN ranked ON ranked.id = users.id
        WHERE users.id = $1
      `,
      [userId],
    );

    return result.rows[0] ? toStanding(result.rows[0]) : null;
  }

  return Object.freeze({
    raiseBestScore,
    findTop,
    findUserStandingById,
  });
}
