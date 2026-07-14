export class ScoreOwnershipError extends Error {
  constructor() {
    super('当前登录账户与本局归属不一致，请切回原账户后重试');
    this.name = 'ScoreOwnershipError';
    this.code = 'SCORE_OWNER_MISMATCH';
  }
}

function authenticatedUserId(snapshot) {
  if (snapshot?.status !== 'authenticated' || snapshot.user?.id === undefined) {
    return null;
  }
  return String(snapshot.user.id);
}

export function createScoreCoordinator({
  api,
  guestScoreStore,
  getAuthSnapshot,
  onBestScore = () => undefined,
  onScoreSubmitted = () => undefined,
  onAuthenticationRequired = () => undefined,
} = {}) {
  if (typeof api?.submitScore !== 'function') {
    throw new TypeError('createScoreCoordinator 需要 api.submitScore');
  }
  if (
    typeof guestScoreStore?.getBestScore !== 'function'
    || typeof guestScoreStore?.recordScore !== 'function'
  ) {
    throw new TypeError('createScoreCoordinator 需要游客成绩存储');
  }
  if (typeof getAuthSnapshot !== 'function') {
    throw new TypeError('createScoreCoordinator 需要 getAuthSnapshot');
  }

  let destroyed = false;

  function beginRound() {
    const userId = authenticatedUserId(getAuthSnapshot());
    return userId === null
      ? Object.freeze({ kind: 'guest' })
      : Object.freeze({ kind: 'user', userId });
  }

  function ownerIsCurrent(owner) {
    return owner?.kind === 'user'
      && authenticatedUserId(getAuthSnapshot()) === owner.userId;
  }

  function handleAuthChange(snapshot = getAuthSnapshot()) {
    if (destroyed || snapshot?.status === 'loading') return;

    if (snapshot?.status === 'guest') {
      onBestScore(guestScoreStore.getBestScore());
      return;
    }

    onBestScore(0);
  }

  function applyServerBest({ userId, bestScore } = {}) {
    if (
      destroyed
      || authenticatedUserId(getAuthSnapshot()) !== String(userId)
      || !Number.isInteger(bestScore)
      || bestScore < 0
    ) {
      return false;
    }

    onBestScore(bestScore);
    return true;
  }

  async function finishRound(result, owner) {
    if (destroyed) return null;

    if (owner?.kind === 'guest') {
      const bestScore = guestScoreStore.recordScore(result?.score);
      if (!destroyed && getAuthSnapshot()?.status === 'guest') {
        onBestScore(bestScore);
      }
      return Object.freeze({ destination: 'guest', bestScore });
    }

    if (!ownerIsCurrent(owner)) {
      throw new ScoreOwnershipError();
    }

    let response;
    try {
      response = await api.submitScore({
        score: result?.score,
        durationMs: result?.durationMs,
      });
    } catch (error) {
      if (error?.code === 'AUTH_REQUIRED') {
        onAuthenticationRequired();
      }
      throw error;
    }

    if (!destroyed && ownerIsCurrent(owner)) {
      onBestScore(response.bestScore);
      onScoreSubmitted();
    }
    return response;
  }

  function destroy() {
    destroyed = true;
  }

  return Object.freeze({
    beginRound,
    finishRound,
    handleAuthChange,
    applyServerBest,
    destroy,
  });
}
