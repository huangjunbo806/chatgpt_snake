# 第 3 课：用 JavaScript 实现贪吃蛇

JavaScript 负责网页行为。本项目没有把所有逻辑写进一个文件，而是按职责拆分模块。

## 模块分工

| 文件 | 作用 |
| --- | --- |
| `game-engine.js` | 纯游戏规则和状态变化 |
| `canvas-renderer.js` | 把状态绘制到 Canvas |
| `input-controller.js` | 键盘、触控和页面隐藏事件 |
| `game-ui.js` | 计时循环、按钮状态和一局游戏的生命周期 |
| `guest-score.js` | 使用 `localStorage` 保存游客最高分 |
| `main.js` | 把各模块组装成网页应用 |

## 状态驱动

游戏不会直接到处修改画面，而是先计算新状态，再根据新状态绘制：

```text
用户输入 → 更新方向 → 定时移动 → 产生新状态 → 重新绘制
```

常见状态包括 `ready`、`running`、`paused`、`game-over` 和 `won`。

`game-engine.js` 中的大部分函数都接收旧状态并返回新状态。这种写法便于测试，也能减少不同模块互相修改数据造成的错误。

## 游戏循环

`game-ui.js` 使用定时器周期性调用 `stepGame()`。吃到食物后，分数增加 10，移动间隔逐渐缩短，但不会低于 70 ms。

游戏结束时会生成冻结结果：

```js
{
  score: 120,
  durationMs: 840,
  outcome: 'wall'
}
```

`durationMs` 让服务器判断成绩是否明显不合理，`outcome` 只在浏览器中用于显示，不会提交给 API。

## 输入处理

方向键和 WASD 控制方向，空格切换暂停。输入模块会忽略：

- 在输入框中按下的按键；
- 输入法正在组合文字的事件；
- `Ctrl`、`Meta` 或 `Alt` 组合键；
- 会导致蛇立即反向的操作。

## 为什么分开引擎和绘图

游戏规则不依赖 DOM 或 Canvas，因此可以在 Node.js 中快速测试。绘图模块只关心如何显示状态，不决定碰撞和得分规则。

运行游戏相关测试：

```bash
node --test tests/game/*.test.mjs
```

## 本课练习

1. 在 `game-engine.js` 中找到初始移动间隔；
2. 阅读一次 `stepGame()` 如何处理撞墙；
3. 运行测试并观察总分理论上限；
4. 在浏览器中使用方向键、WASD 和触控按钮分别完成一次操作。
