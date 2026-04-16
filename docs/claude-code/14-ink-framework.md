---
title: "Step 14: Ink 终端 UI 框架"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/14-ink-framework/
---


> 分析日期: 2026-04-16
> 核心目录: src/ink/ (~60+ 文件)
> 入口: src/ink.ts (公共 API 导出)

---

## 1. 渲染管线

```
React Tree (JSX)
    |
    v
[Stage 1: React Reconciler]  reconciler.ts
    |- createInstance -> DOM 节点 (ink-box, ink-text, ink-link...)
    |- createTextNode -> #text 节点
    |- appendChildNode/removeChildNode -> 树操作 + Yoga 树同步
    |- commitUpdate -> 属性差异应用
    |- resetAfterCommit -> scheduleRender() -> queueMicrotask(onRender)
    |
    v
[Stage 2: Yoga Layout]  layout/yoga.ts, layout/node.ts
    |- 纯 TypeScript 移植 (非 WASM)
    |- calculateLayout(terminalWidth) 计算所有节点位置/尺寸
    |- setMeasureFunc() 用于文本节点自然宽高计算
    |
    v
[Stage 3: 渲染到屏幕缓冲区]  renderer.ts
    |- renderNodeToOutput() 遍历 DOM 树
    |- 每个单元格: character + styleId + hyperlinkId
    |- CharPool: ASCII 快速路径 (Int32Array) + Unicode Map
    |- StylePool: @alcalzone/ansi-tokenize 样式内省
    |- HyperlinkPool: 链接字符串内省
    |- Grapheme clustering: Intl.Segmenter + 宽度计算
    |
    v
[Stage 4: 帧差异]  frame.ts
    |- 双缓冲: frontFrame / backFrame 交换
    |- 逐单元格整数 ID 比较 (O(1))
    |- 生成 Patch[]:
    |   stdout | clear | clearTerminal | cursorHide/Show |
    |   cursorMove | cursorTo | carriageReturn | hyperlink | styleStr
    |
    v
[Stage 5: 优化]  optimizer.ts
    |- 移除空 stdout
    |- 合并连续 cursorMove
    |- 折叠连续 cursorTo
    |- 连接相邻 styleStr
    |- 去重连续 hyperlink
    |- 取消 cursor hide/show 对
    |- 移除 count=0 的 clear
    |
    v
[Stage 6: 写入终端]  terminal.ts
    |- BSU/ESU (DEC 2026 同步更新) 包裹
    |- 所有 Patch 序列化为 ANSI 转义序列
    |- 单次 stdout.write() 调用
```

---

## 2. 自定义 Hooks

### Ink 专用 Hooks (无 React DOM 等价)

| Hook | 文件 | 用途 |
|------|------|------|
| `useInput` | hooks/use-input.ts | 键盘输入处理；raw mode + EventEmitter 注册；Ctrl+C 透传 |
| `useApp` | hooks/use-app.ts | 访问 Ink 应用控制 (exit/unmount) |
| `useStdin` | hooks/use-stdin.ts | 访问 stdin 流上下文 |
| `useAnimationFrame` | hooks/use-animation-frame.ts | 同步动画帧；返回 [ref, time]；终端失焦时减速 |
| `useAnimationTimer` | hooks/use-interval.ts | 基于时间间隔的动画更新 |
| `useInterval` | hooks/use-interval.ts | 基于 Clock 的间隔回调 (非 setInterval) |
| `useTerminalViewport` | hooks/use-terminal-viewport.ts | 检测组件是否在终端视口内 |
| `useTerminalFocus` | hooks/use-terminal-focus.ts | 检查终端窗口焦点 (DEC 1004) |
| `useTerminalTitle` | hooks/use-terminal-title.ts | 设置终端标签/窗口标题 (OSC 0) |
| `useTabStatus` | hooks/use-tab-status.ts | 标签状态指示器 (OSC 21337)；预设: idle(绿)/busy(橙)/waiting(蓝) |
| `useSelection` | hooks/use-selection.ts | 文本选择操作 (全屏模式) |
| `useHasSelection` | hooks/use-selection.ts | 响应式布尔值 — 选择创建/清除时重渲染 |
| `useSearchHighlight` | hooks/use-search-highlight.ts | 设置搜索高亮查询 |
| `useDeclaredCursor` | hooks/use-declared-cursor.ts | 声明光标停放位置 (IME 预编辑, 无障碍) |

### 共享动画时钟

Clock 系统 (components/ClockContext.tsx):
- `createClock(tickIntervalMs)`: 基于订阅者生命周期，至少一个 keepAlive 订阅者时运行 `setInterval`
- 同步 tick: 同一 tick 内所有订阅者看到相同 `tickTime`
- 焦点感知: 终端失焦时减速到 2x

---

## 3. 组件清单

| 组件 | 文件 | 用途 |
|------|------|------|
| **Box** | components/Box.tsx | 核心布局容器 (`display: flex`)；支持所有 flexbox 属性 + 事件: onClick, onFocus/onBlur, onKeyDown, onMouseEnter/onMouseLeave |
| **Text** | components/Text.tsx | 文本显示；color, backgroundColor, bold, dim, italic, underline, strikethrough, inverse, wrap 模式 (wrap/wrap-trim/truncate/middle/end/start) |
| **Button** | components/Button.tsx | 交互按钮；焦点管理 + 键盘交互 |
| **ScrollBox** | components/ScrollBox.tsx | 可滚动容器；overflowY: 'scroll'，鼠标滚轮，scrollTop，DECSTBM 优化 |
| **AlternateScreen** | components/AlternateScreen.tsx | 终端备用屏幕缓冲区 (DEC 1049)；SGR 鼠标追踪；`useInsertionEffect` 确保在 resetAfterCommit 前触发 |
| **Link** | components/Link.tsx | 终端超链接 (OSC 8)；不支持时回退到纯文本 |
| **Newline** | components/Newline.tsx | 插入 N 个换行符 |
| **Spacer** | components/Spacer.tsx | 弹性空间 (`<Box flexGrow={1} />`) |
| **NoSelect** | components/NoSelect.tsx | 排除内容不被选择 |
| **RawAnsi** | components/RawAnsi.js | 直接渲染原始 ANSI 转义序列 |
| **Ansi** | Ansi.js | ANSI 文本解析和渲染 |
| **ThemedBox/ThemedText** | design-system/ | 主题感知包装器；ink.ts 导出的公共 API |

---

## 4. Yoga 布局引擎集成

### 架构 (适配器模式)

```
LayoutNode (interface, node.ts)
    |- 纯 TypeScript 接口定义所有布局操作
    |- 解耦 Ink 与具体布局引擎实现
    |
YogaLayoutNode (yoga.ts)
    |- 具体实现，包装 Facebook Yoga
    |- 查找表: EDGE_MAP, GUTTER_MAP, FLEX_DIRECTION_MAP 等
    |- 映射 LayoutNode 调用到 Yoga API
    |
createLayoutNode() (engine.ts)
    |- 工厂函数，当前始终创建 YogaLayoutNode
```

### 关键设计决策

- **纯 TypeScript Yoga (非 WASM)**: 同步布局计算，零 WASM 内存管理
- **Yoga 节点附加到 DOM 节点**: 每个 DOMElement 有 `yogaNode` 属性
- **每帧计算一次**: `calculateLayout(width)` 在 `resetAfterCommit` 中调用
- **文本度量函数**: `setMeasureFunc()` 基于 grapheme 分段和换行

### 支持的 CSS Flexbox 属性

flexDirection, flexWrap, justifyContent, alignItems, alignSelf, flexGrow, flexShrink, flexBasis, width, height, min/max Width/Height, padding (all edges), margin (all edges), border, gap/columnGap/rowGap, position (relative/absolute), display (flex/none), overflow (visible/hidden/scroll), textWrap 变体

---

## 5. 终端 I/O 协议解析

### 两层解析器

**Layer 1: Tokenizer** (termio/tokenize.ts) — 转义序列边界检测

状态机分词器，将原始终端输入分为:
- `{ type: 'text', value: string }` — 纯文本块
- `{ type: 'sequence', value: string }` — 原始转义序列

状态: ground, escape, escapeIntermediate, csi, ss3, osc, dcs, apc

**Layer 2: Parser** (termio/parser.ts) — 语义动作生成

消耗 token，生成结构化 Action 对象:

```
Action =
  | { type: 'text'; graphemes: Grapheme[]; style: TextStyle }
  | { type: 'sgr'; params: string }
  | { type: 'cursor'; action: CursorAction }
  | { type: 'erase'; action: EraseAction }
  | { type: 'scroll'; action: ScrollAction }
  | { type: 'mode'; action: ModeAction }
  | { type: 'link'; action: LinkAction }
  | { type: 'title'; action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'bell' }
  | { type: 'unknown'; sequence: string }
```

### 子模块

| 模块 | 文件 | 用途 |
|------|------|------|
| `ansi.ts` | C0 控制码, ESC 类型字节, 分隔符常量 |
| `csi.ts` | CSI 字节范围检查, 命令枚举, 输出生成器 (光标移动/擦除/滚动/鼠标) |
| `dec.ts` | DEC 私有模式号和预生成序列: BSU/ESU, EBP/DBP, EFE/DFE, 光标显示, 备用屏幕 |
| `osc.ts` | OSC 序列生成和解析: 标题(0/1/2), 超链接(8), 剪贴板(52), iTerm2(9), 标签状态(21337) |
| `sgr.ts` | SGR 参数解释，应用于 TextStyle |
| `esc.ts` | ESC 序列解析 |
| `types.ts` | 语义类型: Color, NamedColor, TextStyle, UnderlineStyle, Grapheme, Action 变体 |

### 按键输入处理管线

```
stdin raw bytes
    |
    v
inputToString() -- Buffer 到字符串 (高 bit meta key)
    |
    v
Tokenizer (x10Mouse: true) -- 边界检测
    |
    v
parseMultipleKeypresses() -- 状态机处理
    +-- PASTE_START/END -> 括号粘贴组装 -> createPasteKey()
    +-- 终端响应 -> parseTerminalResponse() (DECRPM, DA1/DA2, 光标位置等)
    +-- 鼠标事件 -> parseMouseEvent() -> SGR 鼠标 (CSI <)
    +-- 常规键 -> parseKeypress()
            Kitty 键盘协议 (CSI u), modifyOtherKeys (CSI 27;mod;key~),
            功能键, meta 键, 常规字符输入
    |
    v
ParsedInput[] = ParsedKey | PasteKey | TerminalResponse | MouseEvent
```

---

## 6. 性能优化

### 双缓冲

Ink 类维护两个帧缓冲区 (`frontFrame` 和 `backFrame`)。每帧:
1. 新内容渲染到 back 缓冲区
2. front 和 back 交换
3. 计算旧 front 和新 front 之间的差异

### 屏幕差异

Screen 数据结构使用内省整数 ID:
- **CharPool**: ASCII 快速路径 `Int32Array` (0-127 直接索引) + Unicode Map
- **StylePool**: 样式 ID 间的转换字符串缓存 `StylePool.transition(fromId, toId)`，预热后零分配
- **HyperlinkPool**: 相同模式，索引 0 = 无链接

差异比较逐单元格进行，使用 O(1) 整数比较而非字符串比较。

### DECSTBM 滚动优化

在备用屏幕模式中，渲染器使用 `scrollHint` 检测整个内容是否滚动，并发出 DECSTBM 序列 + 滚动序列代替重绘所有行。

### 批处理

- `resetAfterCommit` 通过 `queueMicrotask` 延迟 `onRender`，自然批处理多个状态更新
- `writeDiffToTerminal` 将所有输出缓冲到单个字符串，最小化 `stdout.write` 调用到每帧恰好一次

### 同步输出 (DEC 2026)

当终端支持时，BSU/ESU 包裹帧输出，告诉终端在 ESU 前保持渲染，防止部分帧闪烁。tmux 下不使用。

### 池管理

- `resetPools()`: 每 5 分钟替换 char/hyperlink 池以防止无限增长
- `CharPool` 使用 `Int32Array` ASCII 快速路径
- `StylePool` 缓存 (fromId, toId) 键控的转换字符串

### 终端能力检测

| 能力 | 检测方法 |
|------|---------|
| 同步输出 (DEC 2026) | TERM_PROGRAM/TERM 环境变量检查 (iTerm2, WezTerm, Warp, ghostty 等)；tmux 下排除 |
| 进度报告 (OSC 9;4) | ConEmu 环境变量, Ghostty >= 1.2.0, iTerm2 >= 3.6.6 |
| 扩展键 (Kitty/modifyOtherKeys) | 白名单终端: iTerm2, kitty, WezTerm, ghostty, tmux, Windows Terminal |
| XTVERSION 检测 | 异步探测 CSI > 0 q -> DCS 回复 |
| xterm.js 检测 | TERM_PROGRAM === 'vscode' 或 XTVERSION 名称以 'xterm.js' 开头 |