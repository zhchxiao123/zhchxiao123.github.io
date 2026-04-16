---
title: "Step 23: 模式与反模式编目"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/23-patterns/
---


> 分析日期: 2026-04-16
> 范围: 全代码库 1,884 文件

---

## 1. 设计模式

### 1.1 观察者模式 (Observer)

代码库使用三种不同的观察者/订阅-通知实现:

| 实现 | 文件 | 用途 | 使用量 |
|------|------|------|--------|
| Node EventEmitter 扩展 | `ink/events/emitter.ts` | Ink 终端 UI 事件系统 | Ink 内部 |
| 自定义 Signal 原语 | `utils/signal.ts` | 轻量级事件信号: `createSignal<Args>()` | 112 个文件 |
| WebSocket .on() 模式 | `remote/SessionsWebSocket.ts` 等 | 网络事件观察者 | WebSocket 连接 |

**Signal 系统**:
```typescript
createSignal<Args>() -> { subscribe, emit, clear }
```
注释称 "将代码库中重复约 15 次的模式折叠为一行"。用于: 设置变更检测、认证状态、技能变更、分类器审批、查询守卫、配置变更、邮箱桥接、优雅关闭等。

### 1.2 策略模式 (Strategy)

**权限处理器策略** (最突出):
- `hooks/toolPermission/handlers/interactiveHandler.ts` — 交互式权限流
- `hooks/toolPermission/handlers/coordinatorHandler.ts` — 协调器 Worker 流
- `hooks/toolPermission/handlers/swarmWorkerHandler.ts` — Swarm Worker 流
- 三者共享 `PermissionContext` 类型, 返回 `PermissionDecision | null`

**后端注册策略**:
- `utils/swarm/backends/registry.ts` — `detectAndGetBackend()` 检测运行时环境
- 接口: `TeammateExecutor` (spawn, sendMessage, terminate, kill, isActive)
- 实现: TmuxBackend, ITermBackend, InProcessBackend

**工具编排策略**:
- `services/tools/toolOrchestration.ts` — `partitionToolCalls()` 按并发安全分批
- `runToolsSerially()` vs `runToolsConcurrently()` — 运行时策略选择

### 1.3 工厂模式 (Factory)

| 工厂 | 文件 | 用途 |
|------|------|------|
| `buildTool` | `Tool.ts:757-792` | 核心工具工厂, 50+ 工具使用 |
| `getAllBaseTools` / `assembleToolPool` | `tools.ts` | 工具集组装 |
| `createLinkedTransportPair` | `services/mcp/InProcessTransport.ts` | 进程内 MCP 传输对 |
| `getCommands(cwd)` | `commands.ts` | 命令集懒加载组装 |
| `createPermissionContext` | `hooks/toolPermission/PermissionContext.ts` | 权限上下文创建 |
| `createCronScheduler` | `utils/cronScheduler.ts` | Cron 调度器创建 |

**buildTool 工厂类型精确保留**:
```typescript
buildTool<D extends AnyToolDef>(def: D): BuiltTool<D>
// AnyToolDef = ToolDef<any, any, any> — 类型级展开保留精确类型
```

### 1.4 代理模式 (Proxy)

| 代理 | 文件 | 用途 |
|------|------|------|
| MCP Claude.ai 代理 | `services/mcp/client.ts:364-403` | `createClaudeAiProxyFetch()` — OAuth 令牌附加 |
| CCR 上游代理 | `upstreamproxy/upstreamproxy.ts` | CONNECT-to-WebSocket 中继 |
| 进程内传输 | `services/mcp/InProcessTransport.ts` | MCP 消息的 queueMicrotask 传递 |
| SDK 控制传输 | `services/mcp/SdkControlTransport.ts` | SDK MCP 传输代理 |

### 1.5 命令模式 (Command)

整个斜杠命令系统是命令模式实现:

| 类型 | 定义 | 行为 |
|------|------|------|
| `PromptCommand` | type: 'prompt' | 注入提示文本 |
| `LocalCommand` | type: 'local' | 执行本地处理函数 |
| `LocalJSXCommand` | type: 'local-jsx' | 渲染 JSX 组件 |

每个命令有: `name`, `description`, `isEnabled()`, `load()` (懒加载执行)。

### 1.6 迭代器模式 (Async Generator)

异步生成器是代码库的主要流式原语, **使用极其广泛**:

| 生成器 | 文件 | 用途 |
|--------|------|------|
| `query()` | `query.ts` | 主查询循环 |
| `runToolUse()` | `services/tools/toolExecution.ts` | 工具执行流式结果 |
| `runPreToolUseHooks()` | `services/tools/toolHooks.ts` | Pre-hook 处理 |
| `runPostToolUseHooks()` | `services/tools/toolHooks.ts` | Post-hook 处理 |
| `runTools()` / `runToolsSerially()` / `runToolsConcurrently()` | `services/tools/toolOrchestration.ts` | 工具编排 |
| `getRemainingResults()` | `services/tools/StreamingToolExecutor.ts` | 流式工具结果 |
| `queryModelWithStreaming()` / `queryModel()` | `services/api/claude.ts` | API 流式 |
| `withRetry()` | `services/api/withRetry.ts` | 重试包装 |
| `runAgent()` | `tools/AgentTool/runAgent.ts` | Agent 执行 |
| `withStreamingVCR()` | `services/vcr.ts` | VCR 录制/回放 |
| `runShellCommand()` | `tools/BashTool/BashTool.tsx` | Shell 命令流式输出 |

### 1.7 装饰器模式 (Hook 系统作为中间件)

```
工具执行请求
    |
    v
executePreToolHooks()  -- Pre-hook 装饰器
    |-- 可修改输入 (updatedInput)
    |-- 可改变权限决策 (permissionBehavior)
    |-- 可阻止执行 (blockingError)
    |-- 可注入额外上下文
    |
    v
tool.call()  -- 实际工具执行
    |
    v
executePostToolHooks()  -- Post-hook 装饰器
    |-- 可修改输出 (updatedMcpToolOutput)
    |-- 可阻止返回 (blockingError)
    |-- 可追加消息
```

`withRetry()` 和 `withStreamingVCR()` 也是装饰器模式, 分别包装 API 调用的重试逻辑和录制/回放能力。

### 1.8 状态机模式

**Vim 模式状态机** (最显式):
- 顶层: `VimState = { mode: 'INSERT' } | { mode: 'NORMAL'; command: CommandState }`
- 11 个命令子状态: idle, count, operator, operatorCount, operatorFind, operatorTextObj, find, g, operatorG, replace, indent
- TypeScript 可辨识联合确保穷尽处理
- 每个状态一个转换函数: `fromIdle()`, `fromCount()`, `fromOperator()` 等

**StreamingToolExecutor 状态机**:
- `ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'`
- 转换: queued -> executing -> completed -> yielded

**权限决策状态机** (隐式):
- `PermissionDecision = Allow | Deny | Ask`
- 多决策源: hook, user, classifier, rule

---

## 2. 反模式

### 2.1 超长函数 (>200 行)

27+ 个超过 200 行的函数。最严重的 5 个:

| 函数 | 文件 | 行数 | 影响 |
|------|------|------|------|
| `REPL` 组件 | screens/REPL.tsx | 4,433 | 不可测试、不可维护 |
| `run()` | main.tsx | 3,629 | 所有启动逻辑混合 |
| `runHeadlessStreaming()` | cli/print.ts | 3,167 | 流式/权限/MCP 混合 |
| `initBridgeCore()` | bridge/replBridge.ts | 1,579 | 传输/重连/消息混合 |
| `runBridgeLoop()` | bridge/bridgeMain.ts | 1,439 | 连接/心跳/状态混合 |

### 2.2 特性开关膨胀

**120 个 `feature()` 调用跨 30 个文件**。最严重的:

| 文件 | feature() 调用数 | 问题 |
|------|-------------------|------|
| `tools/BashTool/bashPermissions.ts` | 25 | 控制流极难追踪 |
| `query.ts` | 23 | 多个内联三元表达式 |
| `commands.ts` | 多个条件导入 | 编译时条件模块加载 |

`bashPermissions.ts` 的 25 个 feature 调用使权限逻辑的静态分析几乎不可能。

### 2.3 过多 `any` 使用

**总计约 55 处** 跨 24 个文件。关键位置:

| 文件 | 情况 | 严重性 |
|------|------|--------|
| `Tool.ts` | `AnyToolDef = ToolDef<any, any, any>` | 中 — buildTool 的类型约束 |
| `main.tsx` | `(global as any).require('inspector')` | 低 — 特殊调试路径 |
| `types/generated/` | protobuf 自动生成 | 无 — 非手写代码 |
| `utils/bash/ast.ts` | AST 类型 | 低 — 3 处 |

**总体评估**: 手写代码 `any` 使用非常少 (~20 处), 类型纪律良好。

### 2.4 全局可变状态

**50+ 个模块级 `let` 变量** 作为全局可变状态:

| 模块 | 模块级 let 变量数 | 示例 |
|------|-------------------|------|
| `services/analytics/growthbook.ts` | 10 | `client`, `currentBeforeExitHandler`, `envOverrides` |
| `services/analytics/` (sink) | 10 | `sink`, `logBatch`, `flushTimer`, `datadogInitialized` |
| `bootstrap/state.ts` | 5 | `interactionTimeDirty`, `outputTokensAtTurnStart` |
| `services/mockRateLimits.ts` | 8 | `mockHeaders`, `mockEnabled` |
| `keybindings/loadUserBindings.ts` | 6 | `watcher`, `initialized`, `cachedBindings` |
| `utils/swarm/backends/registry.ts` | 7 | `cachedBackend`, `TmuxBackendClass` |

这些变量绕过 React 状态管理模式, 直接修改, 不触发 UI 更新通知。

### 2.5 God Object — AppState

`AppState` 类型 (569 行, ~360 字段) 封装了跨多个关注点的状态:

- **UI**: expandedView, statusLineText, spinnerTip, activeOverlays
- **MCP**: mcp.clients, mcp.tools, mcp.commands, mcp.resources
- **Bridge**: replBridge* (10+ 字段)
- **远程**: remoteSessionUrl, remoteConnectionStatus
- **任务**: tasks, foregroundedTaskId, agentNameRegistry
- **团队**: teamContext, inbox, workerSandboxPermissions
- **权限**: toolPermissionContext, denialTracking
- **Agent**: agent, kairosEnabled
- **通知**: notifications.current, notifications.queue
- **插件**: plugins.enabled, plugins.disabled, plugins.errors

任何调用 `setAppState` 的模块必须了解其完整形状。

### 2.6 跨工具重复逻辑

**权限检查** 在多个文件中以相似但不相同的方式实现:
- `utils/permissions/permissions.ts` — `hasPermissionsToUseTool()` (主权限检查)
- `tools/BashTool/bashPermissions.ts` — `bashToolHasPermission()` (2,621 行 Bash 专用)
- `tools/BashTool/pathValidation.ts`, `sedValidation.ts` 等 — Bash 子权限验证器
- `tools/PowerShellTool/powershellPermissions.ts` — PowerShell 专用权限

**`markToolUseAsComplete`** 在两处重复:
- `services/tools/StreamingToolExecutor.ts:521-530`
- `services/tools/toolOrchestration.ts:179-188`

**工具错误消息创建** 在 `StreamingToolExecutor.ts` 和 `toolExecution.ts` 中以略有不同的方式重复。

### 2.7 不一致的错误处理

**日志工具选择不一致**:

| 工具 | 用途 | 使用量 |
|------|------|--------|
| `logError()` | 实际错误 | 较少 |
| `logEvent('tengu_*')` | 遥测/分析 | 341 处跨 30 文件 |
| `logForDebugging()` | 调试追踪 | 175 处跨 30 文件 |

**错误传播不一致**:
- 抛出: `ClaudeError`, `AbortError`, `ConfigParseError`, `ShellError`, `McpToolCallError`, `McpAuthError`, `AuthenticationCancelledError`, `DirectConnectError`, `PathTraversalError`
- Yield: `tool_result` with `is_error: true`
- 返回: `PermissionResult` with `behavior: 'deny'`

**toolHooks.ts 的 catch 块不一致** (12 个 try/catch):
- 外层 catch: `logError(error)` + yields `{ type: 'stop' }`
- 内层 post-tool hook catch: `logEvent()` + yields attachment
- 内层 pre-tool hook catch: `logError(error)` + yields `{ type: 'stop' }`
- 某些静默吞掉错误

---

## 3. 一致性分析

### 3.1 错误处理一致性

**评分: 6/10**

- 分析遥测 (`logEvent`) 模式非常一致
- 错误传播方式多样 (throw vs yield vs return), 但各有适用场景
- 日志工具选择 (logError vs logForDebugging vs logEvent) 不够一致

### 3.2 日志一致性

**评分: 7/10**

- 分析事件通过 `logEvent('tengu_*', { metadata })` — 非常一致的遥测模式
- 调试追踪通过 `logForDebugging(message)` — 一致但冗长
- 错误通过 `logError(error)` — 一致
- 某些模块使用专用日志路径

### 3.3 权限检查一致性

**评分: 9/10**

所有工具通过相同管线 (在 `toolExecution.ts` 中):
1. `tool.validateInput()` — 输入验证 (可选, 按工具)
2. `runPreToolUseHooks()` — Hook 管线 (始终运行)
3. `resolveHookPermissionDecision()` — 解析 Hook 决策
4. `tool.checkPermissions()` — 工具特定权限
5. `canUseTool()` — 交互式用户确认
6. `checkRuleBasedPermissions()` — settings.json 规则评估

`buildTool()` 工厂确保每个工具有默认 `checkPermissions` 返回 `{ behavior: 'allow' }`。

### 3.4 状态更新一致性

**评分: 7/10**

- React 状态更新通过 `setAppState(updater)` — 一致的函数式更新模式
- 但模块级可变状态 (50+ `let` 变量) 完全绕过此模式
- `toolUseContext.setAppState(f)` vs 直接 `let` 变量修改 — 两套系统并存

---

## 4. 子系统一致性评分

| 子系统 | 一致性 | 评分 | 说明 |
|--------|--------|------|------|
| 工具系统 | 高 | 9/10 | buildTool + 统一管线 |
| 命令系统 | 高 | 8/10 | 可辨识联合 + 懒加载 |
| 权限系统 | 高 | 9/10 | 6 阶段管线 + buildTool 默认值 |
| Hook 系统 | 中 | 7/10 | 装饰器模式一致, 但错误处理不一 |
| MCP 服务 | 中 | 7/10 | 传输层抽象良好, 但 client.ts 过大 |
| Bridge 系统 | 低 | 5/10 | 两个巨型函数, 逻辑混合 |
| 分析系统 | 高 | 8/10 | 一致的 logEvent 模式 |
| 状态管理 | 中 | 6/10 | setAppState 一致, 但全局可变状态并存 |
| 设置系统 | 高 | 8/10 | Zod 验证 + 层级合并 |

---

## 5. 关键观察

1. **Async Generator 是代码库的核心抽象**: 流式数据处理贯穿查询循环、工具执行、API 通信、Hook 处理、Agent 执行。这比回调或 Promise 链更适合流式场景。

2. **buildTool 是最成功的设计模式**: 通过类型级展开保留精确类型, 同时合并默认值。50+ 工具使用同一工厂, 确保了接口一致性。

3. **Signal 原语消除了重复**: `createSignal()` 将 15+ 处手动观察者模式折叠为一行调用, 是代码库去重的优秀案例。

4. **Hook 系统是最强大的装饰器**: Pre/Post Hook 可以修改输入、改变权限决策、阻止执行、注入上下文 — 这是代码库中最灵活的扩展点, 但也是最复杂的。

5. **全局可变状态是最大的技术债**: 50+ 模块级 `let` 变量绕过 React 状态管理, 不触发 UI 更新, 不受不可变约束保护。这是测试和调试的最大障碍。

6. **Bridge 系统是复杂度最集中的区域**: 两个文件中 3,000+ 行的单函数, 混合了传输、重连、消息处理、权限委托等多种关注点。