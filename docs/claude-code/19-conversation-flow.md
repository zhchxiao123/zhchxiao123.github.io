---
title: "Step 19: 端到端对话流程 (End-to-End Conversation Flow)"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/19-conversation-flow/
---


本文档追踪 Claude Code 中三条完整的用户交互旅程，覆盖从用户输入到 UI 渲染的每一步，包含文件路径、行号、状态转换和错误处理。

---

## Journey A: 交互式聊天消息 (Interactive Chat Message)

> 用户输入 -> PromptInput -> useInputBuffer -> ask()/submitMessage() -> 系统提示组装 -> 工具注册 -> API调用 -> 流式响应 -> 工具分发 -> 权限检查 -> 工具执行 -> 结果追加 -> UI重渲染

### 步骤 1: 用户在 PromptInput 中输入文本

**文件**: `src/components/PromptInput/PromptInput.tsx`

用户通过终端键入文本。`PromptInput` 组件使用 Ink 的 `useInput` hook 捕获键盘事件（第 1865 行附近）。每次按键都会更新 `inputValue` 状态。

**状态转换**: `inputValue: "" -> "用户输入的文本"`

**关键代码路径**:
- `useInput` 捕获 `char` + `key` 事件 (PromptInput.tsx:1865)
- `setInputValue(value)` 更新输入值 (PromptInput.tsx:1344)
- `inputValueRef.current = value` 同步 ref (PromptInput.tsx:1360)

**错误处理**: 无特殊错误处理——输入是纯本地 UI 状态更新。

---

### 步骤 2: useInputBuffer 缓冲输入

**文件**: `src/hooks/useInputBuffer.ts:27-132`

`useInputBuffer` 维护一个带防抖的输入历史缓冲区，支持撤销操作。

- `pushToBuffer(text, cursorOffset, pastedContents)` (第 36 行): 将当前输入推入缓冲
- 防抖机制: 两次 `pushToBuffer` 间隔小于 `debounceMs` 时，延迟推入 (第 51-59 行)
- 最大缓冲区大小限制: 超过 `maxBufferSize` 时截断最早条目 (第 82-84 行)

**状态转换**: `buffer: [] -> [{text, cursorOffset, pastedContents, timestamp}]`

**错误处理**: 无——纯内存操作，不存在失败路径。

---

### 步骤 3: 用户按 Enter 提交 -> onSubmit

**文件**: `src/components/PromptInput/PromptInput.tsx:984-1105`

用户按 Enter 键触发 `onSubmit` 回调。该函数执行多层守卫检查：

1. **Footer 选择守卫** (第 992-995 行): 如果 footer 项被选中，不提交
2. **Agent 选择模式守卫** (第 1000-1002 行): 选择 agent 时不提交
3. **建议匹配** (第 1011-1038 行): 空输入匹配提示建议时，接受建议
4. **直接消息路由** (第 1041-1064 行): `@name` 格式走 agent 直接消息
5. **空输入守卫** (第 1067-1069 行): 无文本也无图片时不提交
6. **Typeahead 守卫** (第 1074-1077 行): 建议下拉框打开时不提交
7. **Agent 路由** (第 1088-1097 行): 如果正在查看 teammate，路由到 `onAgentSubmit`

最终通过 `onSubmitProp` (第 1100 行) 调用 REPL 的 `onSubmit`。

**状态转换**: `inputValue -> "" (清空)` | `screen: prompt -> (正在查询)`

**错误处理**: 各守卫提前 `return`，阻止无效提交。

---

### 步骤 4: REPL.onSubmit 调度

**文件**: `src/screens/REPL.tsx:3142-3545`

`REPL.onSubmit` 是核心调度入口，处理多种场景：

1. **立即可执行命令** (第 3161-3282 行): 检测到 `/command` 且命令标记为 `immediate` 或来自键盘绑定，直接执行 `local-jsx` 命令并返回
2. **远程模式** (第 3416-3486 行): `activeRemote.isRemoteMode` 下，通过 WebSocket 发送消息到远端
3. **等待 hook** (第 3488-3489 行): `await awaitPendingHooks()` 确保 SessionStart hook 上下文可用
4. **调用 handlePromptSubmit** (第 3490-3519 行): 将输入传递给核心提交处理器

**状态转换**:
- `submitCount += 1`
- `inputMode -> 'prompt'`
- `ideSelection -> undefined`
- `pastedContents -> {}`

**错误处理**:
- 空输入提前返回 (第 3285-3287 行)
- 空闲返回对话框 (第 3293-3310 行): 大上下文+长时间空闲时弹出确认
- 远程模式发送失败由 WebSocket 层处理

---

### 步骤 5: handlePromptSubmit 处理输入

**文件**: `src/utils/handlePromptSubmit.ts:120-311`

`handlePromptSubmit` 负责输入验证和路由：

1. **队列命令路径** (第 150-172 行): 如果有 `queuedCommands`，跳过验证直接执行
2. **退出命令** (第 194-211 行): 检测 `exit`/`quit`/`:q` 等，路由到 `/exit`
3. **粘贴引用展开** (第 216 行): `expandPastedTextRefs` 替换 `[Pasted text #N]`
4. **立即可执行命令** (第 229-311 行): `immediate` + `local-jsx` 命令直接执行
5. **队列/中断逻辑** (第 313 行以下): 如果当前正在查询，将输入排队或中断当前轮次

**状态转换**: 输入从原始字符串展开为完整内容

**错误处理**: 退出命令找不到时 `process.exit()` (第 208 行)

---

### 步骤 6: processUserInput 解析输入

**文件**: `src/utils/processUserInput/processUserInput.ts:85-589`

这是输入解析的核心，决定消息类型：

1. **图片处理** (第 300-420 行): 处理粘贴的图片内容
2. **Bridge 安全命令** (第 428-453 行): 远程桥接模式下，检查 `isBridgeSafeCommand`
3. **Ultraplan 关键字** (第 467-493 行): 检测 `plan` 关键字，路由到 `/ultraplan`
4. **附件提取** (第 496-513 行): `getAttachmentMessages` 提取 @-mention、MCP 资源等
5. **Bash 命令** (第 517-529 行): `mode === 'bash'` 时调用 `processBashCommand`
6. **Slash 命令** (第 531-551 行): `/command` 格式调用 `processSlashCommand`
7. **普通提示** (第 577-588 行): 调用 `processTextPrompt`

**返回值**: `{ messages, shouldQuery, allowedTools, model, resultText }`

**状态转换**: 纯文本 -> `UserMessage` + 可能的 `AttachmentMessage[]`

**错误处理**:
- Bridge 不安全命令: 返回 `shouldQuery: false` + 错误消息 (第 438-448 行)
- 未知命令: `MalformedCommandError` (processSlashCommand.tsx:820)

---

### 步骤 7: 系统提示组装

**文件**: `src/screens/REPL.tsx:2768-2788` (交互模式) / `src/QueryEngine.ts:284-325` (SDK模式)

系统提示由多个部分组装：

1. **默认系统提示** `getSystemPrompt(tools, model, dirs, mcpClients)` (REPL.tsx:2772): 包含工具定义、安全策略
2. **用户上下文** `getUserContext()` (REPL.tsx:2772): 环境信息、项目上下文
3. **系统上下文** `getSystemContext()` (REPL.tsx:2772): 额外系统级指令
4. **协调器上下文** `getCoordinatorUserContext(mcpClients, scratchpadDir)` (REPL.tsx:2775)
5. **Agent 定义覆盖** `buildEffectiveSystemPrompt(mainThreadAgentDefinition, ...)` (REPL.tsx:2781-2787)
6. **自定义系统提示** `customSystemPrompt` + `appendSystemPrompt` (QueryEngine.ts:321-325)

**状态转换**: 无——纯计算

**错误处理**: `fetchSystemPromptParts` 内部异步错误会导致查询失败，传播到上层

---

### 步骤 8: 工具注册

**文件**: `src/screens/REPL.tsx:2746-2755` / `src/Tool.ts`

工具在查询上下文中注册：

1. `getToolUseContext(messages, newMessages, abortController, mainLoopModel)` (REPL.tsx:2746) 创建工具使用上下文
2. `toolUseContext.options.tools` 包含当前可用的所有工具 (REPL.tsx:2752-2755)
3. 工具列表在 REPL 初始化时通过 `getTools(toolPermissionContext)` 生成 (REPL.tsx:696)
4. MCP 工具从 `mcpClients` 动态合并 (REPL.tsx:666-667)

**状态转换**: `toolUseContext.options.tools` 确定可用的工具集

**错误处理**: MCP 工具连接失败时，工具列表排除失败的 MCP 工具

---

### 步骤 9: API 调用 (query 函数)

**文件**: `src/query.ts:219-239` (入口) / `src/query.ts:241-549` (queryLoop)

`query()` 是查询的主入口，它调用 `queryLoop()` 进入主循环：

1. **初始化状态** (第 268-279 行): 构建可变 `State` 对象，包含 messages、toolUseContext、autoCompact 状态等
2. **内存预取** (第 301-304 行): `startRelevantMemoryPrefetch` 异步预取相关记忆
3. **消息过滤** (第 365 行): `getMessagesAfterCompactBoundary` 只取 compaction 边界后的消息
4. **工具结果预算** (第 379-394 行): `applyToolResultBudget` 限制工具结果大小
5. **Snip 压缩** (第 400-410 行): 如果启用 HISTORY_SNIP，执行 snip 压缩
6. **微压缩** (第 414-426 行): `deps.microcompact()` 执行缓存级压缩
7. **上下文折叠** (第 440-447 行): `contextCollapse.applyCollapsesIfNeeded()`
8. **自动压缩** (第 454-468 行): `deps.autocompact()` 在需要时执行摘要压缩
9. **阻塞限制检查** (第 628-648 行): 超过 token 限制时 yield 错误并返回
10. **API 流式调用** (第 659-708 行): `deps.callModel()` 发起流式 API 请求

**状态转换**: `State { messages, toolUseContext, turnCount, ... }` 每次循环迭代更新

**错误处理**:
- `PROMPT_TOO_LONG_ERROR_MESSAGE`: 超出限制时 yield 错误消息 (第 642-647 行)
- `categorizeRetryableAPIError`: API 错误分类和重试
- `withRetry`: 流式请求包装重试逻辑

---

### 步骤 10: 流式响应处理

**文件**: `src/services/api/claude.ts:752-780`

流式 API 通过 `queryModelWithStreaming` 发起：

1. `queryModelWithStreaming` (第 752 行): 创建流式请求
2. `withStreamingVCR` 包装器: 支持 VCR 录制/回放
3. `queryModel`: 实际调用 Anthropic API
4. 流事件通过 `yield*` 逐个向上传递

**文件**: `src/screens/REPL.tsx:2793-2803`

REPL 通过 `for await...of` 消费流事件：

```typescript
for await (const event of query({...})) {
  onQueryEvent(event);
}
```

**状态转换**: 流模式从 `requesting` -> `thinking` -> `responding` -> `tool-input`

---

### 步骤 11: handleMessageFromStream 分发流事件

**文件**: `src/utils/messages.ts:2930-3029`

`handleMessageFromStream` 根据事件类型更新 UI 状态：

1. **完整消息** (第 2950-2982 行): `assistant`/`user`/`system` 类型直接调用 `onMessage`
2. **stream_request_start** (第 2984-2987 行): 设置流模式为 `requesting`
3. **message_start** (第 2989-2993 行): 记录 TTFT 指标
4. **message_stop** (第 2995-2998 行): 设置流模式为 `tool-use`，清空 streamingToolUses
5. **content_block_start** (第 3002-3029 行): 根据 block 类型设置流模式
   - `thinking`/`redacted_thinking` -> `thinking`
   - `text` -> `responding`
   - `tool_use` -> `tool-input`，追加到 streamingToolUses

**状态转换**: `streamMode: requesting -> thinking/responding/tool-input -> tool-use`

**错误处理**: 无——纯 UI 状态更新

---

### 步骤 12: 工具分发

**文件**: `src/services/tools/StreamingToolExecutor.ts:40-359`

当模型返回 `tool_use` 内容块时，`StreamingToolExecutor` 负责调度：

1. **addTool** (第 76 行): 将 tool_use 块加入执行队列
   - 查找工具定义: `findToolByName(toolDefinitions, block.name)` (第 77 行)
   - 工具不存在时返回错误消息 (第 79-101 行)
   - 解析输入: `toolDefinition.inputSchema.safeParse(block.input)` (第 104 行)
   - 判断并发安全性: `toolDefinition.isConcurrencySafe(parsedInput.data)` (第 108 行)

2. **processQueue** (第 140 行): 按并发规则启动工具
   - `canExecuteTool(isConcurrencySafe)` (第 129 行): 当前无执行中工具，或所有执行中工具都是并发安全的

3. **executeTool** (第 265 行): 执行单个工具
   - 检查 abort 原因 (第 278-291 行): 被中断时返回合成错误
   - 创建子 abort 控制器 (第 301-303 行): Bash 错误可级联终止兄弟进程
   - 调用 `runToolUse(block, assistantMessage, canUseTool, context)` (第 320-325 行)

**状态转换**: `tool.status: queued -> executing -> completed`

**错误处理**:
- 工具不存在: 返回 `No such tool available` 错误 (第 91-100 行)
- 兄弟错误: 取消正在排队的工具 (第 153-205 行)
- 用户中断: 返回 `REJECT_MESSAGE` (第 160-172 行)
- 流式回退: 返回 `Streaming fallback - tool execution discarded` (第 174-188 行)

---

### 步骤 13: 权限检查

**文件**: `src/hooks/useCanUseTool.tsx:28-80`

每次工具执行前，`canUseTool` 进行权限验证：

1. **创建权限上下文** `createPermissionContext(tool, input, toolUseContext, ...)` (第 33 行)
2. **检查 abort** `ctx.resolveIfAborted(resolve)` (第 34 行)
3. **获取决策**:
   - `forceDecision` 指定时直接使用 (第 37 行)
   - 否则调用 `hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)` (第 37 行)
4. **allow 路径** (第 39-53 行): 直接放行，记录日志
5. **deny 路径** (第 64-80 行): 拒绝执行
6. **需要确认** (默认路径): 弹出交互式权限确认对话框

**状态转换**: `PermissionDecision { behavior: 'allow' | 'deny' | 'ask' }`

**错误处理**:
- Abort: 检测到 abort 信号立即 resolve
- 权限被拒: 返回 deny 决策，工具不执行
- 交互式确认超时: 由对话框层处理

---

### 步骤 14: 工具执行 (runToolUse)

**文件**: `src/Tool.ts` (runToolUse 函数)

权限通过后，工具实际执行：

1. 工具的 `execute(input, context)` 方法被调用
2. 工具产生 `AsyncGenerator<ToolResult>` 流
3. 结果被收集为 `UserMessage` (tool_result 类型)

**状态转换**: 工具执行中 -> 结果生成

**错误处理**:
- 工具内部错误: 返回 `is_error: true` 的 tool_result
- 网络错误: 由各工具自行处理（如 BashTool 的子进程管理）

---

### 步骤 15: 结果追加

**文件**: `src/query.ts:551-751` / `src/screens/REPL.tsx:2584-2660`

工具结果追加到消息流：

1. **query.ts 中** (第 551 行): `toolResults` 数组收集工具执行结果
2. **REPL 中** (第 2629 行): `setMessages(oldMessages => [...oldMessages, newMessage])`
3. **压缩边界** (第 2586-2607 行): 检测到压缩边界时，替换整个消息数组
4. **临时进度** (第 2608-2627 行): 临时进度消息替换而非追加

**状态转换**: `messages: [...old, newMessage]` 或 `messages: [compactBoundary]`

**错误处理**: 无——纯数组操作

---

### 步骤 16: UI 重渲染

**文件**: `src/screens/REPL.tsx:1318-1322`

React 重渲染由 `setMessages` 触发：

1. `useDeferredValue(messages)` (第 1318 行): 消息以低优先级渲染，保持输入响应
2. `useLogMessages(messages)` (第 48 行 import): 持久化消息到日志/transcript
3. `onQueryEvent` 中的 `onStreamingText` 回调 (第 2641-2645 行): 更新流式文本长度

**状态转换**: React 组件树重渲染，Messages 组件显示新消息

**错误处理**: 渲染错误由 React error boundary 捕获

---

### 步骤 17: 查询循环继续/终止

**文件**: `src/query.ts:306-549`

`queryLoop` 是无限循环 `while (true)` (第 307 行)，每次迭代：

1. 如果模型返回 `stop_reason: 'end_turn'`，循环终止
2. 如果模型返回 `tool_use`，工具执行后继续循环
3. `Continue` 信号决定循环继续原因 (第 104 行类型)
4. `Terminal` 类型定义终止原因 (第 104 行类型)

循环终止后 (REPL.tsx:2847-2853):
- `resetLoadingState()`: 重置加载状态
- `onTurnComplete?.()`: 调用轮次完成回调

**状态转换**: `isLoading: true -> false` | `abortController: null`

---

## Journey B: Slash 命令执行 (Slash Command Execution)

> 用户输入 /command -> findCommand() -> 命令handler -> 消息/状态变更 -> UI更新

### 步骤 1: 用户输入斜杠命令

**文件**: `src/components/PromptInput/PromptInput.tsx:984-1105`

用户输入 `/command` 格式的文本并按 Enter。`onSubmit` 检测到输入以 `/` 开头。

**状态转换**: `inputValue: "/command args"`

---

### 步骤 2: REPL.onSubmit 斜杠命令分支

**文件**: `src/screens/REPL.tsx:3161-3282`

`onSubmit` 中的斜杠命令检测逻辑：

1. **命令名解析** (第 3165-3168 行): 从输入中提取 `commandName` 和 `commandArgs`
2. **查找匹配命令** (第 3173 行): `commands.find(cmd => isCommandEnabled(cmd) && (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName))`
3. **立即可执行判断** (第 3184 行): `queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding)`
4. **立即执行分支** (第 3185-3282 行): `local-jsx` 类型的立即可执行命令直接执行
5. **非立即命令**: 流入 `handlePromptSubmit`

---

### 步骤 3: handlePromptSubmit 斜杠命令路由

**文件**: `src/utils/handlePromptSubmit.ts:229-311`

1. **立即可执行命令检测** (第 229-246 行): 再次检测 `immediate` + `local-jsx` 命令
2. **队列/中断** (第 313 行): 正在查询时排队或中断

最终到达 `processUserInput` 中的斜杠命令处理。

---

### 步骤 4: processUserInput -> processSlashCommand

**文件**: `src/utils/processUserInput/processUserInput.ts:531-551`

当输入以 `/` 开头且 `effectiveSkipSlash` 为 false 时：

```typescript
if (inputString !== null && !effectiveSkipSlash && inputString.startsWith('/')) {
  const { processSlashCommand } = await import('./processSlashCommand.js')
  const slashResult = await processSlashCommand(
    inputString, precedingInputBlocks, imageContentBlocks,
    attachmentMessages, context, setToolJSX, uuid,
    isAlreadyProcessing, canUseTool,
  )
  return addImageMetadataMessage(slashResult, imageMetadataTexts)
}
```

---

### 步骤 5: findCommand 查找命令

**文件**: `src/commands.ts:688-698`

`findCommand` 在命令列表中搜索匹配的命令：

```typescript
export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ => _.name === commandName ||
         getCommandName(_) === commandName ||
         _.aliases?.includes(commandName),
  )
}
```

`getCommands(cwd)` (第 476 行) 返回所有可用命令，包含：
- 内置命令 `COMMANDS()` (第 258 行)
- 技能目录命令 `skillDirCommands`
- 插件命令 `pluginCommands`
- 工作流命令 `workflowCommands`
- 捆绑技能 `bundledSkills`
- 动态技能 `dynamicSkills`

**状态转换**: 找到命令 -> 返回 `Command` 对象；未找到 -> `undefined`

**错误处理**:
- `getCommand` (第 704 行): 未找到时抛出 `ReferenceError`
- `MalformedCommandError` (processSlashCommand.tsx:820): 未知命令时抛出

---

### 步骤 6: 命令 Handler 执行

**文件**: `src/utils/processUserInput/processSlashCommand.tsx:817-825`

命令分为三种类型，各有不同的 handler：

#### 6a: `prompt` 类型命令 (技能/提示命令)

```typescript
export async function processPromptSlashCommand(
  commandName: string, args: string, commands: Command[], context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[] = []
): Promise<SlashCommandResult> {
  const command = findCommand(commandName, commands);
  if (!command) throw new MalformedCommandError(`Unknown command: ${commandName}`);
  return getMessagesForPromptSlashCommand(command, args, context, [], imageContentBlocks);
}
```

执行流程:
1. `command.getPromptForCommand(args, context)` (第 869 行): 获取命令的提示内容
2. 技能 hook 注册 (第 875-878 行): `registerSkillHooks`
3. 附件提取 (第 897 行): 从命令输出中提取附件
4. 返回 `{ messages, shouldQuery: true }` (第 855-867 行)

**状态转换**: `/command` -> `UserMessage[] + shouldQuery: true`

#### 6b: `local-jsx` 类型命令 (交互式 UI 命令)

**文件**: `src/screens/REPL.tsx:3208-3280` (立即可执行路径)

1. `matchingCommand.load()` (第 3264 行): 动态加载命令模块
2. `mod.call(onDone, context, commandArgs)` (第 3265 行): 调用命令 handler
3. 返回 JSX 渲染 (第 3272-3276 行): `setToolJSX({ jsx, shouldHidePromptInput: false, isLocalJSXCommand: true })`
4. 命令完成后 `onDone(result)` 被调用 (第 3210-3257 行):
   - 清除 JSX: `setToolJSX({ jsx: null, ... })`
   - 通知: `addNotification({ text: result })`
   - 恢复暂存提示: `setInputValue(stashedPrompt.text)`

**状态转换**: `toolJSX: null -> <CommandUI/> -> null`

#### 6c: `local` 类型命令 (本地文本命令)

执行命令的 `handler(args, context)` 函数，返回文本输出。

---

### 步骤 7: 消息/状态变更

根据命令类型：

- **prompt 命令**: 消息追加到对话，`shouldQuery: true` 触发 API 调用
- **local-jsx 命令**: `setToolJSX` 渲染 UI，不触发 API
- **local 命令**: 输出包装在 `<local-command-stdout>` 标签中，`shouldQuery: false`

**文件**: `src/QueryEngine.ts:556-638`

当 `shouldQuery === false` 时，QueryEngine 直接 yield 结果而不进入查询循环：

```typescript
if (!shouldQuery) {
  for (const msg of messagesFromUserInput) {
    // yield 本地命令输出消息
  }
  yield { type: 'result', subtype: 'success', ... };
  return;
}
```

---

### 步骤 8: UI 更新

- **prompt 命令**: 进入 Journey A 的步骤 9-17 (API 调用循环)
- **local-jsx 命令**: React 渲染命令 UI 组件
- **local 命令**: 输出作为 `system` 类型消息渲染在对话流中

**错误处理**:
- 命令加载失败: 错误日志 + 通知
- 命令执行失败: 取决于各命令的实现
- 未知命令: `MalformedCommandError` -> 用户看到错误提示

---

## Journey C: IDE Bridge 交互 (IDE Bridge Interaction)

> IDE发送消息 -> bridgeMain.ts接收认证 -> 分发到session -> 查询执行 -> 结果流回bridge -> IDE渲染

### 步骤 1: IDE 发送消息

IDE (VS Code, JetBrains 等) 通过 CCR (Claude Code Remote) 协议发送消息到 bridge。

消息格式: HTTP POST 到 bridge API 的 poll 端点，work 数据包含:
- `type: 'session'`: 创建/恢复会话
- `id`: 会话 ID (cse_* 或 session_*)
- `secret`: JWT 编码的工作密钥

---

### 步骤 2: bridgeMain.ts 接收与认证

**文件**: `src/bridge/bridgeMain.ts:600-899`

`runBridgeLoop` 是 bridge 的主循环 (第 141 行)：

1. **轮询工作** (第 607-612 行): `api.pollForWork(environmentId, environmentSecret, loopSignal, reclaimMs)`
2. **空结果** (第 637-745 行): 无工作时休眠，支持心跳模式
3. **重新连接检测** (第 614-627 行): 断线后恢复时记录
4. **已完成工作去重** (第 758-784 行): `completedWorkIds` 防止重复处理
5. **工作密钥解码** (第 789-830 行): `decodeWorkSecret(work.secret)` 提取 JWT
6. **ACK 确认** (第 837-850 行): `api.acknowledgeWork(environmentId, work.id, token)`

**状态转换**: `connBackoff/generalBackoff: 0 -> n -> 0` (重连后重置)

**错误处理**:
- 连接错误: 指数退避重试 (第 322-323 行)
- 退避上限: `connCapMs: 120_000` / `generalCapMs: 30_000` (第 72-78 行)
- 放弃阈值: `connGiveUpMs: 600_000` / `generalGiveUpMs: 600_000` (10分钟)
- `BridgeFatalError`: 401/403/404/410 等不可恢复错误
- 密钥解码失败: `stopWork` + 标记完成 (第 792-810 行)

---

### 步骤 3: 会话创建与分发

**文件**: `src/bridge/bridgeMain.ts:859-1048`

`case 'session':` 分支处理会话工作：

1. **ID 验证** (第 861-867 行): `validateBridgeId(sessionId, 'session_id')`
2. **现有会话检查** (第 873-886 行): 如果会话已在运行，更新 access token
3. **容量检查** (第 891-896 行): `activeSessions.size >= config.maxSessions` 时拒绝新会话
4. **ACK 确认** (第 898 行): `await ackWork()`
5. **CCR v2 路径** (第 914-961 行):
   - `buildCCRv2SdkUrl(config.apiBaseUrl, sessionId)` (第 918 行)
   - `registerWorker(sdkUrl, secret.session_ingress_token)` (第 923 行): 注册为 worker
   - 重试一次 (第 921 行)
6. **CCR v1 路径** (第 960 行): `buildSdkUrl(config.sessionIngressUrl, sessionId)`
7. **工作树创建** (第 976-1015 行): `worktree` 模式下创建隔离 git 工作树
8. **Spawn 会话** (第 1026-1048 行): `safeSpawn(spawner, opts, dir)`

**状态转换**: `activeSessions: Map -> Map.set(sessionId, handle)`

**错误处理**:
- 无效 ID: 记录错误 + ACK (第 864-867 行)
- v2 注册失败: 重试一次，失败后 `stopWork` (第 932-957 行)
- 工作树创建失败: `stopWork` + 记录错误 (第 997-1013 行)
- Spawn 失败: `safeSpawn` 返回错误字符串 (第 127-139 行)

---

### 步骤 4: Session 子进程运行

**文件**: `src/bridge/sessionRunner.ts:1-100`

`createSessionSpawner` 创建会话 spawn 函数：

1. 子进程通过 `spawn(execPath, [...scriptArgs, '--sdk-url', sdkUrl, ...], { env, cwd: dir })` 启动 (sessionRunner.ts)
2. 子进程使用 `--sdk-url` 参数连接到 CCR 服务端
3. 通过 `stdin/stdout` JSON-lines 协议通信
4. `onActivity` 回调报告工具执行状态 (第 61 行)
5. `onPermissionRequest` 回调转发权限请求 (第 62-66 行)

**状态转换**: 子进程 `spawned -> running -> completed/failed/interrupted`

**错误处理**:
- Spawn 异常: `safeSpawn` 捕获并返回错误字符串 (第 127-139 行)
- 子进程崩溃: `onSessionDone` 处理 (第 442-591 行)

---

### 步骤 5: 子进程内查询执行

子进程运行独立的 Claude Code CLI 实例，执行完整的查询循环（同 Journey A 的步骤 6-17）：

1. `main.tsx` 初始化
2. SDK URL 参数触发 `--sdk-url` 模式
3. REPL 组件挂载
4. 用户消息通过 WebSocket 从 IDE 到达
5. 走 `QueryEngine.submitMessage()` 路径
6. API 调用、工具执行、流式响应
7. 结果通过 SDK 消息协议流回

**文件**: `src/QueryEngine.ts:209-675`

SDK 模式下的 `submitMessage`:
1. `processUserInput` (第 416 行)
2. 消息持久化 `recordTranscript` (第 450-463 行)
3. 进入 `query()` 流循环 (第 675 行)
4. Yield SDK 消息类型: `SDKUserMessageReplay`, `SDKAssistantMessage`, `SDKCompactBoundaryMessage` 等

---

### 步骤 6: 结果流回 Bridge

**文件**: `src/bridge/bridgeMain.ts:442-591`

子进程完成后，`onSessionDone` 处理结果：

1. **会话清理** (第 448-463 行): 从 `activeSessions` 等映射中删除
2. **状态判断** (第 499-517 行):
   - `completed`: 成功完成
   - `failed`: 进程错误退出
   - `interrupted`: 被中断（服务端或关闭）
3. **stopWork** (第 522-533 行): 通知服务端工作已完成
4. **工作树清理** (第 536-551 行): `removeAgentWorktree`
5. **生命周期决策** (第 553-585 行):
   - `single-session` 模式: 中止循环，bridge 退出
   - 多会话模式: 归档会话，继续轮询

**状态转换**: `activeSessions.size: n -> n-1` | 会话状态 `running -> completed/failed/interrupted`

**错误处理**:
- `stopWork` 失败: 重试 (stopWorkWithRetry)
- 工作树清理失败: 记录日志但不影响流程
- 归档失败: 记录日志但不影响流程

---

### 步骤 7: 结果流回 IDE

1. 子进程的 stdout 输出 (JSON 格式的 SDK 消息) 被 CCR 服务端捕获
2. CCR 服务端通过 WebSocket/SSE 推送到 IDE 客户端
3. IDE 客户端解析并渲染：
   - `assistant` 消息: 渲染为 AI 回复
   - `tool_use` 消息: 显示工具调用状态
   - `result` 消息: 显示最终结果和费用
   - `compact_boundary`: 处理上下文压缩

**状态转换**: IDE UI 更新显示新消息

**错误处理**:
- WebSocket 断线: 自动重连 (bridgeMain.ts:614-627)
- JWT 过期: 主动刷新 (bridgeMain.ts:284-313)
- v2 令牌刷新: `reconnectSession` 触发服务端重新分发 (第 292-306 行)

---

## 三条旅程的对比总结

| 维度 | Journey A (交互式聊天) | Journey B (Slash 命令) | Journey C (Bridge) |
|------|----------------------|----------------------|-------------------|
| **入口** | PromptInput.onSubmit | PromptInput.onSubmit | bridgeMain.ts pollForWork |
| **输入解析** | processUserInput (text) | processSlashCommand | SDK URL + WebSocket |
| **命令查找** | 无 | findCommand() | 无 (子进程独立) |
| **系统提示** | REPL 组装 | 视命令类型 | QueryEngine 组装 |
| **API 调用** | query() 流式循环 | prompt 命令才调用 | 子进程内 query() |
| **权限检查** | useCanUseTool | 通常不需要 | control_request 协议 |
| **工具执行** | StreamingToolExecutor | 通常不需要 | 子进程内执行 |
| **UI 渲染** | React (Ink terminal) | React JSX / 文本 | IDE 客户端渲染 |
| **消息持久化** | useLogMessages + recordTranscript | 记录命令输出 | 子进程内 recordTranscript |
| **主要错误** | API 超时/限流 | 未知命令 | 连接断开/JWT 过期 |
| **重试策略** | withRetry (API 层) | 无 | 指数退避 (连接层) |

---

## 关键文件索引

| 文件 | 作用 |
|------|------|
| `src/components/PromptInput/PromptInput.tsx` | 用户输入捕获与提交 |
| `src/hooks/useInputBuffer.ts` | 输入缓冲与撤销 |
| `src/screens/REPL.tsx` | REPL 主屏幕，查询调度 |
| `src/utils/handlePromptSubmit.ts` | 提交处理与路由 |
| `src/utils/processUserInput/processUserInput.ts` | 输入解析核心 |
| `src/utils/processUserInput/processSlashCommand.tsx` | 斜杠命令处理 |
| `src/commands.ts` | 命令注册与查找 |
| `src/QueryEngine.ts` | SDK/Headless 查询引擎 |
| `src/query.ts` | 查询循环核心 |
| `src/services/api/claude.ts` | API 流式调用 |
| `src/services/tools/StreamingToolExecutor.ts` | 流式工具执行器 |
| `src/hooks/useCanUseTool.tsx` | 权限检查 hook |
| `src/utils/messages.ts` | 消息处理 (handleMessageFromStream) |
| `src/bridge/bridgeMain.ts` | Bridge 主循环 |
| `src/bridge/sessionRunner.ts` | 会话 spawn 管理 |