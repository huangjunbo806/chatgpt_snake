import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  normalizeUsername,
  normalizeUsernameCandidate,
  parseLoginInput,
  parseRegistrationInput,
} from '../../server/auth/auth-validation.js';
import { AppError } from '../../server/errors.js';

function assertInvalidInput(run) {
  assert.throws(run, (error) => {
    assert.equal(error instanceof AppError, true);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /[\u3400-\u9fff]/u);
    return true;
  });
}

describe('认证输入校验', () => {
  test('用户名先 trim/lowercase，再接受 3 到 20 个 ASCII 字母数字或下划线', () => {
    assert.equal(normalizeUsername('  AbC_123  '), 'abc_123');
    assert.equal(normalizeUsername('abc'), 'abc');
    assert.equal(normalizeUsername('a'.repeat(20)), 'a'.repeat(20));

    for (const value of ['ab', 'a'.repeat(21), 'abc-def', '用户123', 123, null]) {
      assertInvalidInput(() => normalizeUsername(value));
    }
  });

  test('候选用户名函数不抛异常，合法时规范化、非法时返回 null', () => {
    assert.equal(normalizeUsernameCandidate('  Alice_1 '), 'alice_1');
    for (const value of ['ab', 'bad-name', '', undefined, {}, Symbol('name')]) {
      assert.equal(normalizeUsernameCandidate(value), null);
    }
  });

  test('注册只接受恰含 username/password 自有键的普通对象', () => {
    const parsed = parseRegistrationInput({
      username: '  Alice_1 ',
      password: ' 1234567890123 ',
    });

    assert.deepEqual(parsed, {
      username: 'alice_1',
      password: ' 1234567890123 ',
    });
    assert.equal(Object.isFrozen(parsed), true);

    for (const body of [
      null,
      [],
      'json',
      new Date(),
      { username: 'alice_1' },
      { password: '123456789012345' },
      { username: 'alice_1', password: '123456789012345', confirmPassword: '123456789012345' },
      Object.assign(Object.create({ inherited: true }), {
        username: 'alice_1',
        password: '123456789012345',
      }),
    ]) {
      assertInvalidInput(() => parseRegistrationInput(body));
    }
  });

  test('密码保留原始内容，并按 Unicode code point 接受 15 到 128 个字符', () => {
    assert.equal(parseRegistrationInput({
      username: 'alice',
      password: '😀'.repeat(15),
    }).password, '😀'.repeat(15));
    assert.equal(parseRegistrationInput({
      username: 'alice',
      password: '界'.repeat(128),
    }).password, '界'.repeat(128));

    for (const password of [
      '😀'.repeat(14),
      '界'.repeat(129),
      123456789012345,
    ]) {
      assertInvalidInput(() => parseRegistrationInput({ username: 'alice', password }));
    }
  });

  test('登录结构错误为 400，结构合法但凭据格式错误返回统一 invalid 结果', () => {
    for (const body of [
      null,
      [],
      { username: 'alice' },
      { password: '123456789012345' },
      { username: 'alice', password: '123456789012345', extra: true },
      { username: 7, password: '123456789012345' },
      { username: 'alice', password: new String('123456789012345') },
    ]) {
      assertInvalidInput(() => parseLoginInput(body));
    }

    const valid = parseLoginInput({
      username: '  ALIce_1 ',
      password: ' 1234567890123 ',
    });
    assert.deepEqual(valid, {
      valid: true,
      username: 'alice_1',
      password: ' 1234567890123 ',
    });
    assert.equal(Object.isFrozen(valid), true);

    for (const body of [
      { username: 'ab', password: '123456789012345' },
      { username: 'alice', password: 'short' },
      { username: 'bad-name', password: '123456789012345' },
      { username: 'alice', password: '😀'.repeat(129) },
    ]) {
      const parsed = parseLoginInput(body);
      assert.equal(parsed.valid, false);
      assert.equal(Object.isFrozen(parsed), true);
    }
  });
});
