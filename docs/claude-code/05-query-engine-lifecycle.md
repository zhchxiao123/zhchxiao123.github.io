---
title: "Step 5: QueryEngine 生命周期与查询状态机"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/05-query-engine-lifecycle/
---


> 分析日期: 2026-04-16
> 核心文件: QueryEngine.ts (1,296行), query.ts (~1,500行), services/api/withRetry.ts, services/compact/

---

## 1. QueryEngine 状态机

```
                 +------------------+
                 |     INITIAL      |  submitMessage() 被调用
                 +--------+---------+
                          |
                          v
          +---------------+---------------+
          |  SYSTEM_PROMPT_CONSTRUCTION    |  组装 systemPrompt + userContext
          +---------------+---------------+
                          |
                          v
          +---------------+---------------+
          |  PROCESS_USER_INPUT           |  processUserInput() 处理用户输入
          +---------------+---------------+
                          |
                   shouldQuery?
                  /            \
                NO              YES
                |                |
                v                v
          +------+     +--------+---------+
          | DONE |     |  QUERY_LOOP      |  query() 异步生成器
          +------+     +--------+---------+
                                |
                    +-----------+-----------+
                    |                       |
             +------+------+        +-------+------+
             | STREAMING   |        | NO_QUERY     |
             | (API 调用)  |        | (斜杠命令)   |
             +------+------+        +--------------+
                    |
         +----------+----------+
         |                     |
   needsFollowUp?          !needsFollowUp
   (tool_use 块)            (end_turn / error)
         |                     |
         v                     v
  +------+------+     +--------+--------+
  | TOOL_EXEC   |     | RECOVERY_CHECK  |
  | runTools()  |     | prompt-too-long?|
  +------+------+     | max_output_tok? |
         |            | stop_hooks?     |
         |            +--------+--------+
         |                     |
         v                recoverable?
  +------+------+          /        \
  | COMPACT     |        YES        NO
  | CHECK       |         |          |
  +------+------+         v          v
         |          +------+--+  +--+------+
         v          | COMPACT |  | DONE    |
  +------+------+   | (反应式  |  | (错误) |
  | STREAMING   |<--+  或     |  +--------+
  | (下一轮 API  |   | 主动)   |
  |  调用)       |   +---------+
  +------+------+
```

---

## 2. QueryEngineConfig 类型

`QueryEngineConfig` 定义了 `QueryEngine` 的完整配置接口（`QueryEngine.ts:130-173`）:

| 字段 | 类型 | 用途 |
|------|------|------|
| `cwd` | `string` | 当前工作目录 |
| `tools` | `Tools` | 可用工具列表 |
| `commands` | `Command[]` | 斜杠命令定义 |
| `mcpClients` | `MCPServerConnection[]` | MCP 服务器连接 |
| `agents` | `AgentDefinition[]` | Agent 定义列表 |
| `canUseTool` | `CanUseToolFn` | 权限检查回调 |
| `getAppState` | `() => AppState` | 读取应用状态 |
| `setAppState` | `(f: (prev: AppState) => AppState) => void` | 更新应用状态 |
| `initialMessages` | `Message[]?` | 初始消息（会话恢复） |
| `readFileCache` | `FileStateCache` | 文件状态缓存 |
| `customSystemPrompt` | `string?` | 自定义系统提示（SDK） |
| `appendSystemPrompt` | `string?` | 追加系统提示段落 |
| `userSpecifiedModel` | `string?` | 用户指定模型 |
| `fallbackModel` | `string?` | 回退模型 |
| `thinkingConfig` | `ThinkingConfig?` | 思考模式配置 |
| `maxTurns` | `number?` | 最大对话轮数 |
| `maxBudgetUsd` | `number?` | USD 预算上限 |
| `taskBudget` | `{ total: number }?` | API task_budget |
| `jsonSchema` | `Record<string, unknown>?` | 结构化输出 JSON Schema |
| `verbose` | `boolean?` | 详细输出模式 |
| `replayUserMessages` | `boolean?` | 回放用户消息 |
| `handleElicitation` | `ToolUseContext['handleElicitation']?` | MCP 需求处理 |
| `includePartialMessages` | `boolean?` | 包含部分流式消息 |
| `setSDKStatus` | `(status: SDKStatus) => void?` | SDK 状态更新 |
| `abortController` | `AbortController?` | 外部中止控制器 |
| `orphanedPermission` | `OrphanedPermission?` | 孤立权限处理 |
| `snipReplay` | `(yieldedSystemMsg, store) => ...?` | Snip 边界处理回调 |

---

## 3. submitMessage() 伪代码（8 阶段）

```python
async generator submitMessage(prompt, options?):
    # ====== 阶段 1: 初始化 ======
    discoveredSkillNames.clear()
    setCwd(cwd)
    persistSession = !isSessionPersistenceDisabled()
    startTime = Date.now()
    wrappedCanUseTool = wrap(canUseTool)  # 追踪权限拒绝

    # ====== 阶段 2: 系统提示构建 ======
    { defaultSystemPrompt, userContext, systemContext } =
        await fetchSystemPromptParts(tools, mainLoopModel, ...)
    systemPrompt = assemble([
        customPrompt ?? defaultSystemPrompt,
        memoryMechanicsPrompt,  # CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
        appendSystemPrompt,
    ])
    if jsonSchema AND hasStructuredOutputTool:
        registerStructuredOutputEnforcement()

    # ====== 阶段 3: 处理用户输入 ======
    processUserInputContext = buildContext(messages, tools, ...)
    if orphanedPermission AND !hasHandledOrphanedPermission:
        yield* handleOrphanedPermission(...)
    { messagesFromUserInput, shouldQuery, allowedTools, model, resultText } =
        await processUserInput({ input: prompt, context, ... })
    mutableMessages.push(...messagesFromUserInput)
    updateToolPermissionContext(allowedTools)
    mainLoopModel = model ?? initialMainLoopModel
    rebuildProcessUserInputContext()  # 斜杠命令可能修改消息/模型

    # ====== 阶段 4: 技能与插件发现 ======
    [skills, { enabled: enabledPlugins }] = await Promise.all([
        getSlashCommandToolSkills(cwd),
        loadAllPluginsCacheOnly(),
    ])
    yield buildSystemInitMessage({ tools, mcpClients, model, ... })

    # ====== 阶段 5: 早期退出 ======
    if !shouldQuery:
        # 斜杠命令结果
        yield localCommandOutputs
        yield compact_boundaries
        yield { type: 'result', subtype: 'success', ... }
        return

    # ====== 阶段 6: 文件历史快照 ======
    if fileHistoryEnabled AND persistSession:
        fileHistoryMakeSnapshot(each selectableUserMessage)

    # ====== 阶段 7: 主查询循环 ======
    for await (message of query({ messages, systemPrompt, canUseTool, ... })):
        switch message.type:
            case 'assistant':  yield* normalizeMessage(); track usage/stop_reason
            case 'user':       turnCount++; yield* normalizeMessage()
            case 'progress':  yield* normalizeMessage()
            case 'attachment':
                if max_turns_reached:  yield error_max_turns; return
                if structured_output:  store for result
                if queued_command:     yield replay
            case 'stream_event':
                if message_start:   reset usage
                if message_delta:   update usage, capture stop_reason
                if message_stop:    accumulate usage
            case 'system':
                if snip_boundary:   replay, splice mutableMessages
                if compact_boundary: yield SDK message, release pre-compact GC
                if api_error:       yield api_retry event
            case 'tool_use_summary': yield summary

        # ====== 预算检查（每轮） ======
        if maxBudgetUsd AND getTotalCost() >= maxBudgetUsd:
            yield error_max_budget_usd; return
        if jsonSchema AND structuredOutputRetries >= maxRetries:
            yield error_max_structured_output_retries; return

    # ====== 阶段 8: 结果判定 ======
    result = messages.findLast(assistant | user)
    if !isResultSuccessful(result, lastStopReason):
        yield { type: 'result', subtype: 'error_during_execution', ... }
        return
    extract textResult from result
    yield { type: 'result', subtype: 'success', result: textResult, ... }
```

---

## 4. 预算/轮次追踪（三层体系）

```
+---------------------------------------------------+
|  Layer 1: maxBudgetUsd                            |
|  - 每个 submitMessage() 循环中检查 getTotalCost()  |
|  - 超出即 yield error_max_budget_usd 并返回       |
|  - 粒度: USD 级别                                 |
+---------------------------------------------------+
|  Layer 2: maxTurns                                |
|  - query() 内部追踪 turnCount                     |
|  - 超出 yield attachment(max_turns_reached)       |
|  - QueryEngine 捕获并 yield error_max_turns        |
|  - 粒度: 对话轮次（assistant+user = 1 turn）      |
+---------------------------------------------------+
|  Layer 3: taskBudget                              |
|  - API output_config.task_budget                  |
|  - 跨 compact 边界追踪 remaining                  |
|  - 每次 compact: remaining -= finalContextTokens  |
|  - 传递给 claude.ts 的 configureTaskBudgetParams  |
|  - 粒度: API token 用量                           |
+---------------------------------------------------+
```

---

## 5. 压缩级联: Snip -> Microcompact -> Context Collapse -> Autocompact -> Reactive Compact

每次 `query()` 循环迭代时，在 API 调用前依次执行 5 级压缩:

```
消息流:  messagesForQuery
              |
              v
    +---------+---------+
    | 1. Snip           |  HISTORY_SNIP feature
    | snipCompactIfNeed |  基于标记裁剪僵尸消息
    | tokensFreed 追踪  |  -> yield boundaryMessage
    +---------+---------+
              |
              v
    +---------+---------+
    | 2. Microcompact   |  CACHED_MICROCOMPACT feature
    | deps.microcompact |  缓存编辑/回放压缩
    | pendingCacheEdits |  延迟边界消息到 API 响应后
    +---------+---------+
              |
              v
    +---------+---------+
    | 3. Context Collapse|  CONTEXT_COLLAPSE feature
    | applyCollapsesIf  |  提交已暂存的折叠
    | Needed            |  不 yield 消息（只投影视图）
    +---------+---------+
              |
              v
    +---------+---------+
    | 4. Autocompact    |  主动压缩
    | deps.autocompact |  超阈值则调用 compact API
    | buildPostCompact  |  yield postCompactMessages
    | Messages          |  tracking 重置
    +---------+---------+
              |
              v
    +---------+---------+
    | 5. Reactive       |  REACTIVE_COMPACT feature
    | Compact           |  413/prompt-too-long 后触发
    | (仅在恢复路径)    |  yield postCompactMessages
    +-------------------+
```

**关键细节**:
- Snip 在 Microcompact 之前运行，`snipTokensFreed` 传递给 Autocompact 以校准阈值
- Context Collapse 在 Autocompact 之前运行 —— 如果折叠使上下文低于阈值，Autocompact 不会执行（保留粒度上下文）
- Reactive Compact 只在 API 返回 413 后触发，是最后的恢复手段
- 每次 compact 会计算 `taskBudgetRemaining` 的递减

---

## 6. 错误扣留模式 (Error Withholding Pattern)

query.ts 的流式循环中，某些**可恢复错误**被扣留（withheld），不 yield 给 SDK 调用者:

```
流式消息 -> 扣留检查:
  |
  +-- isWithheldPromptTooLong(message)?
  |     CONTEXT_COLLAPSE + contextCollapse.isWithheldPromptTooLong()
  |     REACTIVE_COMPACT + reactiveCompact.isWithheldPromptTooLong()
  |
  +-- isWithheldMediaSizeError(message)?
  |     reactiveCompact.isWithheldMediaSizeError()
  |
  +-- isWithheldMaxOutputTokens(message)?
  |     message.apiError === 'max_output_tokens'
  |
  +-- 任一为 true -> withheld = true, 不 yield
```

**设计理由**: SDK 消费者（如 claude-desktop、cowork）在收到任何 `error` 字段时可能终止会话。扣留可恢复错误允许恢复逻辑（折叠排空、反应式 compact、max_output_tokens 重试）在错误暴露给调用者之前尝试修复。如果恢复成功，错误永远不会被看到；如果恢复失败，错误在恢复穷尽后才 yield。

---

## 7. 模型回退流程 (FallbackTriggeredError)

```
withRetry.ts (API 重试循环):
  |
  +-- 连续 529 错误计数 >= MAX_529_RETRIES (3)
  |     |
  |     +-- 有 fallbackModel?
  |           |
  |           YES: throw FallbackTriggeredError(originalModel, fallbackModel)
  |                （穿透 claude.ts 的 catch 块向上传播）
  |
query.ts (主循环):
  |
  +-- catch (innerError instanceof FallbackTriggeredError)
        |
        +-- currentModel = fallbackModel
        +-- yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')
        +-- 清空: assistantMessages, toolResults, toolUseBlocks
        +-- streamingToolExecutor.discard() + 重建
        +-- toolUseContext.options.mainLoopModel = fallbackModel
        +-- stripSignatureBlocks(messagesForQuery)  # thinking 签名模型绑定
        +-- yield 系统消息: "Switched to {fallbackModel} due to high demand..."
        +-- continue (重试整个 API 请求)
```

**关键特性**:
- `FallbackTriggeredError` 必须穿透 `claude.ts` 的 catch 块（否则变成空操作）
- 回退时清除 thinking 签名块 —— 不同模型的签名格式不兼容，会导致 400 错误
- Streaming fallback（流式回退）也触发类似的重置: 墓碑消息清理孤儿助手消息

---

## 8. query() 返回的终止原因

| 原因 | 描述 |
|------|------|
| `completed` | 正常完成（end_turn / 无 tool_use / stop hook 无阻塞） |
| `aborted_streaming` | 流式中用户中止 (abortController.signal.aborted) |
| `aborted_tool_execution` | 工具执行中用户中止 |
| `prompt_too_long` | prompt-too-long 恢复失败 |
| `image_error` | 图片尺寸/调整错误 |
| `model_error` | API 抛出未处理异常 |
| `blocking_limit` | 达到硬阻塞限制且无法 compact |
| `stop_hook_prevented` | stop hook 返回 preventContinuation |

---

## 9. Continue 转换表

当 `query()` 循环不终止而是 `continue` 时，`State.transition` 记录原因:

| 原因 | 描述 |
|------|------|
| `next_turn` | 正常 tool_use 继续 |
| `collapse_drain_retry` | Context collapse 排空后 413 重试 |
| `reactive_compact_retry` | Reactive compact 成功后 413 重试 |
| `max_output_tokens_escalate` | 8k -> 64k max_tokens 重试 |
| `max_output_tokens_recovery` | 多轮 max_output_tokens 恢复（最多 3 次） |
| `stop_hook_blocking` | Stop hook 产生阻塞错误 |
| `token_budget_continuation` | Token 预算自动继续 |

---

## 10. API 调用流 (queryModel 流式管线)

```
query.ts::queryLoop()
  |
  +-- deps.callModel()  (即 queryModelWithStreaming)
        |
        +-- 构建 API 请求:
        |     prependUserContext(messages, userContext)
        |     fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
        |     options: { model, tools, thinkingConfig, maxOutputTokensOverride,
        |              fallbackModel, querySource, taskBudget, ... }
        |
        +-- withRetry(getClient, operation, retryOptions):
        |     |
        |     +-- for attempt 1..maxRetries+1:
        |     |     |
        |     |     +-- 获取/刷新 client (认证错误时)
        |     |     +-- operation(client, attempt, retryContext)
        |     |     |     = claude.ts::createResponse()
        |     |     |       -> client.messages.create({ stream: true, ... })
        |     |     |       -> yield 流式事件
        |     |     |
        |     |     +-- catch 错误分类:
        |     |           529/429 + foreground -> 重试
        |     |           529 + !foreground -> CannotRetryError
        |     |           529 x 3 + fallbackModel -> FallbackTriggeredError
        |     |           认证错误 -> 刷新 token, 重建 client
        |     |           上下文溢出 -> 调整 maxTokens, 重试
        |     |           其他不可重试 -> CannotRetryError
        |     |
        |     +-- yield SystemAPIErrorMessage (重试通知)
        |
        +-- 流式事件循环:
              for await (event of stream):
                message_start:   创建 AssistantMessage
                content_block_start/stop: 构建内容块
                tool_use:        StreamingToolExecutor.addTool() (流式执行)
                text:            追加文本块
                thinking:        追加思考块
                message_delta:   更新 stop_reason, usage
                message_stop:    完成

              yield: AssistantMessage, StreamEvent
```

---

## 11. withRetry 错误分类与退避策略

### 错误分类

| 错误类型 | 处理策略 |
|----------|----------|
| **529 (Overloaded)** | 前台源: 重试最多 3 次; 后台源: 立即抛出 CannotRetryError |
| **429 (Rate Limit)** | 读取 retry-after 头; Fast mode: 短延迟保持/长延迟降速 |
| **401 (Auth)** | 刷新 OAuth token, 重建 client |
| **403 (Token Revoked)** | 强制 token 刷新, 重建 client |
| **ECONNRESET/EPIPE** | 禁用 keep-alive, 重建 client |
| **Bedrock/Vertex Auth** | 各自认证错误处理, 凭证刷新 |
| **上下文溢出 (400)** | 调整 maxTokens = contextLimit - inputTokens - 1000 |
| **Fast Mode Overage** | 永久禁用 Fast Mode, 降速重试 |
| **连续 529 x 3** | 触发 FallbackTriggeredError (如果有 fallbackModel) |

### 退避参数

| 参数 | 值 | 用途 |
|------|-----|------|
| `DEFAULT_MAX_RETRIES` | 10 | 默认最大重试次数 |
| `BASE_DELAY_MS` | 500 | 基础延迟 |
| `MAX_529_RETRIES` | 3 | 连续 529 触发回退的阈值 |
| `SHORT_RETRY_THRESHOLD_MS` | (未列) | 短重试阈值，保持 Fast Mode |
| `MIN_COOLDOWN_MS` | (未列) | Fast Mode 冷却最小时间 |
| `PERSISTENT_MAX_BACKOFF_MS` | 5 min | 持续重试模式最大退避 |
| `PERSISTENT_RESET_CAP_MS` | 6 hr | 持续重试重置上限 |
| `HEARTBEAT_INTERVAL_MS` | 30s | 持续重试心跳间隔 |
| `FLOOR_OUTPUT_TOKENS` | 3000 | 上下文溢出恢复最低输出 |

### 持续重试模式 (UNATTENDED_RETRY)

当 `CLAUDE_CODE_UNATTENDED_RETRY` 启用时（ant-only）:
- 对 429/529 无限重试
- 退避上限 5 分钟，每 6 小时重置
- 每 30 秒 yield 心跳消息防止宿主环境标记空闲