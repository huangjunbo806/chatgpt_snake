# 第 2 课：用 CSS 搭建终端霓虹响应式界面

这一课聚焦页面外观和布局。它记录的是项目第 2 阶段的学习重点；当前工程已经继续加入游戏、登录和排行榜，但相同的 CSS 基础仍然适用。

## CSS 是什么

HTML 描述页面中有什么，CSS（Cascading Style Sheets，层叠样式表）决定这些内容如何显示。例如：

- 颜色和字体；
- 元素的宽度、间距与边框；
- 多列或多行布局；
- 不同屏幕宽度下的排列方式；
- 鼠标、键盘和减少动态效果等使用状态。

CSS 不负责贪吃蛇的移动、计分或按钮逻辑。这些行为会在后续 JavaScript 课程中实现。

## 本课涉及的文件

| 文件 | 作用 |
| --- | --- |
| `client/index.html` | 为页面区域补充可复用的 `class`，让 CSS 可以选中它们 |
| `client/styles/main.css` | 定义颜色、布局、交互状态和响应式规则 |
| `tests/ui/styles.test.mjs` | 检查关键颜色、布局和可用性规则是否存在 |

## 核心概念

### 1. CSS 变量

在 `:root` 中集中保存颜色：

```css
:root {
  --color-bg: #050806;
  --color-neon: #55ff8a;
  --color-food: #ff4f87;
}
```

使用变量时写成 `var(--color-neon)`。以后调整主题时，只需修改变量，不必逐个寻找相同颜色。

### 2. 盒模型

每个元素都可以理解为一个盒子，由内容、内边距、边框和外边距组成。本课统一使用：

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

设置 `border-box` 后，元素声明的宽高会包含内边距和边框，布局更容易计算。

### 3. Grid 与 Flexbox

- Grid 适合二维布局。本课用它排列三项游戏数据和触控方向键。
- Flexbox 适合单行或单列布局。本课用它排列顶部栏、状态和按钮。

二者不是互相替代的关系。根据内容的排列方向选择即可。

### 4. `aspect-ratio`

Canvas 外层使用固定宽高比：

```css
.canvas-frame {
  width: min(100%, 37.5rem);
  aspect-ratio: 1 / 1;
}

#game-canvas {
  width: 100%;
  height: 100%;
}
```

容器会随可用宽度缩放，但始终保持正方形。Canvas 的绘图尺寸仍由 HTML 中的 `width="600"` 和 `height="600"` 决定。

### 5. Media Query

媒体查询（Media Query）让样式根据设备条件变化：

```css
@media (max-width: 720px) {
  .touch-controls {
    display: grid;
  }
}

@media (pointer: coarse) {
  .touch-controls {
    display: grid;
  }
}
```

触控键在普通桌面环境中默认隐藏；屏幕不超过 720 px，或设备使用粗指针（通常是触摸屏）时才显示。页面还在 430 px 以下进一步压缩布局。

### 6. `:focus-visible`

使用键盘按 Tab 键浏览页面时，`:focus-visible` 会显示清晰的焦点轮廓。这样无需鼠标也能知道当前选中了哪个按钮。

### 7. 减少动态效果

部分用户会在系统中开启“减少动态效果”。本课通过下面的媒体查询缩短动画和过渡：

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

这是对用户系统偏好的尊重，也能减少动态效果引起的不适。

## 在浏览器中查看

在仓库根目录运行：

```bash
python3 -m http.server 8000 --directory client
```

然后打开 `http://localhost:8000`。查看结束后，在终端按 `Ctrl+C` 停止服务器。

## 预期效果

- 页面使用深色网格背景、霓虹绿主色和粉色强调色；
- 顶部显示项目名称、课程命令和访客状态；
- 游戏数据、正方形 Canvas、操作区和说明集中在一个控制台面板中；
- 排行榜显示在控制台下方；
- 缩窄浏览器窗口后，按钮和数据自动重新排列；
- 屏幕不超过 720 px 时显示触控方向键；
- 使用 Tab 键时，按钮出现清晰的焦点轮廓。

如果只查看这一课对应的历史提交，Canvas 没有游戏画面是正常现象。当前完整工程已经在 JavaScript 模块中实现游戏。

## 常见错误

### 页面显示 404

确认命令是在仓库根目录运行，并且包含 `--directory client`。

### 样式没有生效

确认 `client/index.html` 仍通过 `./styles/main.css` 引入样式。修改后可强制刷新浏览器，排除旧缓存。

### 端口已被占用

停止占用 8000 端口的旧服务器，或把命令中的端口和浏览器地址一起改成其他数字。

### 触控方向键没有显示

桌面宽屏会隐藏触控键。把浏览器窗口缩到 720 px 以下，或在浏览器开发者工具中模拟触摸设备。

### 页面出现横向滚动

检查新增内容是否拥有固定宽度。响应式元素应优先使用百分比、`min()` 或 `max-width`，并保留全局 `box-sizing: border-box`。
