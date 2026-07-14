import { AppError } from '../errors.js';

const MAX_SCORE = 3960;
const MAX_DURATION_MS = 86_400_000;
const MIN_STEP_DURATION_MS = 70;

function invalidScore() {
  return new AppError({
    status: 400,
    code: 'INVALID_SCORE',
    message: '成绩数据不符合要求',
  });
}

function readSubmission(body) {
  try {
    if (body === null
      || typeof body !== 'object'
      || Object.getPrototypeOf(body) !== Object.prototype) {
      return null;
    }

    const keys = Reflect.ownKeys(body);
    if (keys.length !== 2 || !keys.includes('score') || !keys.includes('durationMs')) {
      return null;
    }

    const scoreDescriptor = Object.getOwnPropertyDescriptor(body, 'score');
    const durationDescriptor = Object.getOwnPropertyDescriptor(body, 'durationMs');
    if (!scoreDescriptor?.enumerable
      || !durationDescriptor?.enumerable
      || !Object.hasOwn(scoreDescriptor, 'value')
      || !Object.hasOwn(durationDescriptor, 'value')) {
      return null;
    }

    return {
      score: scoreDescriptor.value,
      durationMs: durationDescriptor.value,
    };
  } catch {
    return null;
  }
}

export function parseScoreSubmission(body) {
  const submission = readSubmission(body);
  if (submission === null) {
    throw invalidScore();
  }

  const { score, durationMs } = submission;
  const validScore = Number.isInteger(score)
    && score >= 0
    && score <= MAX_SCORE
    && score % 10 === 0;
  const validDuration = Number.isInteger(durationMs)
    && durationMs >= 0
    && durationMs <= MAX_DURATION_MS;
  const plausibleDuration = validScore
    && validDuration
    && (score === 0 || durationMs >= (score / 10) * MIN_STEP_DURATION_MS);

  if (!validScore || !validDuration || !plausibleDuration) {
    throw invalidScore();
  }

  return Object.freeze({ score, durationMs });
}
