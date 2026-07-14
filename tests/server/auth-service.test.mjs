import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppError } from '../../server/errors.js';
import { UsernameConflictError } from '../../server/repositories/errors.js';
import { createAuthService } from '../../server/services/auth-service.js';

const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dummy$safe';
const VALID_PASSWORD = 'correct horse battery';

function createDependencies(overrides = {}) {
  const calls = {
    create: [],
    findCredentials: [],
    findPublic: [],
    hash: [],
    verify: [],
  };
  const userRepository = {
    async create(value) {
      calls.create.push(value);
      return { id: '7', username: value.username, bestScore: 999, passwordHash: 'leak' };
    },
    async findCredentialsByUsername(username) {
      calls.findCredentials.push(username);
      return {
        id: '7',
        username,
        passwordHash: 'stored-hash',
        bestScore: 999,
      };
    },
    async findPublicById(id) {
      calls.findPublic.push(id);
      return { id, username: 'alice', bestScore: 999, passwordHash: 'leak' };
    },
    ...overrides.userRepository,
  };
  const passwordService = {
    async hash(password) {
      calls.hash.push(password);
      return 'new-password-hash';
    },
    async verify(hash, password) {
      calls.verify.push({ hash, password });
      return true;
    },
    ...overrides.passwordService,
  };

  return {
    calls,
    service: createAuthService({ userRepository, passwordService, dummyPasswordHash: DUMMY_HASH }),
  };
}

function publicErrorShape(error) {
  return {
    status: error.status,
    code: error.code,
    message: error.message,
  };
}

describe('Auth service', () => {
  test('返回冻结 API', () => {
    const { service } = createDependencies();

    assert.equal(Object.isFrozen(service), true);
    assert.deepEqual(Object.keys(service).sort(), ['findCurrentUser', 'login', 'register']);
  });

  test('注册先规范化/哈希，仓储不接收明文并显式投影冻结用户', async () => {
    const { calls, service } = createDependencies();
    const password = ` ${'x'.repeat(15)} `;

    const user = await service.register({ username: '  ALICE ', password });

    assert.deepEqual(calls.hash, [password]);
    assert.deepEqual(calls.create, [{ username: 'alice', passwordHash: 'new-password-hash' }]);
    assert.equal('password' in calls.create[0], false);
    assert.deepEqual(user, { id: '7', username: 'alice' });
    assert.equal(Object.isFrozen(user), true);
    assert.equal('passwordHash' in user, false);
    assert.equal('bestScore' in user, false);
  });

  test('只把 UsernameConflictError 映射成稳定 409，其余仓储错误原样抛出', async (t) => {
    await t.test('用户名冲突', async () => {
      const { service } = createDependencies({
        userRepository: {
          async create() {
            throw new UsernameConflictError();
          },
        },
      });

      await assert.rejects(
        service.register({ username: 'alice', password: VALID_PASSWORD }),
        (error) => {
          assert.equal(error instanceof AppError, true);
          assert.deepEqual(publicErrorShape(error), {
            status: 409,
            code: 'USERNAME_TAKEN',
            message: '用户名已被占用',
          });
          return true;
        },
      );
    });

    await t.test('其他错误', async () => {
      const expected = new Error('database-secret');
      const { service } = createDependencies({
        userRepository: {
          async create() {
            throw expected;
          },
        },
      });

      await assert.rejects(
        service.register({ username: 'alice', password: VALID_PASSWORD }),
        (error) => error === expected,
      );
    });
  });

  test('未知用户也验证 dummy hash，并与错误密码返回完全相同的 401', async () => {
    const unknown = createDependencies({
      userRepository: {
        async findCredentialsByUsername(username) {
          unknown.calls.findCredentials.push(username);
          return null;
        },
      },
    });
    let unknownError;
    await assert.rejects(
      unknown.service.login({ username: 'missing_user', password: VALID_PASSWORD }),
      (error) => {
        unknownError = error;
        return true;
      },
    );

    const wrong = createDependencies({
      passwordService: {
        async verify(hash, password) {
          wrong.calls.verify.push({ hash, password });
          return false;
        },
      },
    });
    let wrongError;
    await assert.rejects(
      wrong.service.login({ username: 'alice', password: VALID_PASSWORD }),
      (error) => {
        wrongError = error;
        return true;
      },
    );

    assert.deepEqual(unknown.calls.verify, [{ hash: DUMMY_HASH, password: VALID_PASSWORD }]);
    assert.deepEqual(wrong.calls.verify, [{ hash: 'stored-hash', password: VALID_PASSWORD }]);
    assert.deepEqual(publicErrorShape(unknownError), {
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: '用户名或密码错误',
    });
    assert.deepEqual(publicErrorShape(wrongError), publicErrorShape(unknownError));
  });

  test('格式或长度非法的结构化凭据不查仓储，仍验证 dummy hash 并返回统一 401', async () => {
    for (const body of [
      { username: 'bad-name', password: VALID_PASSWORD },
      { username: 'alice', password: 'too short' },
    ]) {
      const { calls, service } = createDependencies();

      await assert.rejects(service.login(body), (error) => {
        assert.deepEqual(publicErrorShape(error), {
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: '用户名或密码错误',
        });
        return true;
      });
      assert.deepEqual(calls.findCredentials, []);
      assert.deepEqual(calls.verify, [{ hash: DUMMY_HASH, password: body.password }]);
    }
  });

  test('正确凭据只返回冻结 id/username，verify 或仓储异常保持 500 路径', async (t) => {
    const { calls, service } = createDependencies();

    const user = await service.login({ username: ' ALICE ', password: VALID_PASSWORD });

    assert.deepEqual(calls.findCredentials, ['alice']);
    assert.deepEqual(calls.verify, [{ hash: 'stored-hash', password: VALID_PASSWORD }]);
    assert.deepEqual(user, { id: '7', username: 'alice' });
    assert.equal(Object.isFrozen(user), true);

    await t.test('verify 异常不映射为 401', async () => {
      const expected = new Error('argon2-internal');
      const failing = createDependencies({
        passwordService: {
          async verify() {
            throw expected;
          },
        },
      });
      await assert.rejects(
        failing.service.login({ username: 'alice', password: VALID_PASSWORD }),
        (error) => error === expected,
      );
    });
  });

  test('current 对不存在用户返回 null，对存在用户只投影 id/username', async () => {
    const missing = createDependencies({
      userRepository: {
        async findPublicById(id) {
          missing.calls.findPublic.push(id);
          return null;
        },
      },
    });
    assert.equal(await missing.service.findCurrentUser('999'), null);

    const existing = createDependencies();
    const user = await existing.service.findCurrentUser(7n);
    assert.deepEqual(existing.calls.findPublic, ['7']);
    assert.deepEqual(user, { id: '7', username: 'alice' });
    assert.equal(Object.isFrozen(user), true);
  });
});
