---
title: "Step 12: 状态管理架构"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/12-state-management/
---


> 分析日期: 2026-04-16
> 核心文件: state/AppStateStore.ts(569行, ~360字段), state/store.ts(35行), state/AppState.tsx(199行)

---

## 1. Store 架构

### 最小 Store 实现 (store.ts, 35 行)

```typescript
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

- 基于不可变状态更新函数
- `Object.is` 引用比较 — 更新器返回相同引用时不通知
- 可选 `onChange` 回调接收 `{newState, oldState}` 用于副作用桥接

### Mutation 流

```
setAppState(updater)  ──>  不可变状态更新  ──>  onChange 回调 (Bridge 推送)
    |
    v
subscribe(listeners)  ──>  React useSyncExternalStore  ──>  选择器比较  ──>  重渲染
```

---

## 2. AppState 字段分类 (~360+ 叶子字段)

### 设置/配置

| 字段 | 类型 | 用途 |
|------|------|------|
| `settings` | object | 用户设置 |
| `verbose` | boolean | 详细输出模式 |
| `mainLoopModel` | string | 当前模型 |
| `mainLoopModelForSession` | string | 会话模型 |
| `isBriefOnly` | boolean | 仅 brief 模式 |
| `fastMode` | boolean | 快速模式 |
| `effortValue` | number | 努力级别 |
| `advisorModel` | string | Advisor 模型 |
| `thinkingEnabled` | boolean | 思考模式 |

### UI/视图

| 字段 | 类型 | 用途 |
|------|------|------|
| `expandedView` | boolean | 展开视图 |
| `selectedIPAgentIndex` | number | 选中的 Agent 索引 |
| `viewSelectionMode` | string | 视图选择模式 |
| `footerSelection` | string | 底部选择 |
| `statusLineText` | string | 状态行文本 |
| `showTeammateMessagePreview` | boolean | 队友消息预览 |
| `spinnerTip` | string | 旋转器提示 |
| `activeOverlays` | Set | 活跃覆盖层 |

### 任务

| 字段 | 类型 | 用途 |
|------|------|------|
| `tasks` | Map | 任务列表 |
| `foregroundedTaskId` | string | 前台任务 ID |
| `viewingAgentTaskId` | string | 查看 Agent 任务 ID |
| `agentNameRegistry` | Map | Agent 名称注册表 |
| `remoteAgentTaskSuggestions` | array | 远程 Agent 任务建议 |

### MCP

| 字段 | 类型 | 用途 |
|------|------|------|
| `mcp.clients` | Map | MCP 服务器连接 |
| `mcp.tools` | array | MCP 工具 |
| `mcp.commands` | array | MCP 命令 |
| `mcp.resources` | Map | MCP 资源 |
| `mcp.pluginReconnectKey` | number | 插件重连密钥 |

### Bridge

| 字段 | 类型 | 用途 |
|------|------|------|
| `replBridgeEnabled` | boolean | Bridge 启用 |
| `replBridgeConnected` | boolean | Bridge 已连接 |
| `replBridgeSessionActive` | boolean | Bridge 会话活跃 |
| `replBridgeOutboundOnly` | boolean | 仅出站模式 |
| `replBridgeConnectUrl` | string | 连接 URL |
| `replBridgeSessionId` | string | 会话 ID |
| `replBridgeError` | string | 错误信息 |
| `replBridgePermissionCallbacks` | object | 权限回调 |

### 远程/助手

| 字段 | 类型 | 用途 |
|------|------|------|
| `remoteSessionUrl` | string | 远程会话 URL |
| `remoteConnectionStatus` | string | 远程连接状态 |
| `remoteBackgroundTaskCount` | number | 后台任务计数 |

### 团队/Swarm

| 字段 | 类型 | 用途 |
|------|------|------|
| `teamContext` | object | 团队上下文 |
| `standaloneAgentContext` | object | 独立 Agent 上下文 |
| `inbox` | array | 收件箱 |
| `workerSandboxPermissions` | Map | Worker 沙箱权限 |
| `pendingWorkerRequest` | object | 待处理 Worker 请求 |

### 其他

| 字段类别 | 字段示例 | 用途 |
|---------|---------|------|
| 通知 | `notifications.current`, `notifications.queue` | Toast 通知队列 |
| 需求 | `elicitation.queue` | MCP 需求请求队列 |
| 权限 | `toolPermissionContext`, `denialTracking` | 权限模式和拒绝追踪 |
| 伴游 | `companionReaction`, `companionPetAt` | 伴游精灵反应 |
| 提示 | `promptSuggestion`, `promptSuggestionEnabled` | 输入路由和建议 |
| Agent | `agent`, `kairosEnabled` | Agent 身份和助手模式 |
| 文件历史 | `fileHistory` | 文件快照追踪 |
| 归属 | `attribution` | Git 提交归属状态 |
| 待办 | `todos` | 每 Agent 待办列表 |
| Hooks | `sessionHooks` | 会话级 hook 状态 |
| 认证 | `authVersion` | 认证失效计数器 |
| 计划 | `pendingPlanVerification`, `isUltraplanMode`, `ultraplanPendingChoice` | 计划/Ultraplan 状态 |

---

## 3. React 集成

### useAppState(selector)

使用 `useSyncExternalStore` 实现无撕裂读取:
- 消费者通过 selector 订阅特定切片
- 只有选中的切片触发重渲染
- 选择器使用 `Object.is` 比较

### useSetAppState()

返回稳定的 `setState` 引用而不订阅 — 用于仅需写入不需要读取的组件

---

## 4. 与 Bootstrap State 的关系

| 特性 | AppState Store | Bootstrap State |
|------|---------------|-----------------|
| 存储位置 | `state/store.ts` 创建的 Store | `bootstrap/state.ts` 模块级变量 |
| React 集成 | Provider + useSyncExternalStore | 无 Provider，直接 getter 导入 |
| 访问方式 | `useAppState(selector)` | `getSessionId()`, `getCwd()` 等 |
| 变更通知 | subscribe + onChange | `createSignal()` |
| 使用场景 | UI 状态、可变应用状态 | 会话 ID、项目根目录、成本追踪等不可变/极少变更值 |

**注释**: `bootstrap/state.ts` 中的注释 "DO NOT ADD MORE STATE HERE" 表明有意向 AppState 迁移。

---

## 5. 关键观察

1. **AppState 作为通信总线**: Bridge 写入 `replBridge*` 字段；UI 读取它们。MCP 连接填充 `mcp.*`；工具读取它们。这实际上是通过不可变状态更新中介的发布/订阅模型。

2. **权限回调字段**: `channelPermissionCallbacks` 和 `replBridgePermissionCallbacks` 是回调对象，使 AppState 成为数据和行为的混合体。

3. **360+ 字段膨胀**: AppState 已成为系统中最宽的类型定义，任何调用 `setAppState` 的模块必须了解其形状。