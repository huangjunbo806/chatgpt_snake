import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const START_FILE = path.join(PROJECT_ROOT, 'server', 'start.js');
const START_URL = pathToFileURL(START_FILE).href;

function environmentWithoutAppConfig() {
  const {
    DATABASE_URL,
    HOST,
    NODE_ENV,
    PORT,
    PUBLIC_ORIGIN,
    SESSION_SECRET,
    TRUST_PROXY,
    ...environment
  } = process.env;
  return environment;
}

async function withPoisonedDotEnv(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'docker-snake-cli-'));
  await writeFile(
    path.join(directory, '.env'),
    [
      'NODE_ENV=invalid-cli-secret',
      'DATABASE_URL=postgresql://snake:database-secret@127.0.0.1:1/snake',
      'SESSION_SECRET=session-secret-that-is-long-enough-123456789',
      'PUBLIC_ORIGIN=http://127.0.0.1:3000',
    ].join('\n'),
    'utf8',
  );

  try {
    return run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('server/start.js CLI 边界', () => {
  test('作为模块导入时不读取 .env、不启动服务且没有输出', async () => {
    await withPoisonedDotEnv((cwd) => {
      const script = [
        `await import(${JSON.stringify(START_URL)});`,
        "process.stdout.write(process.env.NODE_ENV ?? 'unset');",
      ].join('\n');
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          cwd,
          encoding: 'utf8',
          env: environmentWithoutAppConfig(),
          timeout: 3_000,
        },
      );

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'unset');
      assert.equal(result.stderr, '');
    });
  });

  test('直接执行时才加载 .env，失败只输出脱敏事件并设置非零退出码', async () => {
    await withPoisonedDotEnv((cwd) => {
      const result = spawnSync(process.execPath, [START_FILE], {
        cwd,
        encoding: 'utf8',
        env: environmentWithoutAppConfig(),
        timeout: 3_000,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /server_start_failed/u);
      assert.doesNotMatch(
        result.stderr,
        /invalid-cli-secret|database-secret|session-secret|postgresql/iu,
      );
    });
  });
});
