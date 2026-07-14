import { UsernameConflictError } from './errors.js';

function toBestScoreAt(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toPublicUser(row) {
  return Object.freeze({
    id: String(row.id),
    username: row.username,
    bestScore: Number(row.best_score),
    bestScoreAt: toBestScoreAt(row.best_score_at),
  });
}

function toCredentials(row) {
  return Object.freeze({
    ...toPublicUser(row),
    passwordHash: row.password_hash,
  });
}

export function createUserRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createUserRepository 需要可查询的 pool');
  }

  async function create({ username, passwordHash }) {
    let result;

    try {
      result = await pool.query(
        `
          INSERT INTO users (username, password_hash)
          VALUES ($1, $2)
          RETURNING id, username, best_score, best_score_at
        `,
        [username, passwordHash],
      );
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'users_username_unique') {
        throw new UsernameConflictError();
      }
      throw error;
    }

    return toPublicUser(result.rows[0]);
  }

  async function findCredentialsByUsername(username) {
    const result = await pool.query(
      `
        SELECT id, username, password_hash, best_score, best_score_at
        FROM users
        WHERE username = $1
      `,
      [username],
    );

    return result.rows[0] ? toCredentials(result.rows[0]) : null;
  }

  async function findPublicById(id) {
    const result = await pool.query(
      `
        SELECT id, username, best_score, best_score_at
        FROM users
        WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  return Object.freeze({
    create,
    findCredentialsByUsername,
    findPublicById,
  });
}
