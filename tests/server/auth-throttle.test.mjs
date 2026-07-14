import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LOGIN_WINDOW_MS,
  REGISTRATION_WINDOW_MS,
  createAuthThrottle,
} from '../../server/security/auth-throttle.js';

function commitFailure(throttle, input) {
  const attempt = throttle.beginLoginAttempt(input);
  assert.equal(attempt.blocked, false);
  throttle.commitLoginFailure(attempt.reservation);
  return attempt;
}

function inspectAttempt(throttle, input) {
  const attempt = throttle.beginLoginAttempt(input);
  if (!attempt.blocked) {
    throttle.cancelLoginAttempt(attempt.reservation);
  }
  return attempt;
}

describe('认证限流器', () => {
  test('注册每 IP 每小时允许 5 次，第 6 次阻止且键隔离', () => {
    const throttle = createAuthThrottle({ now: () => 5_000 });

    assert.equal(Object.isFrozen(throttle), true);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(throttle.consumeRegistrationAttempt('203.0.113.1').blocked, false);
    }

    assert.deepEqual(throttle.consumeRegistrationAttempt('203.0.113.1'), {
      blocked: true,
      remaining: 0,
      retryAfterMs: REGISTRATION_WINDOW_MS,
    });
    assert.equal(throttle.consumeRegistrationAttempt('203.0.113.2').blocked, false);
  });

  test('登录用户名累计 5 次客户端失败后，第 6 次在处理前被阻止', () => {
    const throttle = createAuthThrottle({ now: () => 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      commitFailure(throttle, {
        ip: `198.51.100.${attempt}`,
        username: '  ALICE_1 ',
      });
    }

    const blocked = inspectAttempt(throttle, { ip: '198.51.100.99', username: 'alice_1' });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.ipBlocked, false);
    assert.equal(blocked.usernameBlocked, true);
    assert.equal(blocked.retryAfterMs, LOGIN_WINDOW_MS);
  });

  test('登录 IP 累计 10 次客户端失败后，第 11 次被阻止', () => {
    const throttle = createAuthThrottle({ now: () => 0 });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      commitFailure(throttle, { ip: '192.0.2.1', username: null });
    }

    const blocked = inspectAttempt(throttle, { ip: '192.0.2.1', username: null });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.ipBlocked, true);
    assert.equal(blocked.usernameBlocked, false);
  });

  test('登录开始时预留并发配额，取消只撤销本次、失败提交保留配额', () => {
    const throttle = createAuthThrottle({ now: () => 0 });
    const reservations = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = throttle.beginLoginAttempt({ ip: '192.0.2.1', username: 'alice' });
      assert.equal(started.blocked, false);
      reservations.push(started.reservation);
    }
    assert.equal(throttle.beginLoginAttempt({ ip: '192.0.2.1', username: 'alice' }).blocked, true);

    throttle.cancelLoginAttempt(reservations[0]);
    const replacement = throttle.beginLoginAttempt({ ip: '192.0.2.1', username: 'alice' });
    assert.equal(replacement.blocked, false);
    throttle.commitLoginFailure(replacement.reservation);
    throttle.cancelLoginAttempt(replacement.reservation);

    assert.equal(inspectAttempt(throttle, { ip: '192.0.2.1', username: 'alice' }).blocked, true);
  });

  test('混合并发中成功只清旧失败并保留其他 pending，后续失败仍从零累计到阈值', () => {
    const throttle = createAuthThrottle({ now: () => 0 });
    const attempts = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = throttle.beginLoginAttempt({ ip: '192.0.2.20', username: 'alice' });
      assert.equal(started.blocked, false);
      attempts.push(started.reservation);
    }

    throttle.recordLoginSuccess({ username: 'alice', reservation: attempts[0] });
    for (const reservation of attempts.slice(1)) {
      throttle.commitLoginFailure(reservation);
    }

    const fifthFailure = throttle.beginLoginAttempt({ ip: '192.0.2.20', username: 'alice' });
    assert.equal(fifthFailure.blocked, false);
    throttle.commitLoginFailure(fifthFailure.reservation);

    const sixthAttempt = throttle.beginLoginAttempt({ ip: '192.0.2.20', username: 'alice' });
    assert.equal(sixthAttempt.blocked, true);
    assert.equal(sixthAttempt.ipBlocked, false);
    assert.equal(sixthAttempt.usernameBlocked, true);
  });

  test('非法用户名不创建用户名键，成功只清用户名计数而保留 IP 失败', () => {
    const throttle = createAuthThrottle({ now: () => 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      commitFailure(throttle, { ip: `203.0.113.${attempt}`, username: 'bad-name' });
    }
    assert.equal(inspectAttempt(throttle, { ip: '203.0.113.50', username: 'bad-name' }).blocked, false);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      commitFailure(throttle, { ip: '192.0.2.10', username: 'alice' });
    }
    assert.equal(inspectAttempt(throttle, { ip: '192.0.2.10', username: 'alice' }).usernameBlocked, true);

    throttle.recordLoginSuccess({ username: ' ALICE ' });
    const afterSuccess = inspectAttempt(throttle, { ip: '192.0.2.10', username: 'alice' });
    assert.equal(afterSuccess.blocked, false);
    assert.equal(afterSuccess.usernameBlocked, false);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      commitFailure(throttle, { ip: '192.0.2.10', username: `other_${attempt}` });
    }
    throttle.recordLoginSuccess({ username: 'other_0' });
    const ipStillBlocked = inspectAttempt(throttle, { ip: '192.0.2.10', username: 'fresh_user' });
    assert.equal(ipStillBlocked.ipBlocked, true);
    assert.equal(ipStillBlocked.blocked, true);
  });

  test('双桶都阻止时采用较长 retryAfter，并在各自边界恢复', () => {
    let currentTime = 0;
    const throttle = createAuthThrottle({ now: () => currentTime });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      commitFailure(throttle, { ip: `198.51.100.${attempt}`, username: 'alice' });
    }

    currentTime = 100;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      commitFailure(throttle, { ip: '192.0.2.5', username: null });
    }

    currentTime = 200;
    const blocked = inspectAttempt(throttle, { ip: '192.0.2.5', username: 'alice' });
    assert.equal(blocked.ipBlocked, true);
    assert.equal(blocked.usernameBlocked, true);
    assert.equal(blocked.retryAfterMs, LOGIN_WINDOW_MS - 100);

    currentTime = LOGIN_WINDOW_MS;
    const oneExpired = inspectAttempt(throttle, { ip: '192.0.2.5', username: 'alice' });
    assert.equal(oneExpired.usernameBlocked, false);
    assert.equal(oneExpired.ipBlocked, true);
    assert.equal(oneExpired.retryAfterMs, 100);

    currentTime = LOGIN_WINDOW_MS + 100;
    assert.equal(inspectAttempt(throttle, { ip: '192.0.2.5', username: 'alice' }).blocked, false);
  });

  test('只公开原子预留式登录 API，不暴露 check 与 record 的竞态组合', () => {
    assert.deepEqual(Object.keys(createAuthThrottle()), [
      'consumeRegistrationAttempt',
      'beginLoginAttempt',
      'commitLoginFailure',
      'cancelLoginAttempt',
      'recordLoginSuccess',
    ]);
  });
});
