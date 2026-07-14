import { MAX_SCORE, SCORE_PER_FOOD } from './game-engine.js';

export const GUEST_SCORE_KEY = 'docker-snake.guest-best-score.v1';

function findBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isValidScore(score) {
  return (
    typeof score === 'number' &&
    Number.isInteger(score) &&
    score >= 0 &&
    score <= MAX_SCORE &&
    score % SCORE_PER_FOOD === 0
  );
}

export function createGuestScoreStore(storage = findBrowserStorage()) {
  let memoryBestScore = 0;

  function getBestScore() {
    try {
      const rawScore = storage.getItem(GUEST_SCORE_KEY);

      if (rawScore !== null) {
        const storedScore = Number(rawScore);

        if (isValidScore(storedScore) && storedScore > memoryBestScore) {
          memoryBestScore = storedScore;
        }
      }
    } catch {
      // 浏览器可能拒绝访问存储；页面内存仍可继续工作。
    }

    return memoryBestScore;
  }

  function recordScore(score) {
    const bestScore = getBestScore();

    if (!isValidScore(score) || score <= bestScore) {
      return bestScore;
    }

    memoryBestScore = score;

    try {
      storage.setItem(GUEST_SCORE_KEY, String(score));
    } catch {
      // 写入失败时保留已经更新的页面内存最高分。
    }

    return memoryBestScore;
  }

  return Object.freeze({ getBestScore, recordScore });
}
