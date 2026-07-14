import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppError } from '../../server/errors.js';
import { requireAuth } from '../../server/middleware/require-auth.js';

function invoke(req) {
  let nextValue = Symbol('not-called');
  requireAuth(req, {}, (value) => {
    nextValue = value;
  });
  return nextValue;
}

describe('requireAuth', () => {
  test('游客返回稳定 401，且不创建、修改或保存 Session', () => {
    for (const req of [{}, { session: {} }, { session: { userId: '' } }]) {
      const before = req.session ? { ...req.session } : undefined;
      const result = invoke(req);

      assert.equal(result instanceof AppError, true);
      assert.equal(result.status, 401);
      assert.equal(result.code, 'AUTH_REQUIRED');
      assert.equal(result.message, '请先登录');
      assert.deepEqual(req.session, before);
    }
  });

  test('已登录用户把 userId 规范成字符串后继续', () => {
    const req = { session: { userId: 42n } };

    assert.equal(invoke(req), undefined);
    assert.equal(req.session.userId, '42');
  });
});
