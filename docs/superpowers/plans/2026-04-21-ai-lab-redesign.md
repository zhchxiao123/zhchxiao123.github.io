# AI Lab 页面现代化重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI Lab 页面从当前设计重构为轻玻璃进化版风格，实现可收起侧边栏、精简装饰背景、优雅动效。

**Architecture:** 单文件布局（`_layouts/lab.html`），所有 HTML/CSS/JS 在一个文件中。CSS 变量系统控制颜色、透明度、动效时间。侧边栏通过 class toggle + CSS transform 实现展开/收起动画。

**Tech Stack:** 纯 HTML/CSS/JS，无框架依赖。CSS 自定义属性管理主题。

---

## 文件映射

**唯一修改文件:**
- `labs/_layouts/lab.html` (sic — 注意路径是 `labs/_layouts/lab.html`，实际位于 `labs/_layouts/lab.html`)

> Jekyll 约定 `_layouts/` 应在根目录，但当前仓库结构中 `lab.html` 实际位于 `labs/_layouts/lab.html`。实施前需确认实际路径。

---

### Task 1: 更新 CSS 变量系统

**Files:**
- Modify: `labs/_layouts/lab.html:125-145`

- [ ] **Step 1: 替换 CSS 变量块**

替换现有的 `:root` 和 `[data-mode='dark']` 变量块为新的设计规范值：

```css
:root {
  --primary: #1677ff;
  --primary-grad: linear-gradient(135deg, #1677ff 0%, #722ed1 100%);
  --bg-base: #ffffff;
  --bg-glass: rgba(255, 255, 255, 0.92);
  --border-color: rgba(0, 0, 0, 0.04);
  --text-main: #1f1f1f;
  --text-sec: #8c8c8c;
  --shadow-soft: 0 8px 32px rgba(0, 0, 0, 0.05);
  --transition-sidebar: 350ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-msg: 400ms ease-out;
  --transition-focus: 200ms ease-out;
  --transition-hover: 150ms ease-out;
}

[data-mode='dark'] {
  --bg-base: #111112;
  --bg-glass: rgba(17, 17, 18, 0.85);
  --border-color: rgba(255, 255, 255, 0.08);
  --text-main: #e6e6e6;
  --text-sec: #858585;
  --shadow-soft: 0 8px 32px rgba(0, 0, 0, 0.3);
  --primary-grad: linear-gradient(135deg, #1677ff 0%, #722ed1 100%);
}
```

- [ ] **Step 2: 验证变量已正确替换**

在浏览器 DevTools 中检查 `document.documentElement.style` 确认变量已生效。

- [ ] **Step 3: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): update CSS variable system with new design tokens"
```

---

### Task 2: 重构 Header（高度56px + Toggle按钮）

**Files:**
- Modify: `labs/_layouts/lab.html:186-201`

- [ ] **Step 1: 更新 Header 样式**

```css
/* Header */
.lab-header {
  height: 56px;  /* 原 64px */
  padding: 0 24px;  /* 原 32px */
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-glass);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}
```

- [ ] **Step 2: 更新 Logo 样式**

```css
.lab-logo { display: flex; align-items: center; gap: 10px; }
.logo-icon { width: 28px; height: 28px; }  /* 原 32px */
.logo-text { font-weight: 600; font-size: 14px; letter-spacing: -0.02em; }
.version-tag { font-size: 10px; background: var(--border-color); padding: 2px 6px; border-radius: 4px; color: var(--text-sec); }
```

- [ ] **Step 3: 更新 header-right 按钮为纯图标**

将现有的 `btn-primary-outline` 改为图标按钮，header-right 区域增加 sidebar toggle 按钮。

```html
<div class="header-right">
  <button id="sidebar-toggle" class="btn-ghost" title="Toggle Settings">
    <i class="fas fa-sliders-h"></i>
  </button>
  <div class="divider-v"></div>
  <button onclick="clearHistory()" class="btn-ghost" title="Clear History">
    <i class="fas fa-trash-alt"></i>
  </button>
  <div class="divider-v"></div>
  <a href="{{ '/' | relative_url }}" class="btn-ghost" title="Back to Blog">
    <i class="fas fa-home"></i>
  </a>
</div>
```

- [ ] **Step 4: 更新 btn-ghost 样式**

```css
.btn-ghost {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  background: transparent;
  color: var(--text-sec);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition-hover);
}
.btn-ghost:hover {
  background: var(--border-color);
  color: var(--text-main);
}
```

- [ ] **Step 5: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): restyle header to 56px with icon-only buttons and sidebar toggle"
```

---

### Task 3: 重构消息气泡（圆角20px + 玻璃92%透明度）

**Files:**
- Modify: `labs/_layouts/lab.html:216-246`

- [ ] **Step 1: 更新消息列表和气泡样式**

```css
.messages-list {
  flex: 1;
  overflow-y: auto;
  padding: 40px 64px 200px;
  display: flex;
  flex-direction: column;
  gap: 32px;  /* 原 32px 但更强调 */
  scrollbar-width: none;
}
.messages-list::-webkit-scrollbar { display: none; }

/* Message Style */
.msg-wrapper {
  max-width: 75%;  /* 原 85% */
  display: flex;
  transform: translateY(12px);
  opacity: 0;
  transition: var(--transition-msg);
}
.msg-wrapper.appear { transform: translateY(0); opacity: 1; }
.msg-wrapper.user { align-self: flex-end; }
.msg-wrapper.bot { align-self: flex-start; }

.msg-bubble {
  padding: 16px 18px;
  border-radius: 20px;  /* 原 16px */
  background: rgba(255, 255, 255, 0.92);  /* 玻璃 92% */
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-soft);
  position: relative;
}

[data-mode='dark'] .msg-bubble {
  background: rgba(17, 17, 18, 0.85);
}

.user .msg-bubble {
  background: var(--primary-grad);
  color: white;
  border-color: transparent;
}

.bubble-content { font-size: 15px; line-height: 1.6; }
.bubble-meta { font-size: 11px; margin-top: 8px; color: var(--text-sec); }
.user .bubble-meta { color: rgba(255,255,255,0.7); }
```

- [ ] **Step 2: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): update message bubbles with 20px radius and 92% glass effect"
```

---

### Task 4: 重构悬浮输入框（圆角24px + focus光晕）

**Files:**
- Modify: `labs/_layouts/lab.html:248-318`

- [ ] **Step 1: 更新 command-bar-wrapper 定位**

```css
.command-bar-wrapper {
  position: absolute;
  bottom: 32px;  /* 原 40px */
  left: 64px;
  right: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;  /* 原 12px */
  pointer-events: none;
}
```

- [ ] **Step 2: 更新 command-bar 样式**

```css
.command-bar {
  width: 100%;
  max-width: 800px;
  background: rgba(255, 255, 255, 0.95);  /* 95% 透明度 */
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  border: 1px solid var(--border-color);
  border-radius: 24px;  /* 原 20px */
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.08);
  pointer-events: all;
  transition: border-color var(--transition-focus), box-shadow var(--transition-focus);
}

.command-bar:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.1), 0 20px 50px rgba(0,0,0,0.08);
}
```

- [ ] **Step 3: 更新发送按钮样式**

```css
.send-action {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: var(--primary-grad);
  color: white;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--transition-hover);
  flex-shrink: 0;
}
.send-action:hover { transform: scale(1.08); }
.send-action:active { transform: scale(0.95); }
```

- [ ] **Step 4: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): restyle floating input bar with 24px radius and focus glow"
```

---

### Task 5: 实现可收起侧边栏（动画 + 状态管理）

**Files:**
- Modify: `labs/_layouts/lab.html:321-362`

- [ ] **Step 1: 更新侧边栏容器和面板样式**

```css
.settings-panel {
  position: fixed;
  top: 56px;  /* header height */
  right: 0;
  width: 340px;
  height: calc(100vh - 56px);
  padding: 28px 24px;
  background: rgba(255, 255, 255, 0.88);  /* 88% 透明度 */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-left: 1px solid var(--border-color);
  overflow-y: auto;
  transform: translateX(100%);
  transition: transform var(--transition-sidebar);
  z-index: 2001;
}

[data-mode='dark'] .settings-panel {
  background: rgba(17, 17, 18, 0.85);
}

.settings-panel.open {
  transform: translateX(0);
}

/* 侧边栏展开时背景遮罩 */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  top: 56px;
  background: rgba(0, 0, 0, 0.1);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-sidebar);
  z-index: 2000;
}

.sidebar-overlay.visible {
  opacity: 1;
  pointer-events: all;
}
```

- [ ] **Step 2: 更新设置面板内部样式**

```css
.section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-sec);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-card {
  background: rgba(0, 0, 0, 0.02);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-bottom: 28px;
  border: 1px solid var(--border-color);
}

[data-mode='dark'] .setting-card {
  background: rgba(255, 255, 255, 0.03);
}
```

- [ ] **Step 3: 添加侧边栏收起时的 chat-viewport 宽度调整**

```css
.chat-viewport {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  transition: max-width var(--transition-sidebar);
}
```

- [ ] **Step 4: 添加 JavaScript 侧边栏切换逻辑**

在 `<script>` 块中添加：

```javascript
// 侧边栏状态管理
let sidebarOpen = false;
const sidebar = document.querySelector('.settings-panel');
const overlay = document.querySelector('.sidebar-overlay');
const sidebarToggle = document.getElementById('sidebar-toggle');

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    sidebarToggle.querySelector('i').className = 'fas fa-times';
  } else {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
    sidebarToggle.querySelector('i').className = 'fas fa-sliders-h';
  }
}

sidebarToggle.addEventListener('click', toggleSidebar);
overlay.addEventListener('click', toggleSidebar);
```

- [ ] **Step 5: 添加侧边栏收起时的布局适配**

更新 `.lab-content` 样式，使其在侧边栏收起时仍然占满全宽：

```css
.lab-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}
```

- [ ] **Step 6: 在 HTML 中添加 overlay 遮罩**

在 `.command-bar-wrapper` 前添加：

```html
<div class="sidebar-overlay"></div>
```

- [ ] **Step 7: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "feat(ai-lab): implement collapsible sidebar with smooth animation"
```

---

### Task 6: 精简装饰背景（降低点阵和渐变透明度）

**Files:**
- Modify: `labs/_layouts/lab.html:158-183`

- [ ] **Step 1: 更新 mesh-gradient 样式**

```css
.mesh-gradient {
  position: absolute;
  top: -30%;
  right: -15%;
  width: 50vw;
  height: 50vw;
  background: radial-gradient(circle, rgba(22, 119, 255, 0.06) 0%, rgba(114, 46, 209, 0.03) 50%, transparent 100%);
  filter: blur(100px);
}
```

- [ ] **Step 2: 更新 dot-grid 样式**

```css
.dot-grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--border-color) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(circle at 50% 50%, black, transparent 80%);
  opacity: 0.4;  /* 原生 opacity 控制 */
}
```

- [ ] **Step 3: 添加深色模式渐变**

```css
[data-mode='dark'] .mesh-gradient {
  background: radial-gradient(circle, rgba(6, 182, 212, 0.06) 0%, rgba(139, 92, 246, 0.03) 50%, transparent 100%);
}
```

- [ ] **Step 4: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): reduce decorative background intensity for subtle glass effect"
```

---

### Task 7: 优化 Pro-tip 卡片（淡色渐变边框）

**Files:**
- Modify: `labs/_layouts/lab.html:351-359`（需找到现有位置）

- [ ] **Step 1: 更新 Pro-tip 卡片样式**

```css
.ad-card {
  margin-top: 28px;
  padding: 2px;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(22, 119, 255, 0.2), rgba(114, 46, 209, 0.2));
}

.ad-card h3 {
  margin: 14px 16px 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
}

.ad-card p {
  margin: 0 16px 14px;
  font-size: 12px;
  color: var(--text-sec);
  line-height: 1.5;
}
```

- [ ] **Step 2: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "refactor(ai-lab): update pro-tip card with subtle gradient border"
```

---

### Task 8: 测试所有交互状态

**Files:**
- Modify: 无文件变更

- [ ] **Step 1: 启动本地 Jekyll 服务并打开页面**

```bash
bundle exec jekyll serve
# 打开 http://localhost:4000/labs/ai-lab/
```

- [ ] **Step 2: 验证浅色模式**

- [ ] Header 高度 56px，图标按钮无文字
- [ ] 侧边栏 Toggle 按钮可见且可点击
- [ ] 消息气泡圆角 20px，玻璃效果若隐若现
- [ ] 输入框圆角 24px，focus 时有蓝紫光晕
- [ ] 装饰背景几乎不可见

- [ ] **Step 3: 验证侧边栏展开/收起**

- [ ] 点击 Toggle 按钮，侧边栏 350ms 滑入
- [ ] 遮罩淡入
- [ ] 再次点击，侧边栏滑出
- [ ] 遮罩淡出
- [ ] 聊天区宽度平滑过渡

- [ ] **Step 4: 验证深色模式**

- [ ] 开启深色模式
- [ ] 背景变为 `#111112`
- [ ] 玻璃面板更透明（75-85%）
- [ ] 边框更明显（0.08 透明度）
- [ ] 渐变光晕变为青色系

- [ ] **Step 5: 验证消息交互**

- [ ] 发送消息，新消息从下方 fade-in
- [ ] User 消息右对齐，背景蓝紫渐变
- [ ] Bot 消息左对齐，玻璃效果

- [ ] **Step 6: 提交**

```bash
git add labs/_layouts/lab.html
git commit -m "test(ai-lab): verify all interaction states in browser"
```

---

## Spec 覆盖检查

| 设计规范 | 覆盖任务 |
|----------|----------|
| CSS 变量系统（颜色/透明度/动效时间） | Task 1 |
| Header 重构（56px + 图标按钮 + Toggle） | Task 2 |
| 消息气泡（20px 圆角 + 92% 玻璃） | Task 3 |
| 悬浮输入框（24px 圆角 + focus 光晕） | Task 4 |
| 可收起侧边栏（340px + 动画 + 遮罩） | Task 5 |
| 精简装饰背景（点阵/渐变降低透明度） | Task 6 |
| Pro-tip 淡色渐变边框 | Task 7 |
| 深色模式适配 | Task 1, 5, 6 |

## 类型一致性检查

- 所有 `--transition-*` 变量在 `:root` 中统一定义
- 侧边栏状态通过 `open` class 切换，与 JS `sidebarOpen` 布尔值同步
- `command-bar-wrapper` 使用 `position: absolute`，确保在聊天区流式布局之上

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-ai-lab-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
