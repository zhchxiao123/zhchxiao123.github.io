---
title: "Step 16: React Hooks 架构"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/16-hooks-architecture/
---


> 分析日期: 2026-04-16
> 核心目录: src/hooks/ (85+ 文件 + notifs/ 子目录 + toolPermission/ 子目录)

---

## 1. Hook 完整清单

### Category 1: Tool/Permission Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useCanUseTool` | useCanUseTool.tsx | React compiler-runtime, feature(), hasPermissionsToUseTool, createPermissionContext, handleCoordinator/Swarm/Interactive Permission, consumeSpeculativeClassifierCheck, logPermissionDecision | 主 REPL 循环 (工具执行管线) |
| `useMergedTools` | useMergedTools.ts | useMemo, assembleToolPool, mergeAndFilterTools | REPL 组件 |
| `useMergedCommands` | useMergedCommands.ts | useMemo, lodash-es/uniqBy | REPL 组件 |
| `useMergedClients` | useMergedClients.ts | useMemo, lodash-es/uniqBy | REPL 组件 |
| `useSwarmPermissionPoller` | useSwarmPermissionPoller.ts | useInterval, isSwarmWorker, pollForResponse | REPL (swarm workers) |
| `useSkillsChange` | useSkillsChange.ts | skillChangeDetector, onGrowthBookRefresh | REPL 组件 |
| PermissionContext | toolPermission/PermissionContext.ts | awaitClassifierAutoApproval, executePermissionHooks | useCanUseTool |
| interactiveHandler | toolPermission/handlers/interactiveHandler.ts | PermissionContext, ToolUseConfirm, executePermissionHooks | useCanUseTool |
| coordinatorHandler | toolPermission/handlers/coordinatorHandler.ts | PermissionContext, awaitClassifierAutoApproval | useCanUseTool |
| swarmWorkerHandler | toolPermission/handlers/swarmWorkerHandler.ts | PermissionContext, registerPermissionCallback | useCanUseTool |

### Category 2: IDE Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useIDEIntegration` | useIDEIntegration.tsx | initializeIdeIntegration, getGlobalConfig | REPL 组件 |
| `useIdeSelection` | useIdeSelection.ts | getConnectedIdeClient, zod/v4 | PromptInput |
| `useIdeAtMentioned` | useIdeAtMentioned.ts | (IDE @ mention 处理) | PromptInput |
| `useIdeConnectionStatus` | useIdeConnectionStatus.ts | (IDE 连接状态) | Footer/UI |
| `useDiffInIDE` | useDiffInIDE.ts | callIdeRpc, getConnectedIdeClient | FileEditTool 权限 UI |
| `useIdeLogging` | useIdeLogging.ts | (IDE 日志工具) | 多个组件 |

### Category 3: Input Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useTextInput` | useTextInput.ts | Cursor, useDoublePress, useNotifications, stripAnsi | BaseTextInput, PromptInput |
| `useVimInput` | useVimInput.ts | useTextInput, Cursor, vim operators/transitions | Vim 模式 PromptInput |
| `useInputBuffer` | useInputBuffer.ts | useState, useCallback, useRef | PromptInput |
| `useSearchInput` | useSearchInput.ts | useTerminalSize, Cursor, useInput (Ink) | 转录搜索栏 |
| `useDoublePress` | useDoublePress.ts | useCallback, useRef | useTextInput (Ctrl+C, Escape) |
| `useArrowKeyHistory` | useArrowKeyHistory.tsx | (方向键历史导航) | PromptInput |
| `usePasteHandler` | usePasteHandler.ts | (剪贴板粘贴处理) | PromptInput |

### Category 4: Navigation Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useGlobalKeybindings` | useGlobalKeybindings.tsx | useKeybinding, useAppState, useSetAppState, instances.forceRedraw | REPL (注册处理器) |
| `useBackgroundTaskNavigation` | useBackgroundTaskNavigation.ts | useAppState, useInput (Ink) | REPL 组件 |
| `useHistorySearch` | useHistorySearch.ts | useKeybinding, makeHistoryReader, useInput | PromptInput |
| `useVirtualScroll` | useVirtualScroll.ts | useSyncExternalStore, useDeferredValue, useLayoutEffect | MessageList |
| `useExitOnCtrlCD` | useExitOnCtrlCD.ts | (Ctrl+C/D 退出处理) | REPL |

### Category 5: State Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useSettings` | useSettings.ts | useAppState | 需要设置的任何组件 |
| `useSettingsChange` | useSettingsChange.ts | settingsChangeDetector, getSettings_DEPRECATED | REPL |
| `useDynamicConfig` | useDynamicConfig.ts | useState, getDynamicConfig_BLOCKS_ON_INIT | 特性门控组件 |
| `useMainLoopModel` | useMainLoopModel.ts | (主循环模型状态) | REPL |
| `useTasksV2` | useTasksV2.ts | useSyncExternalStore, fs.watch, listTasks, useAppState | Todo 组件 |
| `usePrStatus` | usePrStatus.ts | (PR 状态追踪) | PR 相关 UI |
| `useMemoryUsage` | useMemoryUsage.ts | (内存追踪) | 诊断 UI |
| `useTurnDiffs` | useTurnDiffs.ts | useMemo, diff (structured patch) | 转录差异视图 |
| `useFileHistorySnapshotInit` | useFileHistorySnapshotInit.ts | (文件历史快照) | REPL 初始化 |
| `useApiKeyVerification` | useApiKeyVerification.ts | (API key 验证) | 设置/认证 |

### Category 6: Communication Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useReplBridge` | useReplBridge.tsx | useAppState, useAppStateStore, useNotifications, buildBridgeConnectUrl | REPL (bridge 模式) |
| `useMailboxBridge` | useMailboxBridge.ts | useMailbox, useSyncExternalStore | REPL |
| `useInboxPoller` | useInboxPoller.ts | useInterval, useAppState, readUnreadMessages, writeToMailbox | REPL (swarm/团队通信) |
| `useRemoteSession` | useRemoteSession.ts | RemoteSessionManager, useSetAppState | SDK/远程会话 |
| `useCommandQueue` | useCommandQueue.ts | useSyncExternalStore, subscribeToCommandQueue | useQueueProcessor |
| `useQueueProcessor` | useQueueProcessor.ts | useSyncExternalStore, useEffect, processQueueIfReady | REPL |
| `useSSHSession` | useSSHSession.ts | (SSH 会话管理) | SSH 模式 |
| `useDirectConnect` | useDirectConnect.ts | (直接连接协议) | 远程会话 |
| `useTeleportResume` | useTeleportResume.tsx | (传送恢复协议) | 会话恢复 |
| `useSwarmInitialization` | useSwarmInitialization.ts | (swarm 初始化逻辑) | REPL (swarm 模式) |

### Category 7: UI Hooks

| Hook | 文件 | 依赖 | 被使用 |
|------|------|------|--------|
| `useTerminalSize` | useTerminalSize.ts | useContext, TerminalSizeContext | 所有布局组件 |
| `useBlink` | useBlink.ts | useAnimationFrame, useTerminalFocus | 动画指示器 |
| `useTypeahead` | useTypeahead.tsx | useAppState, useInput, useKeybindings, fileSuggestions | PromptInput |
| `useAfterFirstRender` | useAfterFirstRender.ts | isEnvTruthy | REPL (开发启动计时) |
| `useElapsedTime` | useElapsedTime.ts | (经过时间显示) | Spinner |
| `useMinDisplayTime` | useMinDisplayTime.ts | (最小显示时间) | Spinner |
| `useCopyOnSelect` | useCopyOnSelect.ts | (选择时复制) | 终端交互 |
| `useVoice/useVoiceEnabled/useVoiceIntegration` | useVoice.ts 等 | (语音输入处理) | 语音功能 |
| Notification hooks (16) | notifs/*.ts(x) | 各种 | 状态栏/通知 |

---

## 2. Hook 依赖图

```
                        AppState Store (Zustand)
                             |
            +----------------+----------------+
            |                |                 |
     useSettings      useGlobalKeybindings   useCanUseTool
            |                |                 |
     useSettingsChange  useKeybinding     createPermissionContext
            |                |                 |
    settingsChangeDetector   |           +------+-------+
                             |           |      |       |
                      useBackground    handle  handle  handle
                      TaskNavigation   Coord  Swarm  Interactive
                             |          Handler Handler Handler
                      useInput (Ink)     |      |       |
                                         |  useSwarmPermission
                                         |  Poller
                                         |
                                    useCommandQueue
                                         |
                                    useQueueProcessor
                                         |
                                    useMailboxBridge
                                         |
                                     useMailbox

    Input Pipeline:
    useTextInput --> useDoublePress
                 --> useVimInput --> useTextInput
                 --> useSearchInput --> useTerminalSize
                 --> useTypeahead --> useInput (Ink)
                                  --> useKeybindings
                                  --> fileSuggestions
                                  --> unifiedSuggestions

    IDE Pipeline:
    useIDEIntegration --> initializeIdeIntegration
    useIdeSelection --> getConnectedIdeClient (MCP)
    useDiffInIDE --> callIdeRpc

    Tool Merging:
    useMergedTools --> assembleToolPool --> mergeAndFilterTools
    useMergedCommands --> lodash uniqBy
    useMergedClients --> lodash uniqBy
```

---

## 3. 关键 Hook 分析

### useCanUseTool 流 (最关键的 Hook)

这是整个系统中最关键的 Hook — 每次工具调用必须通过此权限门：

1. **入口**: 调用 `(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?)`
2. **权限上下文创建**: `createPermissionContext()` 构建 ctx 对象
3. **中止检查**: `ctx.resolveIfAborted(resolve)` — 如果请求已取消，短路返回
4. **权限决策**: 如提供 `forceDecision`，直接使用；否则调用 `hasPermissionsToUseTool()` 检查配置规则
5. **三路分支** on `result.behavior`:
   - **allow**: 配置授权 → 立即 `buildAllow()`；自动模式分类器追踪
   - **deny**: 记录拒绝；自动模式分类器拒绝时记录 `recordAutoModeDenial` 并显示通知
   - **ask**: 用户交互需要:
     a. Coordinator 检查 → `handleCoordinatorPermission()`
     b. Swarm worker 检查 → `handleSwarmWorkerPermission()` (通过邮箱转发)
     c. 推测分类器 (仅 Bash) → 2秒竞速检查
     d. 交互对话框 → `handleInteractivePermission()` (支持 bridge 回调和通道回调)
6. **错误处理**: `AbortError` 和 `APIUserAbortError` 特殊处理
7. **清理**: `clearClassifierChecking(toolUseID)` 在 `.finally()` 中

**设计特点**:
- 使用 React Compiler runtime (`_c()`) 进行自动 memoization
- 返回回调函数 (`CanUseToolFn`)，不是数据 — 命令式 API
- 整个权限检查基于 Promise，包装在 `new Promise()` 中支持异步工作流
- 多个中止检查点防止显示过期对话框

### useMergedTools 组合

1. **输入**: `initialTools` (内置 + 启动 MCP), `mcpTools` (动态发现), `toolPermissionContext`
2. **组合** via `useMemo`:
   a. `assembleToolPool(toolPermissionContext, mcpTools)` — 内置工具 + MCP 拒绝规则过滤 + 去重
   b. `mergeAndFilterTools(initialTools, assembled, mode)` — 初始工具优先 + 权限模式过滤
3. **依赖**: `[initialTools, mcpTools, toolPermissionContext]`

---

## 4. 潜在反模式

### A. useMergedTools 死依赖

`replBridgeEnabled` 和 `replBridgeOutboundOnly` 在依赖数组中但值始终为 `false`，可能是遗留代码或待实现存根。

### B. useInboxPoller 过度复杂 (~970 行)

单个 hook 处理 9+ 种消息类型(权限请求/响应、沙箱请求/响应、关闭请求/审批、团队权限更新、模式设置请求、计划审批请求)。违反单一职责原则，建议拆分为 `usePermissionMessageHandler`, `useTeamMessageHandler`, `useInboxQueueManager`。

### C. useTypeahead 高依赖数

导入 30+ 模块，处理斜杠命令建议、文件路径补全、@-mention 补全、#频道建议、shell 历史、渐进式参数提示、overlay/modal 管理、键绑定注册。是最容易触发重渲染的 hook 之一。

### D. useReplBridge 模块级可变状态

`messagesRef.current = messages` 在每次渲染时将 props 同步到 ref，可能导致异步读取的竞态条件。

### E. useSwarmPermissionPoller 模块级单例

两个 `Map` 对象在模块作用域声明，跨 React 组件生命周期持久化。`clearAllPendingCallbacks()` 逃生舱用于 `/clear` 和测试隔离。

### F. useTextInput 每次渲染重新计算

每帧创建新 `Cursor` 对象和多个处理映射表 (`handleCtrl`, `handleMeta`, `mapKey`)。`useDoublePress` 也每帧重新实例化。

### G. 向后兼容 useInput 垫片

`useBackgroundTaskNavigation`, `useHistorySearch`, `useSearchInput` 使用 `useInput` 垫片（`eslint-disable custom-rules/prefer-use-keybindings`），等待消费者迁移到 `<Box onKeyDown>`。

### H. 通知 Hooks 级联重渲染

`notifs/` 目录 16 个通知 hook，每个可能订阅不同 AppState 切片。如果全部在同一组件树中渲染，任何 AppState 变更可能触发所有 16 个 hook 重渲染。