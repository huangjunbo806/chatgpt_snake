const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_LENGTH = 128;

const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: '用户名或密码格式不正确。',
  INVALID_CREDENTIALS: '用户名或密码不正确。',
  USERNAME_TAKEN: '这个用户名已经被使用。',
  RATE_LIMITED: '尝试次数过多，请稍后再试。',
  NETWORK_ERROR: '无法连接服务器，请检查网络后重试。',
});

function createSnapshot(status, user = null) {
  const safeUser = status === 'authenticated'
    ? Object.freeze({ id: String(user.id), username: String(user.username) })
    : null;
  return Object.freeze({ status, user: safeUser });
}

function userFromResponse(data) {
  const user = data?.user;
  if (
    user === null
    || typeof user !== 'object'
    || user.id === undefined
    || typeof user.username !== 'string'
  ) {
    throw new Error('服务器没有返回有效的用户信息');
  }
  return user;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function errorMessage(error) {
  return ERROR_MESSAGES[error?.code] ?? '操作失败，请稍后再试。';
}

function passwordLength(value) {
  return [...String(value)].length;
}

function validateElements(elements) {
  const required = [
    'sessionStatus',
    'showRegisterButton',
    'showLoginButton',
    'logoutButton',
    'panel',
    'title',
    'form',
    'usernameInput',
    'passwordInput',
    'confirmRow',
    'confirmPasswordInput',
    'help',
    'message',
    'submitButton',
    'cancelButton',
  ];
  for (const key of required) {
    if (!elements?.[key]) throw new Error(`认证界面缺少 ${key}`);
  }
}

export function createAuthController({
  api,
  elements,
  createAbortController = () => new AbortController(),
} = {}) {
  if (
    typeof api?.getCurrentUser !== 'function'
    || typeof api?.register !== 'function'
    || typeof api?.login !== 'function'
    || typeof api?.logout !== 'function'
  ) {
    throw new TypeError('createAuthController 需要完整认证 API');
  }
  validateElements(elements);

  let snapshot = createSnapshot('loading');
  let formMode = null;
  let busy = false;
  let destroyed = false;
  let generation = 0;
  let activeController = null;
  const subscribers = new Set();

  function notify() {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(snapshot);
      } catch {
        // 一个页面订阅者的错误不应破坏认证状态。
      }
    }
  }

  function updateSnapshot(next) {
    snapshot = next;
    render();
    notify();
  }

  function render() {
    const authenticated = snapshot.status === 'authenticated';
    const loading = snapshot.status === 'loading';
    elements.sessionStatus.textContent = loading
      ? '正在确认登录状态…'
      : authenticated
        ? `已登录：${snapshot.user.username}`
        : '当前状态：访客';

    elements.showRegisterButton.hidden = authenticated;
    elements.showLoginButton.hidden = authenticated;
    elements.logoutButton.hidden = !authenticated;
    elements.showRegisterButton.disabled = loading || busy;
    elements.showLoginButton.disabled = loading || busy;
    elements.logoutButton.disabled = loading || busy;

    elements.panel.hidden = formMode === null;
    elements.confirmRow.hidden = formMode !== 'register';
    elements.title.textContent = formMode === 'register' ? '创建账户' : '登录账户';
    elements.submitButton.textContent = busy
      ? '处理中…'
      : formMode === 'register'
        ? '注册并登录'
        : '登录';
    elements.submitButton.disabled = busy;
    elements.cancelButton.disabled = busy;
    elements.usernameInput.disabled = busy;
    elements.passwordInput.disabled = busy;
    elements.confirmPasswordInput.disabled = busy;
    elements.passwordInput.autocomplete = formMode === 'register'
      ? 'new-password'
      : 'current-password';
    elements.help.textContent = formMode === 'register'
      ? '用户名 3–20 位字母、数字或下划线；密码 15–128 个字符。'
      : '请输入注册时使用的用户名和密码。';
  }

  function beginOperation() {
    activeController?.abort();
    const controller = createAbortController();
    activeController = controller;
    generation += 1;
    return { controller, generation: generation };
  }

  function operationIsCurrent(operationGeneration) {
    return !destroyed && generation === operationGeneration;
  }

  function finishOperation(controller, operationGeneration) {
    if (operationIsCurrent(operationGeneration) && activeController === controller) {
      activeController = null;
    }
  }

  async function initialize() {
    if (destroyed) return snapshot;
    updateSnapshot(createSnapshot('loading'));
    elements.message.textContent = '';
    const operation = beginOperation();

    try {
      const data = await api.getCurrentUser({ signal: operation.controller.signal });
      if (!operationIsCurrent(operation.generation)) return snapshot;

      if (data?.authenticated === true) {
        updateSnapshot(createSnapshot('authenticated', userFromResponse(data)));
      } else {
        updateSnapshot(createSnapshot('guest'));
      }
    } catch (error) {
      if (!operationIsCurrent(operation.generation) || isAbortError(error)) return snapshot;
      elements.message.textContent = '无法确认登录状态，已使用游客模式。';
      updateSnapshot(createSnapshot('guest'));
    } finally {
      finishOperation(operation.controller, operation.generation);
    }
    return snapshot;
  }

  function openForm(mode) {
    if (destroyed || busy || !['register', 'login'].includes(mode)) return;
    formMode = mode;
    elements.message.textContent = '';
    elements.confirmPasswordInput.value = '';
    render();
    elements.usernameInput.focus?.();
  }

  function closeForm() {
    if (destroyed || busy) return;
    formMode = null;
    elements.passwordInput.value = '';
    elements.confirmPasswordInput.value = '';
    elements.message.textContent = '';
    render();
  }

  async function authenticate(mode, { username, password, confirmPassword } = {}) {
    if (destroyed) return snapshot;
    if (mode === 'register') {
      if (password !== confirmPassword) {
        elements.message.textContent = '两次输入的密码不一致。';
        throw new Error('PASSWORD_CONFIRMATION_MISMATCH');
      }
      const length = passwordLength(password);
      if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
        elements.message.textContent = '密码长度必须为 15–128 个字符。';
        throw new Error('INVALID_PASSWORD_LENGTH');
      }
    }

    const operation = beginOperation();
    busy = true;
    elements.message.textContent = '';
    render();
    try {
      const data = mode === 'register'
        ? await api.register({ username, password }, { signal: operation.controller.signal })
        : await api.login({ username, password }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation.generation)) return snapshot;

      formMode = null;
      elements.passwordInput.value = '';
      elements.confirmPasswordInput.value = '';
      updateSnapshot(createSnapshot('authenticated', userFromResponse(data)));
      return snapshot;
    } catch (error) {
      if (operationIsCurrent(operation.generation) && !isAbortError(error)) {
        elements.message.textContent = errorMessage(error);
      }
      throw error;
    } finally {
      if (operationIsCurrent(operation.generation)) {
        busy = false;
        finishOperation(operation.controller, operation.generation);
        render();
      }
    }
  }

  function register(credentials) {
    return authenticate('register', credentials);
  }

  function login(credentials) {
    return authenticate('login', credentials);
  }

  async function logout() {
    if (destroyed) return snapshot;
    const operation = beginOperation();
    busy = true;
    elements.message.textContent = '';
    render();
    try {
      await api.logout({ signal: operation.controller.signal });
      if (operationIsCurrent(operation.generation)) {
        updateSnapshot(createSnapshot('guest'));
      }
      return snapshot;
    } catch (error) {
      if (operationIsCurrent(operation.generation) && error?.code === 'AUTH_REQUIRED') {
        updateSnapshot(createSnapshot('guest'));
        return snapshot;
      }
      if (operationIsCurrent(operation.generation) && !isAbortError(error)) {
        elements.message.textContent = errorMessage(error);
      }
      throw error;
    } finally {
      if (operationIsCurrent(operation.generation)) {
        busy = false;
        finishOperation(operation.controller, operation.generation);
        render();
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('认证订阅者必须是函数');
    if (destroyed) return () => undefined;
    subscribers.add(listener);
    try { listener(snapshot); } catch { /* 订阅者自行隔离。 */ }
    return () => subscribers.delete(listener);
  }

  function getSnapshot() {
    return snapshot;
  }

  function handleSubmit(event) {
    event?.preventDefault?.();
    if (busy || formMode === null) return;
    const credentials = {
      username: elements.usernameInput.value,
      password: elements.passwordInput.value,
      confirmPassword: elements.confirmPasswordInput.value,
    };
    const action = formMode === 'register' ? register(credentials) : login(credentials);
    void action.catch(() => undefined);
  }

  const handleOpenRegister = () => openForm('register');
  const handleOpenLogin = () => openForm('login');
  const handleLogout = () => { void logout().catch(() => undefined); };
  const handleCancel = () => closeForm();

  elements.showRegisterButton.addEventListener('click', handleOpenRegister);
  elements.showLoginButton.addEventListener('click', handleOpenLogin);
  elements.logoutButton.addEventListener('click', handleLogout);
  elements.form.addEventListener('submit', handleSubmit);
  elements.cancelButton.addEventListener('click', handleCancel);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    activeController?.abort();
    activeController = null;
    subscribers.clear();
    elements.showRegisterButton.removeEventListener('click', handleOpenRegister);
    elements.showLoginButton.removeEventListener('click', handleOpenLogin);
    elements.logoutButton.removeEventListener('click', handleLogout);
    elements.form.removeEventListener('submit', handleSubmit);
    elements.cancelButton.removeEventListener('click', handleCancel);
  }

  render();
  return Object.freeze({
    initialize,
    openRegister: () => openForm('register'),
    openLogin: () => openForm('login'),
    register,
    login,
    logout,
    subscribe,
    getSnapshot,
    destroy,
  });
}
