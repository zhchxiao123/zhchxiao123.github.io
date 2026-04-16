---
title: "Step 3: 模块通信机制分析"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/03-communication-channels/
---


> 分析日期: 2026-04-16
> 核心文件: AppStateStore.ts, store.ts, AppState.tsx, context/*, signal.ts, bridgeMessaging.ts, toolHooks.ts

---

## 1. 通信机制清单

### 1.1 AppState Store（中央状态总线）

**文件**: `src/state/AppStateStore.ts`（类型定义）, `src/state/store.ts`（store 原语）, `src/state/AppState.tsx`（React 绑定）

AppState Store 是最重要的通信机制。基于 `createStore<T>` 构建，提供 `getState()`, `setState(updater)`, `subscribe(listener)` —— 类似 Redux 但更简洁：无 reducer、无 action、无中间件，只有不可变状态更新函数。

**Store 原语** (`store.ts`):
```typescript
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

状态更新使用 `Object.is` 引用比较 —— 如果更新器返回相同引用，订阅者不会被通知。可选的 `onChange` 回调接收 `{newState, oldState}` 用于副作用桥接（Bridge 用此将状态推送到 CCR）。

**AppState 字段分类（~70+ 顶层键, ~360+ 叶子字段）**:

| 域 | 字段 | 用途 |
|----|------|------|
| **设置/配置** | `settings`, `verbose`, `mainLoopModel`, `mainLoopModelForSession`, `isBriefOnly`, `fastMode`, `effortValue`, `advisorModel`, `thinkingEnabled` | 配置状态 |
| **UI/视图** | `expandedView`, `selectedIPAgentIndex`, `coordinatorTaskIndex`, `viewSelectionMode`, `footerSelection`, `statusLineText`, `showTeammateMessagePreview`, `spinnerTip`, `activeOverlays` | 视图路由和显示状态 |
| **任务** | `tasks`, `foregroundedTaskId`, `viewingAgentTaskId`, `agentNameRegistry`, `remoteAgentTaskSuggestions` | 任务生命周期和路由 |
| **MCP** | `mcp.clients`, `mcp.tools`, `mcp.commands`, `mcp.resources`, `mcp.pluginReconnectKey` | MCP 服务器连接及其工具 |
| **插件** | `plugins.enabled`, `plugins.disabled`, `plugins.commands`, `plugins.errors`, `plugins.installationStatus`, `plugins.needsRefresh` | 插件系统状态 |
| **Bridge** | `replBridgeEnabled`, `replBridgeExplicit`, `replBridgeOutboundOnly`, `replBridgeConnected`, `replBridgeSessionActive`, `replBridgeReconnecting`, `replBridgeConnectUrl`, `replBridgeSessionUrl`, `replBridgeEnvironmentId`, `replBridgeSessionId`, `replBridgeError`, `replBridgeInitialName`, `replBridgePermissionCallbacks`, `showRemoteCallout`, `channelPermissionCallbacks` | 常驻 Bridge（claude.ai 远程控制） |
| **远程** | `remoteSessionUrl`, `remoteConnectionStatus`, `remoteBackgroundTaskCount` | 远程/助手模式 WebSocket 状态 |
| **团队/Swarm** | `teamContext`, `standaloneAgentContext`, `inbox`, `workerSandboxPermissions`, `pendingWorkerRequest`, `pendingSandboxRequest` | 多 Agent swarm 通信 |
| **Tmux/Tungsten** | `tungstenActiveSession`, `tungstenLastCapturedTime`, `tungstenLastCommand`, `tungstenPanelVisible`, `tungstenPanelAutoHidden` | 终端复用器面板 |
| **Web 浏览器 (Bagel)** | `bagelActive`, `bagelUrl`, `bagelPanelVisible` | 嵌入式浏览器工具 |
| **计算机使用** | `computerUseMcpState`（含 `allowedApps`, `grantFlags`, `lastScreenshotDims`, `hiddenDuringTurn`, `selectedDisplayId`, `displayPinnedByModel`, `displayResolvedForApps`） | 屏幕自动化 |
| **推测执行** | `speculation`, `speculationSessionTimeSavedMs` | 推测执行状态 |
| **通知** | `notifications.current`, `notifications.queue` | Toast 通知队列 |
| **需求** | `elicitation.queue` | MCP 需求请求队列 |
| **权限** | `toolPermissionContext`, `denialTracking` | 权限模式和拒绝追踪 |
| **伴游/Buddy** | `companionReaction`, `companionPetAt` | 伴游精灵反应 |
| **提示/输入** | `promptSuggestion`, `promptSuggestionEnabled`, `initialMessage` | 输入路由和建议 |
| **Agent/模式** | `agent`, `kairosEnabled` | Agent 身份和助手模式 |
| **文件历史** | `fileHistory` | 文件快照追踪 |
| **归属** | `attribution` | Git 提交归属状态 |
| **待办** | `todos` | 每 Agent 待办列表 |
| **Hooks** | `sessionHooks` | 会话级 hook 状态 |
| **认证** | `authVersion` | 认证失效计数器 |
| **REPL 上下文** | `replContext`（含 `vmContext`, `registeredTools`, `console`） | REPL 工具 VM 状态 |
| **计划/模式** | `pendingPlanVerification`, `isUltraplanMode`, `ultraplanLaunching`, `ultraplanSessionUrl`, `ultraplanPendingChoice`, `ultraplanLaunchPending` | 计划模式和 ultraplan 状态 |
| **技能改进** | `skillImprovement.suggestion` | 技能增强建议 |

**React 集成**: `useAppState(selector)` 使用 `useSyncExternalStore` 实现无撕裂读取。`useSetAppState()` 返回稳定的 `setState` 引用而不订阅。`useAppStateMaybeOutsideOfProvider()` 为可能在 provider 树外渲染的组件提供安全回退。

**耦合级别**: **松散** —— 消费者通过 selector 订阅特定切片；只有选中的切片触发重渲染。但生产者与类型定义紧密耦合（任何调用 `setAppState` 的模块必须了解其形状）。

---

### 1.2 Bootstrap State（模块级单例）

**文件**: `src/bootstrap/state.ts`

这是一个独立于 AppState 的全局可变状态对象。存储会话级不可变或极少变更的值：`sessionId`, `projectRoot`, `originalCwd`, `isInteractive`, 成本追踪（`totalCostUSD`, 模型使用），注册的 hooks，设置引用，遥测等。使用 `createSignal()` 进行变更通知。

与 AppState 的关键区别：
- **模块级单例** —— 无 React context，任何代码无需 provider 即可访问
- **命令式读/写** —— `getSessionId()`, `getCwd()`, `getMainThreadAgentType()` 等
- **基于 Signal 的通知** —— `createSignal()` 用于特定状态变更（如设置变更）

**耦合级别**: **紧密** —— 整个代码库直接从 `bootstrap/state.js` 导入。无抽象层；每个消费者直接调用 getter 函数。

---

### 1.3 React Context 系统

9 个 React Context provider，各自服务特定领域：

| Context | 文件 | 提供 | 消费者 | 耦合 |
|---------|------|------|--------|------|
| **AppStoreContext** | `state/AppState.tsx` | AppState store 引用 | `useAppState()`, `useSetAppState()`, `useAppStateStore()` | 松散 —— 基于 selector 的订阅 |
| **MailboxContext** | `context/mailbox.tsx` | `Mailbox` 实例（Agent 间消息队列） | `useMailbox()` | 中等 —— 单对象，但窄 API |
| **VoiceContext** | `context/voice.tsx` | `Store<VoiceState>`（语音录制状态） | `useVoiceState()`, `useSetVoiceState()`, `useGetVoiceState()` | 松散 —— 基于 selector 的 `useSyncExternalStore` |
| **StatsContext** | `context/stats.tsx` | `StatsStore`（性能指标） | `useStats()`, `useCounter()`, `useGauge()`, `useTimer()`, `useSet()` | 中等 —— 函数式 API，无订阅 |
| **PromptOverlayContext** | `context/promptOverlayContext.tsx` | 4 个 context（data, setData, dialog, setDialog）用于浮动覆盖层 | `usePromptOverlay()`, `useSetPromptOverlay()`, `usePromptOverlayDialog()`, `useSetPromptOverlayDialog()` | 松散 —— 分离 data/setter context 防止重渲染 |
| **ModalContext** | `context/modalContext.tsx` | Modal 槽位大小 + 滚动引用 | `useIsInsideModal()`, `useModalOrTerminalSize()`, `useModalScrollRef()` | 中等 —— 直接值读取 |
| **OverlayContext** | `context/overlayContext.tsx` | 委托到 `AppState.activeOverlays` | `useRegisterOverlay()`, `useIsOverlayActive()`, `useIsModalOverlayActive()` | 松散 —— 回退到 AppState |
| **QueuedMessageContext** | `context/QueuedMessageContext.tsx` | `isQueued`, `isFirst`, `paddingWidth` 用于消息布局 | `useQueuedMessage()` | 紧密 —— 简单值传播 |
| **FpsMetricsContext** | `context/fpsMetrics.tsx` | FPS 指标获取函数 | `useFpsMetrics()` | 松散 —— 稳定 getter 引用 |

**Provider 嵌套**（来自 `AppState.tsx`）:
```
AppStateProvider
  -> HasAppStateContext
  -> AppStoreContext
  -> MailboxProvider
  -> VoiceProvider
```

---

### 1.4 Signal 系统（轻量级发布/订阅）

**文件**: `src/utils/signal.ts`

用于纯事件信号的最小监听器集合原语，无存储状态。设计用于"某事发生了"的通知，而非"当前值是什么"的查询。

```typescript
export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}
```

**在 18 个文件中使用**，用于各种事件通道：
- `utils/settings/changeDetector.ts` —— 设置文件变更通知
- `utils/skills/skillChangeDetector.ts` —— 技能目录变更通知
- `utils/messageQueueManager.ts` —— 命令队列变更通知
- `utils/mailbox.ts` —— mailbox 修订变更通知
- `utils/awsAuthStatusManager.ts` —— AWS 认证状态变更
- `utils/classifierApprovals.ts` —— 分类器审批事件
- `utils/fastMode.ts` —— 快速模式切换事件
- `utils/QueryGuard.ts` —— 查询守卫状态变更
- `hooks/fileSuggestions.ts` —— 文件建议更新
- `hooks/useTasksV2.ts` —— 任务状态变更通知
- `keybindings/loadUserBindings.ts` —— 键绑定重载通知
- `services/analytics/growthbook.ts` —— 特性开关更新
- `skills/loadSkillsDir.ts` —— 技能加载事件
- `utils/suggestions/slackChannelSuggestions.ts` —— Slack 频道建议
- `utils/tasks.ts` —— 任务状态事件
- `utils/claudeCodeHints.ts` —— 提示状态变更
- `bootstrap/state.ts` —— 各种 bootstrap 状态变更 signal

**耦合级别**: **松散** —— 生产者和消费者完全解耦。生产者发射；订阅者被调用。无共享状态引用。

---

### 1.5 EventEmitter（Ink 终端 UI）

**文件**: `src/ink/events/emitter.ts`, `src/ink/events/event.ts`

自定义 `EventEmitter`，扩展 Node 的 `EventEmitter`，支持通过自定义 `Event` 类实现 `stopImmediatePropagation()`。专用于 Ink 终端 UI 层的键盘输入路由、焦点管理和终端事件传播。

`Event` 类提供 DOM 风格的 `stopImmediatePropagation()` 语义，用于优先级事件处理（如 modal 可以在主输入处理器之前停止按键事件传播）。

**耦合级别**: **松散** —— 基于事件；生产者发射命名事件，消费者注册监听器。但 Ink 特定的 EventEmitter 在 Ink 渲染树内全局共享。

---

### 1.6 Hook 系统（Shell 命令 Hooks）

**文件**: `src/utils/hooks.ts`（执行引擎）, `src/services/tools/toolHooks.ts`（工具集成层）

Hook 系统是用户定义的 shell 命令执行管线，在特定生命周期点运行。它不是事件系统 —— 而是**同步请求/响应管线**，具有明确定义的拦截点：

**Hook 事件**（生命周期拦截点）:
- `PreToolUse` —— 工具执行前；可允许/拒绝/修改输入
- `PostToolUse` —— 工具成功后；可修改输出、阻止继续
- `PostToolUseFailure` —— 工具失败后
- `Notification` —— 会话通知时
- `Stop` —— 会话结束前
- `SubagentStop` —— 子 Agent 结束前

**数据流**:
1. `executePreToolHooks()` / `executePostToolHooks()` 生成子进程，通过 stdin 传入 JSON 输入
2. Hook 进程在 stdout 返回 JSON，包含 `permissionBehavior`（allow/deny/ask）、`updatedInput`、`blockingError`、`additionalContexts`、`preventContinuation`
3. `runPreToolUseHooks()` 和 `runPostToolUseHooks()` 在 `toolHooks.ts` 中是**异步生成器**，将类型化结果回传给工具执行循环
4. `resolveHookPermissionDecision()` 合并 hook 决策与基于规则的权限（hook 不能覆盖 settings.json 中的 `deny` 规则）

**耦合级别**: **中等** —— hook 执行引擎与工具执行管线（`ToolUseContext`）紧密耦合，但实际 hook 定义是外部的（用户 shell 命令），因此与代码库最大程度解耦。

---

### 1.7 MCP 协议（Model Context Protocol）

**文件**: `src/services/mcp/types.ts`

MCP 定义与外部工具服务器通信的协议。使用 `@modelcontextprotocol/sdk` 客户端库，支持多种传输类型：

**传输类型**: `stdio`, `sse`, `sse-ide`, `http`, `ws`, `ws-ide`, `sdk`, `claudeai-proxy`

**连接状态**（可辨识联合）:
- `ConnectedMCPServer` —— 活跃连接，含客户端、能力、清理函数
- `FailedMCPServer` —— 连接失败，含错误
- `NeedsAuthMCPServer` —— 需要 OAuth 认证
- `PendingMCPServer` —— 正在重连
- `DisabledMCPServer` —— 用户禁用

**数据流**:
1. MCP 服务器配置从设置加载（settings.json 中的 `mcpServers`）
2. `useManageMCPConnections` 建立连接并填充 `AppState.mcp`
3. 已连接的 MCP 服务器暴露工具、命令和资源
4. MCP 工具集成到标准 `Tool` 抽象和 `ToolUseContext` 管线
5. 来自 MCP 服务器的需求请求流入 `AppState.elicitation.queue`
6. `channelPermissionCallbacks` 支持通过消息通道的权限提示

**耦合级别**: **松散** —— MCP 服务器是通过明确定义协议通信的外部进程。SDK 处理序列化/反序列化。内部代码只需了解 `MCPServerConnection` 类型。

---

### 1.8 Bridge 消息传递（claude.ai 远程控制）

**文件**: `src/bridge/bridgeMessaging.ts`

Bridge 支持本地 CLI 会话与 claude.ai（或 SDK 消费者）之间的双向通信。使用 WebSocket/SSE 传输进行实时消息流。

**通过 Bridge 流动的消息类型**:
- **出站**: `user` 和 `assistant` 消息，`system/local_command` 事件（转发到 claude.ai 显示）
- **入站**: 来自 claude.ai 的 `user` 消息（发送到 CLI 的提示），`control_request` 和 `control_response` 消息

**控制请求子类型**（服务器 -> CLI）:
- `initialize` —— 会话能力握手
- `set_model` —— 从 Web UI 切换模型
- `set_max_thinking_tokens` —— 思考预算控制
- `set_permission_mode` —— 权限模式变更
- `interrupt` —— 取消当前操作

**回声去重**: `BoundedUUIDSet` —— 基于循环缓冲区的 Set，当容量达到上限时驱逐最旧条目，防止服务器重放消息历史时的回声循环。

**耦合级别**: **松散** —— bridge 消息层是纯函数（不对 bridge 状态闭包）。所有协作者（传输、sessionId、回调）作为参数传入。`handleIngressMessage()` 和 `handleServerControlRequest()` 函数是纯路由器。

---

### 1.9 Mailbox（Agent 间消息队列）

**文件**: `src/utils/mailbox.ts`
**React 绑定**: `src/context/mailbox.tsx`

用于 Agent 间通信（队友/swarm 场景）的消息队列。支持：
- `send(msg)` —— 入队消息或分派给等待的接收者
- `poll(fn)` —— 同步非阻塞出队，带谓词匹配
- `receive(fn)` —— 异步阻塞出队，带谓词匹配（返回 Promise）
- `subscribe` —— 通过 `createSignal()` 变更通知

**消息类型**: `user`, `teammate`, `system`, `tick`, `task` —— 各含 `id`, `source`, `content`, `from`, `color`, `timestamp`。

**耦合级别**: **中等** —— Mailbox 实例通过 React Context 提供，但直接访问。生产者和消费者共享相同的 `Mailbox` 实例引用，但通过队列解耦。

---

### 1.10 命令队列（MessageQueueManager）

**文件**: `src/utils/messageQueueManager.ts`

模块级优先队列，管理所有用户输入、任务通知和孤立权限。这是馈送 REPL 主循环的统一命令队列。

**优先级级别**: `now` (0) > `next` (1) > `later` (2)。同级内 FIFO 排序。

**关键操作**: `enqueue()`, `enqueuePendingNotification()`, `dequeue(filter?)`, `dequeueAll()`, `peek()`, `popAllEditable()`, `clearCommandQueue()`.

**React 集成**: `subscribeToCommandQueue` / `getCommandQueueSnapshot` 兼容 `useSyncExternalStore`，允许 React 组件订阅队列变更而无需直接耦合。

**耦合级别**: **松散** —— 模块级单例，带 `createSignal()` 通知。非 React 代码直接读取；React 代码通过 `useSyncExternalStore` 订阅。

---

### 1.11 ToolUseContext（上下文对象模式）

**文件**: `src/Tool.ts`

`ToolUseContext` 是传递给每个工具执行的参数对象。它不是全局通信机制，但它是工具与系统其余部分通信的**主要通道**。

**ToolUseContext 中的关键通道**:
- `getAppState()` / `setAppState()` —— 读/写中央 store
- `abortController` —— 取消信号
- `options` —— 模型、工具列表、命令、MCP 客户端
- `addNotification()` —— 推送 UI 通知
- `appendSystemMessage()` —— 向对话添加系统消息
- `setToolJSX()` —— 设置工具特定的 UI 渲染
- `handleElicitation()` —— MCP 需求处理器
- `sendOSNotification()` —— OS 级通知
- `requireCanUseTool` —— 权限门控
- `setInProgressToolUseIDs()` —— 追踪活跃工具
- `setStreamMode()` —— 控制旋转器模式

**耦合级别**: **紧密** —— 每个工具直接依赖此类型。但作为参数传入（依赖注入）而非全局访问，使其可测试且可组合。

---

## 2. 数据流图

```
                             ┌──────────────────────────────────────────────┐
                             │           外部边界                           │
                             │                                              │
                             │  ┌────────┐  ┌──────────┐  ┌────────────┐  │
                             │  │  用户  │  │ claude.ai│  │ MCP 服务器 │  │
                             │  │ (CLI)  │  │  (Bridge)│  │ (stdio/WS) │  │
                             │  └───┬────┘  └────┬─────┘  └─────┬──────┘  │
                             │      │            │              │          │
                             └──────┼────────────┼──────────────┼──────────┘
                                    │            │              │
                    ┌───────────────▼──┐    ┌───▼────────┐  ┌──▼──────────┐
                    │  命令队列        │    │   Bridge    │  │  MCP 客户端 │
                    │  (优先级 FIFO)   │    │  消息传递   │  │  (SDK)      │
                    │  [messageQueue   │    │  [bridge    │  │  [mcp/      │
                    │   Manager.ts]    │    │   Messaging]│  │   client.ts]│
                    └───────┬──────────┘    └──────┬──────┘  └──────┬──────┘
                            │                      │                │
                            ▼                      ▼                ▼
                ┌───────────────────────────────────────────────────────┐
                │                    APP STATE STORE                   │
                │  [AppStateStore.ts / store.ts]                        │
                │                                                       │
                │  ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────────┐│
                │  │ tasks    │ │ mcp.*   │ │ bridge │ │ notifications││
                │  │ todos    │ │ plugins │ │ state  │ │ queue       ││
                │  │ inbox    │ │ permCtx │ │ remote │ │ elicitation  ││
                │  │ agent*   │ │ history │ │ team   │ │ speculation  ││
                │  │ UI state │ │ settings│ │ CU mcp │ │ ...          ││
                │  └──────────┘ └─────────┘ └────────┘ └─────────────┘│
                └───────────┬──────────────────────┬─────────────────┘
                            │                      │
              ┌─────────────▼──────┐     ┌─────────▼──────────┐
              │  React 组件       │     │  非 React 服务      │
              │  (useAppState)    │     │  (store.getState)   │
              │                   │     │                     │
              │  REPL.tsx         │     │  Bridge core        │
              │  PromptInput      │     │  Hook executor      │
              │  ToolPanel        │     │  Tool executor       │
              │  ScrollBox        │     │  MCP manager        │
              │  Footer           │     │  Task runner         │
              └───────────────────┘     └─────────────────────┘

                ┌────────────────────────────────────────────────────┐
                │              侧通道                               │
                │                                                  │
                │  Signals (createSignal):                         │
                │    settings-change, skill-change, queue-mutate,  │
                │    mailbox-change, auth-status, fast-mode-toggle │
                │                                                  │
                │  EventEmitter (Ink):                             │
                │    keydown, keypress, focus-change, input        │
                │                                                  │
                │  Bootstrap State (模块单例):                      │
                │    sessionId, cwd, cost, hooks, telemetry        │
                │                                                  │
                │  ToolUseContext (每工具参数对象):                 │
                │    getAppState, setAppState, abort, permissions  │
                │                                                  │
                │  Hook 系统 (子进程 IPC):                         │
                │    PreToolUse, PostToolUse, Stop, Notification   │
                │                                                  │
                │  Mailbox (Agent 间队列):                         │
                │    send, poll, receive, subscribe                │
                │                                                  │
                │  React Contexts:                                 │
                │    Voice, Stats, Modal, Overlay, PromptOverlay   │
                └────────────────────────────────────────────────────┘
```

---

## 3. 耦合分析

### 紧耦合（直接导入 / 共享类型）

| 机制 | 描述 | 风险 |
|------|------|------|
| **Bootstrap State** | 模块级单例，直接 getter 导入。~200+ 文件从 `bootstrap/state.ts` 导入 | 高：getter 签名变更会波及到处。无测试隔离，需 monkey-patch |
| **ToolUseContext** | 每个工具直接依赖此类型 | 中：参数注入缓解部分风险，但类型本身很宽（30+ 字段） |
| **QueuedMessageContext** | 简单值传播，无抽象 | 低：窄 API 面 |
| **AppState 类型定义** | 所有生产者和消费者必须了解其形状 | 高：新增字段涉及中央类型定义 |

### 中耦合（共享实例 / Context）

| 机制 | 描述 | 风险 |
|------|------|------|
| **Mailbox** | 通过 React Context 共享队列实例 | 中：生产者和消费者必须就消息格式达成一致 |
| **StatsStore** | 通过 React Context 的函数式 API | 低：窄接口，无状态形状耦合 |
| **VoiceStore** | 通过 React Context 的 Store<VoiceState>，基于 selector | 低：隔离域，selector 读取 |
| **Bridge 消息** | 带协作者参数的纯函数 | 低：bridge core 和调用者间无共享可变状态 |

### 松耦合（事件 / Signal / 协议）

| 机制 | 描述 | 风险 |
|------|------|------|
| **Signal 系统** | 生产者发射；订阅者被通知。无共享状态 | 最低：生产者和消费者完全独立 |
| **EventEmitter (Ink)** | 命名事件发布/订阅，带传播控制 | 低：按事件名解耦，但共享 emitter 引用 |
| **MCP 协议** | 通过 stdio/WS/SSE 的标准 JSON-RPC。外部服务器 | 最低：按协议规范完全解耦 |
| **AppState Store（消费端）** | 基于 selector 的订阅，消费者只依赖读取的切片 | 消费端低；生产端高（必须了解完整形状） |
| **命令队列** | 模块级，带基于 signal 的通知 | 低：明确定义的优先队列 API，useSyncExternalStore 集成 |
| **Hook 系统** | 通过 stdin/stdout JSON 通信的外部进程 | 最低：hook 完全在进程外部 |

---

## 4. 关键架构观察

1. **双状态系统**: AppState（React 优化，基于 selector）和 Bootstrap State（模块级命令式）。Bootstrap State 先于 AppState，处理 React 挂载前或非 React 代码必须访问的值。`bootstrap/state.ts` 中的注释 "DO NOT ADD MORE STATE HERE" 表明有意向 AppState 迁移。

2. **Signal 作为通用语**: `createSignal()` 原语已取代约 15 处重复的监听器集合样板代码。它是"某事变更了"通知的首选机制，无需完整 store。它在 React（通过 `useSyncExternalStore`）和非 React 代码间无缝桥接。

3. **AppState 作为通信总线**: 尽管是"状态 store"，AppState 实际上是模块间的主要通信总线。Bridge 写入 `replBridge*` 字段；UI 读取它们。MCP 连接填充 `mcp.*`；工具读取它们。任务更新 `tasks` 和 `foregroundedTaskId`；视图层响应。这实际上是通过不可变状态更新中介的发布/订阅模型。

4. **权限流是多通道的**: 权限决策在 4 个通道间竞争：本地 UI、bridge（claude.ai）、通道回调（Telegram/iMessage）和 hooks。AppState 中的 `channelPermissionCallbacks` 和 `replBridgePermissionCallbacks` 字段是回调对象，支持这些竞争 —— 它们不是纯数据，使得 AppState 成为数据和行为的混合体。

5. **Hook 系统是最解耦的机制**: 它通过 JSON stdin/stdout 与外部进程通信。这是唯一跨越进程边界的通信机制，完全独立于内部模块结构。

6. **Bridge 消息传递有意设计为纯函数**: `handleIngressMessage()` 和 `handleServerControlRequest()` 函数将所有协作者作为参数而非闭包引用 bridge 特定状态。此设计允许基于环境和无环境的 bridge core 共享相同的消息处理逻辑。

7. **命令队列解耦输入与处理**: 统一命令队列（`messageQueueManager.ts`）将输入源（用户输入、bridge 消息、任务通知）与处理它们的 REPL 主循环解耦。优先级排序确保用户输入永远不会被系统消息饥饿。