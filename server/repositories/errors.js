export class UsernameConflictError extends Error {
  constructor() {
    super('用户名已被占用');
    this.name = 'UsernameConflictError';
  }
}
