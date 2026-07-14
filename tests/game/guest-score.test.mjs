import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_SCORE } from '../../client/scripts/game-engine.js';
import {
  GUEST_SCORE_KEY,
  createGuestScoreStore,
} from '../../client/scripts/guest-score.js';

function createStorage(...initialValues) {
  let value = initialValues.length === 0 ? null : initialValues[0];
  const calls = {
    getItem: [],
    setItem: [],
  };
  const storage = {
    getItem(key) {
      calls.getItem.push(key);
      return value;
    },
    setItem(key, nextValue) {
      calls.setItem.push([key, nextValue]);
      value = nextValue;
    },
  };

  return { calls, storage };
}

describe('游客最高分存储', () => {
  test('使用固定 key，只暴露冻结的读写方法，并且只写入更高分', () => {
    const { calls, storage } = createStorage('120');
    const store = createGuestScoreStore(storage);

    assert.equal(GUEST_SCORE_KEY, 'docker-snake.guest-best-score.v1');
    assert.equal(Object.isFrozen(store), true);
    assert.deepEqual(Reflect.ownKeys(store), ['getBestScore', 'recordScore']);
    assert.equal(typeof store.getBestScore, 'function');
    assert.equal(typeof store.recordScore, 'function');

    assert.equal(store.getBestScore(), 120);
    assert.equal(store.recordScore(100), 120);
    assert.equal(store.recordScore(120), 120);
    assert.equal(store.recordScore(180), 180);
    assert.deepEqual(calls.getItem, Array(4).fill(GUEST_SCORE_KEY));
    assert.deepEqual(calls.setItem, [[GUEST_SCORE_KEY, '180']]);
  });

  test('非法、缺失或转换失败的存储内容都安全视为零', () => {
    const conversionError = {
      [Symbol.toPrimitive]() {
        throw new TypeError('cannot convert');
      },
    };
    const cases = [
      ['非数字字符串', 'not-a-number'],
      ['负数', '-10'],
      ['非十的倍数', '17'],
      ['超过上限', '3970'],
      ['小数', '20.5'],
      ['Infinity 字符串', 'Infinity'],
      ['NaN 字符串', 'NaN'],
      ['Infinity 数值', Number.POSITIVE_INFINITY],
      ['NaN 数值', Number.NaN],
      ['null', null],
      ['undefined', undefined],
      ['转换抛错', conversionError],
    ];

    for (const [label, value] of cases) {
      const { storage } = createStorage(value);
      assert.equal(createGuestScoreStore(storage).getBestScore(), 0, label);
    }
  });

  test('recordScore 拒绝非 number 与所有非法分数，接受合法边界', () => {
    const { calls, storage } = createStorage();
    const store = createGuestScoreStore(storage);
    const invalidScores = [
      '80',
      41,
      -10,
      MAX_SCORE + 10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      20.5,
      null,
      undefined,
    ];

    for (const score of invalidScores) {
      assert.equal(store.recordScore(score), 0);
    }
    assert.equal(store.recordScore(0), 0);
    assert.deepEqual(calls.setItem, []);

    assert.equal(store.recordScore(MAX_SCORE), MAX_SCORE);
    assert.deepEqual(calls.setItem, [[GUEST_SCORE_KEY, String(MAX_SCORE)]]);
  });

  test('recordScore 即使收到非法分数也先读取外部最高分', () => {
    const { calls, storage } = createStorage('120');
    const store = createGuestScoreStore(storage);

    assert.equal(store.recordScore('80'), 120);
    assert.deepEqual(calls.getItem, [GUEST_SCORE_KEY]);
    assert.deepEqual(calls.setItem, []);
  });

  test('getItem 方法或属性访问抛错时仍可使用页面内存', () => {
    const methodThrows = {
      getItem() {
        throw new Error('read failed');
      },
      setItem() {},
    };
    const propertyThrows = {
      setItem() {},
    };
    Object.defineProperty(propertyThrows, 'getItem', {
      get() {
        throw new Error('getItem unavailable');
      },
    });

    for (const storage of [methodThrows, propertyThrows]) {
      const store = createGuestScoreStore(storage);
      assert.equal(store.getBestScore(), 0);
      assert.equal(store.recordScore(80), 80);
      assert.equal(store.getBestScore(), 80);
    }
  });

  test('setItem 写入或属性访问抛错时保留内存最高分', () => {
    for (const makeStorage of [
      () => ({
        getItem() {
          return null;
        },
        setItem() {
          throw new Error('write failed');
        },
      }),
      () => {
        const storage = {
          getItem() {
            return null;
          },
        };
        Object.defineProperty(storage, 'setItem', {
          get() {
            throw new Error('setItem unavailable');
          },
        });
        return storage;
      },
    ]) {
      const store = createGuestScoreStore(makeStorage());
      assert.equal(store.recordScore(80), 80);
      assert.equal(store.getBestScore(), 80);
    }
  });

  test('写失败后不被较低外部值降低，并可吸收更高合法值', () => {
    let storedValue = null;
    const setCalls = [];
    const storage = {
      getItem(key) {
        assert.equal(key, GUEST_SCORE_KEY);
        return storedValue;
      },
      setItem(key, value) {
        setCalls.push([key, value]);
        throw new Error('quota exceeded');
      },
    };
    const store = createGuestScoreStore(storage);

    assert.equal(store.recordScore(80), 80);
    assert.deepEqual(setCalls, [[GUEST_SCORE_KEY, '80']]);

    storedValue = '40';
    assert.equal(store.getBestScore(), 80);

    storedValue = '120';
    assert.equal(store.getBestScore(), 120);

    storedValue = '100';
    assert.equal(store.getBestScore(), 120);
  });

  test('非法外部内容不清理且不降低已知内存最高分', () => {
    let storedValue = null;
    const clearCalls = [];
    const removeCalls = [];
    const setCalls = [];
    const storage = {
      getItem(key) {
        assert.equal(key, GUEST_SCORE_KEY);
        return storedValue;
      },
      setItem(key, value) {
        setCalls.push([key, value]);
        storedValue = value;
      },
      removeItem(key) {
        removeCalls.push(key);
        storedValue = null;
      },
      clear() {
        clearCalls.push([]);
        storedValue = null;
      },
    };
    const store = createGuestScoreStore(storage);

    assert.equal(store.recordScore(80), 80);
    assert.deepEqual(setCalls, [[GUEST_SCORE_KEY, '80']]);
    setCalls.length = 0;
    storedValue = 'not-a-number';
    assert.equal(store.getBestScore(), 80);
    assert.deepEqual(setCalls, []);
    assert.deepEqual(removeCalls, []);
    assert.deepEqual(clearCalls, []);
  });

  test('storage 为 null 或缺少方法时不影响游戏', () => {
    for (const storage of [null, {}]) {
      const store = createGuestScoreStore(storage);
      assert.equal(store.getBestScore(), 0);
      assert.equal(store.recordScore(80), 80);
      assert.equal(store.getBestScore(), 80);
    }
  });

  test('默认 localStorage getter 抛错时回退页面内存并恢复全局描述符', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    );

    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          const error = new Error('access denied');
          error.name = 'SecurityError';
          throw error;
        },
      });

      const store = createGuestScoreStore();
      assert.equal(store.getBestScore(), 0);
      assert.equal(store.recordScore(80), 80);
      assert.equal(store.getBestScore(), 80);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
      } else {
        delete globalThis.localStorage;
      }
    }
  });
});
