import argon2 from 'argon2';

const ARGON2_OPTIONS = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export function createPasswordService({ argon2Impl = argon2 } = {}) {
  async function hash(password) {
    return argon2Impl.hash(password, {
      type: argon2Impl.argon2id,
      ...ARGON2_OPTIONS,
    });
  }

  async function verify(passwordHash, password) {
    return argon2Impl.verify(passwordHash, password);
  }

  return Object.freeze({ hash, verify });
}
