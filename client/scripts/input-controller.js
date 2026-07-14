const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="link"]';

const DIRECTION_BY_KEY = Object.freeze({
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
});

const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

function normalizeKey(key) {
  return typeof key === 'string' && key.length === 1
    ? key.toLowerCase()
    : key;
}

function isEditableTarget(target) {
  if (!target) return false;

  if (
    typeof target.matches === 'function' &&
    target.matches(EDITABLE_SELECTOR)
  ) {
    return true;
  }

  return (
    typeof target.closest === 'function' &&
    Boolean(target.closest(EDITABLE_SELECTOR))
  );
}

function isInteractiveTarget(target) {
  if (!target) return false;

  if (
    typeof target.matches === 'function' &&
    target.matches(INTERACTIVE_SELECTOR)
  ) {
    return true;
  }

  return (
    typeof target.closest === 'function' &&
    Boolean(target.closest(INTERACTIVE_SELECTOR))
  );
}

export function createInputController(
  {
    documentObject = globalThis.document,
    touchRoot,
    onDirection = () => {},
    onTogglePause = () => {},
    onRestart = () => {},
    onStart = () => {},
    onPageHidden = () => {},
  } = {},
) {
  if (!documentObject) {
    throw new Error('缺少 document，无法创建输入控制器。');
  }
  if (!touchRoot) {
    throw new Error('缺少触控区域 touchRoot，无法创建输入控制器。');
  }

  function handleKeyDown(event) {
    if (
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }

    const key = normalizeKey(event.key);
    if (
      (key === ' ' || key === 'Enter') &&
      isInteractiveTarget(event.target)
    ) {
      return;
    }

    const direction = Object.hasOwn(DIRECTION_BY_KEY, key)
      ? DIRECTION_BY_KEY[key]
      : undefined;

    if (direction) {
      event.preventDefault();
      onDirection(direction);
      return;
    }

    if (key === ' ' || key === 'p') {
      event.preventDefault();
      if (!event.repeat) onTogglePause();
    } else if (key === 'r') {
      event.preventDefault();
      if (!event.repeat) onRestart();
    } else if (key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) onStart();
    }
  }

  function handlePointerDown(event) {
    if (event.isPrimary === false) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (typeof event.target?.closest !== 'function') return;

    const directionElement = event.target.closest('[data-direction]');
    if (!directionElement || !touchRoot.contains(directionElement)) return;

    const direction = directionElement.dataset?.direction;
    if (!VALID_DIRECTIONS.has(direction)) return;

    event.preventDefault();
    onDirection(direction);
  }

  function handleVisibilityChange() {
    if (documentObject.hidden) onPageHidden();
  }

  documentObject.addEventListener('keydown', handleKeyDown);
  documentObject.addEventListener('visibilitychange', handleVisibilityChange);
  touchRoot.addEventListener('pointerdown', handlePointerDown);

  let destroyed = false;

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    documentObject.removeEventListener('keydown', handleKeyDown);
    documentObject.removeEventListener(
      'visibilitychange',
      handleVisibilityChange,
    );
    touchRoot.removeEventListener('pointerdown', handlePointerDown);
  }

  return Object.freeze({ destroy });
}
