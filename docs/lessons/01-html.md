# 第 1 课：用 HTML 描述网页结构

HTML（HyperText Markup Language，超文本标记语言）负责说明页面中有什么。它不是编程语言，不处理蛇的移动、密码验证或数据库查询。

## 本课查看的文件

- `client/index.html`：整个网页的结构；
- `tests/ui/page-structure.test.mjs`：检查关键结构是否存在。

## 先认识页面骨架

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <title>Docker Snake</title>
  </head>
  <body>
    <header>页面顶部</header>
    <main>主要内容</main>
    <footer>页面底部</footer>
  </body>
</html>
```

`head` 保存标题、编码和样式链接等页面信息。用户真正看到的内容放在 `body` 中。

## 语义化标签

当前页面使用了以下标签：

| 标签 | 含义 |
| --- | --- |
| `header` | 页面或区域的头部 |
| `main` | 页面主要内容 |
| `section` | 一块独立内容 |
| `nav` | 导航或操作入口 |
| `form` | 用户输入表单 |
| `footer` | 页面底部信息 |

这些标签能帮助浏览器、搜索引擎和屏幕阅读器理解页面，而不只是把所有内容都写成 `div`。

## `id` 和 `class` 的区别

```html
<button id="start-game" class="primary-action">开始游戏</button>
```

- `id` 在页面中应保持唯一。JavaScript 常用它找到某个具体元素；
- `class` 可以重复。CSS 常用它为一组元素设置相同样式。

例如 `main.js` 会寻找 `#start-game`，CSS 会为 `.game-actions` 中的一组按钮排版。

## 表单为什么需要 `label`

```html
<label for="auth-username">用户名</label>
<input id="auth-username" name="username" autocomplete="username">
```

`for` 与输入框的 `id` 对应。点击文字时，浏览器会自动聚焦输入框，屏幕阅读器也能知道输入框的用途。

密码输入框使用 `type="password"`，但这只会隐藏屏幕上的字符。真正的密码安全必须由服务器端哈希和 HTTPS 完成。

## Canvas 是什么

```html
<canvas id="game-canvas" width="600" height="600">
  您的浏览器不支持 Canvas。
</canvas>
```

Canvas 是 JavaScript 可以绘图的区域。HTML 只创建画布，蛇、食物和网格由 `canvas-renderer.js` 绘制。

## 无障碍属性

- `aria-live="polite"`：内容变化时，让辅助工具在合适时机读出状态；
- `aria-label`：为没有明显文字的区域补充名称；
- `disabled`：按钮暂时不可操作；
- `hidden`：元素当前不显示。

页面初始禁用「开始游戏」，直到登录状态检查完成。这样鼠标和键盘都不能绕过初始化过程。

## 本课练习

1. 在浏览器开发者工具中找到 `#game-canvas`；
2. 临时修改 `<h1>` 的文字，观察页面变化；
3. 运行 `node --test tests/ui/page-structure.test.mjs`；
4. 故意删除一个关键 `id`，观察测试如何指出问题，再恢复它。
