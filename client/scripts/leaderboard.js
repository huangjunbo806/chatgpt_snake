function isAbortError(error) {
  return error?.name === 'AbortError';
}

function currentUserId(snapshot) {
  return snapshot?.status === 'authenticated'
    ? String(snapshot.user.id)
    : null;
}

export function createLeaderboardController({
  api,
  elements,
  documentRef = globalThis.document,
  getAuthSnapshot,
  onServerBest = () => undefined,
  createAbortController = () => new AbortController(),
} = {}) {
  if (typeof api?.getLeaderboard !== 'function') {
    throw new TypeError('排行榜需要 api.getLeaderboard');
  }
  if (typeof getAuthSnapshot !== 'function') {
    throw new TypeError('排行榜需要 getAuthSnapshot');
  }
  for (const key of ['status', 'list', 'myRank', 'refreshButton']) {
    if (!elements?.[key]) throw new Error(`排行榜界面缺少 ${key}`);
  }
  if (typeof documentRef?.createElement !== 'function') {
    throw new Error('排行榜需要 document.createElement');
  }

  let generation = 0;
  let activeController = null;
  let destroyed = false;

  function replaceList(entries) {
    const items = [];
    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = documentRef.createElement('li');
      empty.textContent = '暂无已提交成绩';
      items.push(empty);
    } else {
      for (const entry of entries) {
        const item = documentRef.createElement('li');
        item.textContent = `#${entry.rank}  ${entry.username}  ·  ${entry.bestScore} 分`;
        items.push(item);
      }
    }
    elements.list.replaceChildren(...items);
  }

  function renderMyRank(snapshot, me) {
    if (snapshot?.status !== 'authenticated') {
      elements.myRank.textContent = '我的排名：访客不参与排行榜';
      return;
    }
    if (!me) {
      elements.myRank.textContent = '我的排名：登录状态可能已失效';
      return;
    }
    elements.myRank.textContent = me.rank === null
      ? `我的排名：尚未上榜 · 最高分 ${me.bestScore}`
      : `我的排名：#${me.rank} · 最高分 ${me.bestScore}`;
  }

  async function refresh() {
    if (destroyed) return;
    generation += 1;
    const requestGeneration = generation;
    activeController?.abort();
    const controller = createAbortController();
    activeController = controller;
    const snapshotAtRequest = getAuthSnapshot();
    const userIdAtRequest = currentUserId(snapshotAtRequest);
    elements.status.textContent = '正在读取排行榜…';
    elements.refreshButton.disabled = true;

    try {
      const data = await api.getLeaderboard({ signal: controller.signal });
      if (destroyed || requestGeneration !== generation) return;

      replaceList(data?.entries);
      renderMyRank(snapshotAtRequest, data?.me ?? null);
      elements.status.textContent = '排行榜已更新';
      if (userIdAtRequest !== null && data?.me) {
        onServerBest({ userId: userIdAtRequest, bestScore: data.me.bestScore });
      }
    } catch (error) {
      if (destroyed || requestGeneration !== generation || isAbortError(error)) return;
      elements.status.textContent = '排行榜读取失败，可点击刷新重试。';
    } finally {
      if (!destroyed && requestGeneration === generation) {
        activeController = null;
        elements.refreshButton.disabled = false;
      }
    }
  }

  function handleAuthChange(snapshot = getAuthSnapshot()) {
    if (destroyed) return;
    generation += 1;
    activeController?.abort();
    activeController = null;
    renderMyRank(snapshot, null);
    if (snapshot?.status === 'loading') {
      elements.status.textContent = '等待确认登录状态…';
      elements.refreshButton.disabled = true;
      return;
    }
    void refresh();
  }

  const handleRefresh = () => { void refresh(); };
  elements.refreshButton.addEventListener('click', handleRefresh);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    activeController?.abort();
    activeController = null;
    elements.refreshButton.removeEventListener('click', handleRefresh);
  }

  return Object.freeze({ refresh, handleAuthChange, destroy });
}
