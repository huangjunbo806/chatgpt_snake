function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
}

function result({ blocked, remaining, retryAfterMs }) {
  return Object.freeze({ blocked, remaining, retryAfterMs });
}

function reservationResult({ blocked, remaining, retryAfterMs, reservation }) {
  return Object.freeze({ blocked, remaining, retryAfterMs, reservation });
}

// 计数只保存在当前 Node.js 进程内；多进程部署需要在组合层替换为共享限流器。
export function createFixedWindowLimiter({
  limit,
  windowMs,
  now = Date.now,
  maxEntries = 10_000,
  cleanupBudget = 16,
} = {}) {
  validatePositiveInteger(limit, 'limit');
  validatePositiveInteger(windowMs, 'windowMs');
  validatePositiveInteger(maxEntries, 'maxEntries');
  validatePositiveInteger(cleanupBudget, 'cleanupBudget');

  const entries = new Map();
  const reservations = new WeakMap();
  let cleanupHead = null;
  let cleanupTail = null;
  let cleanupCursor = null;

  function appendEntry(entry) {
    entry.previous = cleanupTail;
    entry.next = null;
    if (cleanupTail) {
      cleanupTail.next = entry;
    } else {
      cleanupHead = entry;
    }
    cleanupTail = entry;
    cleanupCursor ??= entry;
  }

  function removeEntry(key, entry) {
    if (entries.get(key) !== entry) {
      return false;
    }

    const cursorAfterRemoval = entry.next ?? cleanupHead;
    entries.delete(key);

    if (entry.previous) {
      entry.previous.next = entry.next;
    } else {
      cleanupHead = entry.next;
    }
    if (entry.next) {
      entry.next.previous = entry.previous;
    } else {
      cleanupTail = entry.previous;
    }

    if (cleanupCursor === entry) {
      cleanupCursor = cursorAfterRemoval === entry ? null : cursorAfterRemoval;
    }
    entry.previous = null;
    entry.next = null;
    return true;
  }

  function removeExpiredIncrementally(currentTime) {
    for (let inspected = 0; inspected < cleanupBudget && cleanupHead; inspected += 1) {
      cleanupCursor ??= cleanupHead;
      const entry = cleanupCursor;
      cleanupCursor = entry.next ?? cleanupHead;
      if (entry.expiresAt <= currentTime) {
        removeEntry(entry.key, entry);
      }
    }
  }

  function getActiveEntry(key, currentTime) {
    const entry = entries.get(key);
    if (entry?.expiresAt <= currentTime) {
      removeEntry(key, entry);
      return null;
    }
    return entry ?? null;
  }

  function capacityResult() {
    return result({ blocked: true, remaining: 0, retryAfterMs: windowMs });
  }

  function capacityReservationResult() {
    return reservationResult({
      blocked: true,
      remaining: 0,
      retryAfterMs: windowMs,
      reservation: null,
    });
  }

  function entryCount(entry) {
    return entry.committed + entry.pending;
  }

  function check(key) {
    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    const entry = getActiveEntry(key, currentTime);

    if (!entry) {
      if (entries.size >= maxEntries) {
        return capacityResult();
      }
      return result({ blocked: false, remaining: limit, retryAfterMs: 0 });
    }

    const count = entryCount(entry);
    const blocked = count >= limit;
    return result({
      blocked,
      remaining: Math.max(0, limit - count),
      retryAfterMs: blocked ? Math.max(0, entry.expiresAt - currentTime) : 0,
    });
  }

  function reserve(key) {
    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    let entry = getActiveEntry(key, currentTime);

    if (!entry) {
      if (entries.size >= maxEntries) {
        return capacityReservationResult();
      }
      entry = {
        key,
        committed: 0,
        pending: 0,
        expiresAt: currentTime + windowMs,
        previous: null,
        next: null,
      };
      entries.set(key, entry);
      appendEntry(entry);
    }

    const count = entryCount(entry);
    if (count >= limit) {
      return reservationResult({
        blocked: true,
        remaining: 0,
        retryAfterMs: Math.max(0, entry.expiresAt - currentTime),
        reservation: null,
      });
    }

    entry.pending += 1;
    const reservation = Object.freeze({});
    reservations.set(reservation, { key, entry });
    return reservationResult({
      blocked: false,
      remaining: limit - count - 1,
      retryAfterMs: 0,
      reservation,
    });
  }

  function commit(reservation) {
    const reserved = reservations.get(reservation);
    if (!reserved) {
      return false;
    }
    reservations.delete(reservation);

    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    if (getActiveEntry(reserved.key, currentTime) !== reserved.entry) {
      return false;
    }

    reserved.entry.pending -= 1;
    reserved.entry.committed += 1;
    return true;
  }

  function release(reservation) {
    const reserved = reservations.get(reservation);
    if (!reserved) {
      return false;
    }
    reservations.delete(reservation);

    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    if (getActiveEntry(reserved.key, currentTime) !== reserved.entry) {
      return false;
    }

    reserved.entry.pending -= 1;
    if (entryCount(reserved.entry) === 0) {
      removeEntry(reserved.key, reserved.entry);
    }
    return true;
  }

  function consume(key) {
    const reserved = reserve(key);
    if (!reserved.blocked) {
      commit(reserved.reservation);
    }
    return result(reserved);
  }

  function reset(key) {
    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    const entry = getActiveEntry(key, currentTime);
    if (entry) {
      removeEntry(key, entry);
    }
  }

  function clearCommitted(key) {
    const currentTime = now();
    removeExpiredIncrementally(currentTime);
    const entry = getActiveEntry(key, currentTime);
    if (!entry) {
      return;
    }

    entry.committed = 0;
    if (entry.pending === 0) {
      removeEntry(key, entry);
    }
  }

  return Object.freeze({
    check,
    consume,
    reserve,
    commit,
    release,
    recordFailure: consume,
    reset,
    clearCommitted,
  });
}
