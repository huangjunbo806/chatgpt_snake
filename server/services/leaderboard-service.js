import { AppError } from '../errors.js';
import { parseScoreSubmission } from './score-validation.js';

function authRequired() {
  return new AppError({
    status: 401,
    code: 'AUTH_REQUIRED',
    message: '请先登录',
  });
}

function projectStanding(standing) {
  return Object.freeze({
    rank: standing.rank,
    username: standing.username,
    bestScore: standing.bestScore,
    bestScoreAt: standing.bestScoreAt,
  });
}

function projectEntries(entries) {
  return Object.freeze(entries.map(projectStanding));
}

export function createLeaderboardService({ repository } = {}) {
  async function submit(userId, body) {
    const { score } = parseScoreSubmission(body);
    const normalizedUserId = String(userId);
    const updated = await repository.raiseBestScore({
      userId: normalizedUserId,
      score,
    });
    const standing = await repository.findUserStandingById(normalizedUserId);
    if (standing === null) {
      throw authRequired();
    }

    return Object.freeze({
      updated,
      bestScore: standing.bestScore,
      rank: standing.rank,
    });
  }

  async function read(userId = null) {
    if (userId === null) {
      const entries = await repository.findTop();
      return Object.freeze({ entries: projectEntries(entries), me: null });
    }

    const normalizedUserId = String(userId);
    const [entries, standing] = await Promise.all([
      repository.findTop(),
      repository.findUserStandingById(normalizedUserId),
    ]);
    if (standing === null) {
      throw authRequired();
    }

    return Object.freeze({
      entries: projectEntries(entries),
      me: projectStanding(standing),
    });
  }

  return Object.freeze({ submit, read });
}
