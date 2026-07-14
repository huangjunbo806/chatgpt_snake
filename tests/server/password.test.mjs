import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createPasswordService } from '../../server/auth/password.js';

describe('Argon2id 密码服务', () => {
  test('固定 Argon2id 参数、同一密码使用不同 salt 且能验证真伪和 Unicode', async () => {
    const service = createPasswordService();
    const password = '空 格😀password-123';

    const firstHash = await service.hash(password);
    const secondHash = await service.hash(password);

    assert.equal(Object.isFrozen(service), true);
    assert.match(firstHash, /^\$argon2id\$/u);
    assert.match(firstHash, /\$m=19456,t=2,p=1\$/u);
    assert.notEqual(firstHash, secondHash);
    assert.equal(await service.verify(firstHash, password), true);
    assert.equal(await service.verify(firstHash, `${password}!`), false);
  });

  test('把完整原始字符串交给实现，不截断或 trim', async () => {
    const calls = [];
    const argon2Impl = {
      argon2id: Symbol('argon2id'),
      async hash(password, options) {
        calls.push({ method: 'hash', password, options });
        return 'encoded-hash';
      },
      async verify(hash, password) {
        calls.push({ method: 'verify', hash, password });
        return true;
      },
    };
    const service = createPasswordService({ argon2Impl });
    const original = `  ${'😀'.repeat(130)}  `;

    assert.equal(await service.hash(original), 'encoded-hash');
    assert.equal(await service.verify('encoded-hash', original), true);
    assert.deepEqual(calls, [
      {
        method: 'hash',
        password: original,
        options: {
          type: argon2Impl.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        },
      },
      { method: 'verify', hash: 'encoded-hash', password: original },
    ]);
  });
});
