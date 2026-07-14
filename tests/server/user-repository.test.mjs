import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UsernameConflictError } from '../../server/repositories/errors.js';
import { createUserRepository } from '../../server/repositories/user-repository.js';

function createRecordingPool(responses = []) {
  const pending = [...responses];
  const calls = [];

  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const response = pending.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response ?? { rows: [] };
    },
  };
}

function assertValuesOnly(call, sensitiveValues) {
  for (const value of sensitiveValues) {
    assert.equal(call.text.includes(value), false);
  }
  assert.deepEqual(call.values, sensitiveValues);
}

describe('createUserRepository', () => {
  test('返回冻结 API 并拒绝缺失的 pool', () => {
    const repository = createUserRepository({ pool: createRecordingPool() });

    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(Object.keys(repository).sort(), [
      'create',
      'findCredentialsByUsername',
      'findPublicById',
    ]);
    assert.throws(() => createUserRepository(), /createUserRepository.*pool/u);
  });

  test('create 参数化写入并返回不含 hash 的冻结公开用户', async () => {
    const username = "evil_user'); DROP TABLE users; --";
    const passwordHash = "hash'); SELECT pg_sleep(10); --";
    const bestScoreAt = new Date('2026-07-14T02:03:04.567Z');
    const pool = createRecordingPool([{
      rows: [{
        id: 42n,
        username,
        best_score: '120',
        best_score_at: bestScoreAt,
      }],
    }]);
    const repository = createUserRepository({ pool });

    const user = await repository.create({ username, passwordHash });

    assert.deepEqual(user, {
      id: '42',
      username,
      bestScore: 120,
      bestScoreAt: '2026-07-14T02:03:04.567Z',
    });
    assert.equal(Object.isFrozen(user), true);
    assert.equal('passwordHash' in user, false);
    assert.match(pool.calls[0].text, /^\s*INSERT\s+INTO\s+public\.users/iu);
    assert.match(pool.calls[0].text, /RETURNING/iu);
    assertValuesOnly(pool.calls[0], [username, passwordHash]);
  });

  test('findCredentialsByUsername 参数化查询并返回含 hash 的冻结凭据', async () => {
    const username = "alice' OR TRUE --";
    const passwordHash = '$argon2id$v=19$credential-secret';
    const pool = createRecordingPool([{
      rows: [{
        id: '9007199254740993',
        username,
        password_hash: passwordHash,
        best_score: 0,
        best_score_at: null,
      }],
    }]);
    const repository = createUserRepository({ pool });

    const credentials = await repository.findCredentialsByUsername(username);

    assert.deepEqual(credentials, {
      id: '9007199254740993',
      username,
      bestScore: 0,
      bestScoreAt: null,
      passwordHash,
    });
    assert.equal(Object.isFrozen(credentials), true);
    assert.match(pool.calls[0].text, /^\s*SELECT/iu);
    assert.match(pool.calls[0].text, /password_hash/iu);
    assert.match(pool.calls[0].text, /FROM\s+public\.users/iu);
    assertValuesOnly(pool.calls[0], [username]);
  });

  test('findPublicById 参数化查询并返回公开用户', async () => {
    const id = "1' UNION SELECT password_hash FROM users --";
    const pool = createRecordingPool([{
      rows: [{
        id: 7,
        username: 'snake_7',
        best_score: 3960,
        best_score_at: '2026-07-14T10:00:00.000Z',
      }],
    }]);
    const repository = createUserRepository({ pool });

    const user = await repository.findPublicById(id);

    assert.deepEqual(user, {
      id: '7',
      username: 'snake_7',
      bestScore: 3960,
      bestScoreAt: '2026-07-14T10:00:00.000Z',
    });
    assert.equal('passwordHash' in user, false);
    assert.doesNotMatch(pool.calls[0].text, /password_hash/iu);
    assert.match(pool.calls[0].text, /FROM\s+public\.users/iu);
    assertValuesOnly(pool.calls[0], [id]);
  });

  test('两个查找 API 在用户不存在时都返回 null', async () => {
    const pool = createRecordingPool([{ rows: [] }, { rows: [] }]);
    const repository = createUserRepository({ pool });

    assert.equal(await repository.findCredentialsByUsername('missing_user'), null);
    assert.equal(await repository.findPublicById('999'), null);
  });

  test('create 只精确映射指定唯一约束冲突', async (t) => {
    await t.test('匹配 23505 与 users_username_unique', async () => {
      const databaseError = Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'users_username_unique',
      });
      const repository = createUserRepository({
        pool: createRecordingPool([databaseError]),
      });

      await assert.rejects(
        repository.create({ username: 'alice', passwordHash: 'hash' }),
        UsernameConflictError,
      );
    });

    for (const properties of [
      { code: '23503', constraint: 'users_username_unique' },
      { code: '23505', constraint: 'another_unique_constraint' },
    ]) {
      await t.test(`原样抛出 ${properties.code}/${properties.constraint}`, async () => {
        const databaseError = Object.assign(new Error('original database error'), properties);
        const repository = createUserRepository({
          pool: createRecordingPool([databaseError]),
        });

        await assert.rejects(
          repository.create({ username: 'alice', passwordHash: 'hash' }),
          (error) => error === databaseError,
        );
      });
    }
  });
});
