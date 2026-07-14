const COLORS = Object.freeze({
  background: '#020503',
  grid: 'rgba(85,255,138,0.10)',
  snake: '#55ff8a',
  snakeHead: '#b5ffc9',
  food: '#ff4f87',
  text: '#d7ffe2',
});

const OVERLAY_MESSAGES = Object.freeze({
  ready: '按开始游戏',
  paused: '游戏已暂停',
  'game-over': '游戏结束',
  won: '棋盘已占满，你赢了！',
});

function clampPixelRatio(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(2, Math.max(1, numericValue));
}

function positiveDisplayWidth(value) {
  const width = Number(
    value !== null && typeof value === 'object' ? value.width : value,
  );
  return Number.isFinite(width) && width > 0 ? width : 1;
}

export function createCanvasRenderer(
  canvas,
  { getPixelRatio, getDisplaySize } = {},
) {
  const context =
    canvas && typeof canvas.getContext === 'function'
      ? canvas.getContext('2d')
      : null;

  if (!context) {
    throw new Error('浏览器不支持 Canvas 2D，无法启动游戏。');
  }

  const readPixelRatio =
    typeof getPixelRatio === 'function'
      ? getPixelRatio
      : () => globalThis.devicePixelRatio ?? 1;
  const readDisplaySize =
    typeof getDisplaySize === 'function'
      ? getDisplaySize
      : () => {
          const rectangle =
            typeof canvas.getBoundingClientRect === 'function'
              ? canvas.getBoundingClientRect()
              : null;
          return rectangle?.width ?? canvas.clientWidth ?? canvas.width ?? 1;
        };

  function resize() {
    const width = positiveDisplayWidth(readDisplaySize());
    const pixelRatio = clampPixelRatio(readPixelRatio());
    const backingSize = Math.max(1, Math.round(width * pixelRatio));

    if (canvas.width !== backingSize) canvas.width = backingSize;
    if (canvas.height !== backingSize) canvas.height = backingSize;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    return Object.freeze({
      width,
      height: width,
      pixelRatio,
    });
  }

  function drawGrid(width, boardSize) {
    const cellSize = width / boardSize;

    context.beginPath();
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;

    for (let index = 0; index <= boardSize; index += 1) {
      const offset = index * cellSize;
      context.moveTo(offset, 0);
      context.lineTo(offset, width);
      context.moveTo(0, offset);
      context.lineTo(width, offset);
    }

    context.stroke();
  }

  function drawSnake(snake, cellSize) {
    const inset = Math.max(1, cellSize * 0.12);
    const segmentSize = Math.max(1, cellSize - inset * 2);

    snake.forEach((segment, index) => {
      context.fillStyle = index === 0 ? COLORS.snakeHead : COLORS.snake;
      context.fillRect(
        segment.x * cellSize + inset,
        segment.y * cellSize + inset,
        segmentSize,
        segmentSize,
      );
    });
  }

  function drawFood(food, cellSize) {
    if (food === null) return;

    context.beginPath();
    context.fillStyle = COLORS.food;
    context.arc(
      (food.x + 0.5) * cellSize,
      (food.y + 0.5) * cellSize,
      cellSize * 0.28,
      0,
      Math.PI * 2,
    );
    context.fill();
  }

  function drawOverlay(status, width) {
    const message = OVERLAY_MESSAGES[status];
    if (!message) return;

    context.save();
    context.fillStyle = 'rgba(2,5,3,0.78)';
    context.fillRect(0, width * 0.4, width, width * 0.2);
    context.fillStyle = COLORS.text;
    context.font =
      '700 ' +
      Math.max(16, Math.round(width / 24)) +
      'px ui-monospace, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(message, width / 2, width / 2);
    context.restore();
  }

  function render(state) {
    const { width } = resize();
    const boardSize =
      Number.isInteger(state.boardSize) && state.boardSize > 0
        ? state.boardSize
        : 20;
    const cellSize = width / boardSize;

    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, width, width);
    drawGrid(width, boardSize);
    drawSnake(state.snake, cellSize);
    drawFood(state.food, cellSize);
    drawOverlay(state.status, width);
  }

  return Object.freeze({ resize, render });
}
