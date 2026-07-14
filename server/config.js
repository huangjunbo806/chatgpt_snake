import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const PURE_HTTP_ORIGIN_PATTERN = /^https?:\/\/[^/?#\\\s]+\/?$/iu;

function parseInteger(value, { name, defaultValue, min, max }) {
  const rawValue = value ?? String(defaultValue);
  const text = typeof rawValue === 'string' ? rawValue : String(rawValue);

  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }

  return parsed;
}

function validateDatabaseUrl(value) {
  let databaseUrl;

  try {
    databaseUrl = new URL(value);
  } catch {
    throw new Error('DATABASE_URL 必须是带主机的 postgres 或 postgresql URL');
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) {
    throw new Error('DATABASE_URL 必须是带主机的 postgres 或 postgresql URL');
  }
}

function parsePublicOrigin(value, nodeEnv) {
  const rawOrigin = typeof value === 'string' ? value.trim() : '';
  let publicUrl;

  if (!PURE_HTTP_ORIGIN_PATTERN.test(rawOrigin)) {
    throw new Error('PUBLIC_ORIGIN 必须是仅包含 origin 的 http 或 https URL');
  }

  try {
    publicUrl = new URL(rawOrigin);
  } catch {
    throw new Error('PUBLIC_ORIGIN 必须是仅包含 origin 的 http 或 https URL');
  }

  const isHttp = publicUrl.protocol === 'http:' || publicUrl.protocol === 'https:';
  const hasOnlyOrigin = publicUrl.pathname === '/'
    && !publicUrl.search
    && !publicUrl.hash
    && !publicUrl.username
    && !publicUrl.password
    && !rawOrigin.includes('?')
    && !rawOrigin.includes('#');

  if (!isHttp || !publicUrl.hostname || !hasOnlyOrigin) {
    throw new Error('PUBLIC_ORIGIN 必须是仅包含 origin 的 http 或 https URL');
  }

  if (nodeEnv === 'production' && publicUrl.protocol !== 'https:') {
    throw new Error('production 环境的 PUBLIC_ORIGIN 必须使用 HTTPS');
  }

  return publicUrl.origin;
}

export function loadConfig(env = process.env, { rootDir } = {}) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!NODE_ENVIRONMENTS.has(nodeEnv)) {
    throw new Error('NODE_ENV 必须是 development、test 或 production');
  }

  const port = parseInteger(env.PORT, {
    name: 'PORT',
    defaultValue: 3000,
    min: 1,
    max: 65535,
  });

  const host = (env.HOST ?? '0.0.0.0').trim();
  if (!host) {
    throw new Error('HOST 不能为空');
  }

  const databaseUrl = env.DATABASE_URL;
  validateDatabaseUrl(databaseUrl);

  const sessionSecret = env.SESSION_SECRET;
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET 必须至少包含 32 个 UTF-8 字节');
  }

  const publicOrigin = parsePublicOrigin(env.PUBLIC_ORIGIN, nodeEnv);
  const trustProxy = parseInteger(env.TRUST_PROXY, {
    name: 'TRUST_PROXY',
    defaultValue: 0,
    min: 0,
    max: 10,
  });
  const staticDirectory = nodeEnv === 'production' ? 'dist' : 'client';
  const staticRoot = path.resolve(rootDir ?? PROJECT_ROOT, staticDirectory);

  return Object.freeze({
    nodeEnv,
    port,
    host,
    databaseUrl,
    sessionSecret,
    publicOrigin,
    trustProxy,
    staticRoot,
  });
}
