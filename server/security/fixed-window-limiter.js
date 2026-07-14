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
export function createFixedWindowLimiter({ limit, windowMs, now = Date.now } = {}) {
  validatePositiveInteger(limit, 'limit');
  validatePositiveInteger(windowMs, 'windowMs');

  const entries = new Map();
  const reservations = new WeakMap();

  function removeExpired(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) {
        entries.delete(key);
      }
    }
  }

  function check(key) {
    const currentTime = now();
    removeExpired(currentTime);
    const entry = entries.get(key);

    if (!entry) {
      return result({ blocked: false, remaining: limit, retryAfterMs: 0 });
    }

    const blocked = entry.count >= limit;
    return result({
      blocked,
      remaining: Math.max(0, limit - entry.count),
      retryAfterMs: blocked ? Math.max(0, entry.expiresAt - currentTime) : 0,
    });
  }

  function reserve(key) {
    const currentTime = now();
    removeExpired(currentTime);
    let entry = entries.get(key);

    if (!entry) {
      entry = { count: 0, expiresAt: currentTime + windowMs };
      entries.set(key, entry);
    }

    if (entry.count >= limit) {
      return reservationResult({
        blocked: true,
        remaining: 0,
        retryAfterMs: Math.max(0, entry.expiresAt - currentTime),
        reservation: null,
      });
    }

    entry.count += 1;
    const reservation = Object.freeze({});
    reservations.set(reservation, { key, entry });
    return reservationResult({
      blocked: false,
      remaining: limit - entry.count,
      retryAfterMs: 0,
      reservation,
    });
  }

  function commit(reservation) {
    return reservations.delete(reservation);
  }

  function release(reservation) {
    const reserved = reservations.get(reservation);
    if (!reserved) {
      return false;
    }
    reservations.delete(reservation);

    const currentTime = now();
    removeExpired(currentTime);
    if (entries.get(reserved.key) !== reserved.entry) {
      return false;
    }

    reserved.entry.count -= 1;
    if (reserved.entry.count === 0) {
      entries.delete(reserved.key);
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
    entries.delete(key);
  }

  return Object.freeze({
    check,
    consume,
    reserve,
    commit,
    release,
    recordFailure: consume,
    reset,
  });
}
