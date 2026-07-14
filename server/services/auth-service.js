import { parseLoginInput, parseRegistrationInput } from '../auth/auth-validation.js';
import { AppError } from '../errors.js';
import { UsernameConflictError } from '../repositories/errors.js';

function projectUser(user) {
  return Object.freeze({
    id: String(user.id),
    username: user.username,
  });
}

function invalidCredentials() {
  return new AppError({
    status: 401,
    code: 'INVALID_CREDENTIALS',
    message: '用户名或密码错误',
  });
}

export function createAuthService({
  userRepository,
  passwordService,
  dummyPasswordHash,
} = {}) {
  async function register(body) {
    const { username, password } = parseRegistrationInput(body);
    const passwordHash = await passwordService.hash(password);
    let created;

    try {
      created = await userRepository.create({ username, passwordHash });
    } catch (error) {
      if (error instanceof UsernameConflictError) {
        throw new AppError({
          status: 409,
          code: 'USERNAME_TAKEN',
          message: '用户名已被占用',
          cause: error,
        });
      }
      throw error;
    }

    return projectUser(created);
  }

  async function login(body) {
    const parsed = parseLoginInput(body);

    if (!parsed.valid) {
      await passwordService.verify(dummyPasswordHash, parsed.verificationPassword);
      throw invalidCredentials();
    }

    const credentials = await userRepository.findCredentialsByUsername(parsed.username);
    const passwordHash = credentials?.passwordHash ?? dummyPasswordHash;
    const passwordMatches = await passwordService.verify(passwordHash, parsed.verificationPassword);

    if (!credentials || !passwordMatches) {
      throw invalidCredentials();
    }

    return projectUser(credentials);
  }

  async function findCurrentUser(userId) {
    const user = await userRepository.findPublicById(String(userId));
    return user === null ? null : projectUser(user);
  }

  return Object.freeze({ register, login, findCurrentUser });
}
