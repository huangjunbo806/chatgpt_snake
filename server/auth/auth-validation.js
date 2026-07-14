import { AppError } from '../errors.js';

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/u;
const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_LENGTH = 128;

function invalidInput(message = '输入内容不符合要求') {
  return new AppError({
    status: 400,
    code: 'INVALID_INPUT',
    message,
  });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactCredentialsKeys(body) {
  if (!isPlainObject(body)) {
    return false;
  }

  const keys = Reflect.ownKeys(body);
  return keys.length === 2
    && keys.includes('username')
    && keys.includes('password');
}

function isValidPassword(password) {
  if (typeof password !== 'string') {
    return false;
  }

  const length = [...password].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

export function normalizeUsernameCandidate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeUsername(value) {
  const normalized = normalizeUsernameCandidate(value);
  if (normalized === null) {
    throw invalidInput('用户名格式不正确');
  }
  return normalized;
}

export function parseRegistrationInput(body) {
  if (!hasExactCredentialsKeys(body)) {
    throw invalidInput('注册信息格式不正确');
  }

  const username = normalizeUsername(body.username);
  if (!isValidPassword(body.password)) {
    throw invalidInput('密码长度必须为 15 到 128 个字符');
  }

  return Object.freeze({
    username,
    password: body.password,
  });
}

export function parseLoginInput(body) {
  if (!hasExactCredentialsKeys(body)
    || typeof body.username !== 'string'
    || typeof body.password !== 'string') {
    throw invalidInput('登录信息格式不正确');
  }

  const username = normalizeUsernameCandidate(body.username);
  const valid = username !== null && isValidPassword(body.password);

  return Object.freeze({
    valid,
    username,
    password: body.password,
  });
}
