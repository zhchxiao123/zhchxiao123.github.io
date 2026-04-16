---
title: "Step 6: 工具调度管线"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/06-tool-dispatch-pipeline/
---


> 分析日期: 2026-04-16
> 核心文件: services/tools/StreamingToolExecutor.ts (531行), services/tools/toolExecution.ts (1,746行), services/tools/toolOrchestration.ts, Tool.ts

---

## 1. 端到端管线图

```
API tool_use 块流式到达
         |
         v
+--------+---------+
| StreamingTool    |  addTool(block, assistantMessage)
| Executor.addTool |  - findToolByName() 查找工具定义
|                  |  - inputSchema.safeParse() 解析+检查并发安全
|                  |  - 推入 TrackedTool 队列
+--------+---------+
         |
         v
+--------+---------+
| processQueue()   |  遍历队列，为满足并发条件的工具调用 executeTool()
|                  |  - canExecuteTool() 门控
+--------+---------+
         |
         v
+--------+---------+
| canExecuteTool() |  门控逻辑:
|       门控       |  无工具执行中 -> 任何工具可启动
|                  |  有工具执行中 -> 新工具仅在全部并发安全时启动
+--------+---------+
         |
   条件满足? YES
         |
         v
+--------+---------+
| executeTool()    |  设置 status='executing'
|                  |  updateInterruptibleState()
|                  |  创建 toolAbortController (子级)
|                  |  调用 runToolUse() 异步生成器
+--------+---------+
         |
         v
+--------+---------+
| runToolUse()     |  toolExecution.ts 入口
|                  |  构建上下文参数
|                  |  调用 streamedCheckPermissionsAndCallTool()
+--------+---------+
         |
         v
+--------+---------+
| streamedCheck   |  创建 Stream<MessageUpdateLazy>
| PermissionsAnd  |  异步调用 checkPermissionsAndCallTool()
| CallTool()      |  进度事件 -> stream.enqueue
|                  |  结果 -> stream.enqueue
|                  |  错误 -> stream.error
+--------+---------+
         |
         v
+--------+---------+
| checkPermissions | 6 阶段管线 (A-F)
| AndCallTool()    | 详见下文
+--------+---------+
         |
         v
+--------+---------+
| 结果 yield       | getCompletedResults() / getRemainingResults()
| + 消息更新       | 按接收顺序 yield (维护非并发工具的序列性)
+------------------+
```

---

## 2. checkPermissionsAndCallTool() 六阶段管线

### 阶段 A: 输入验证 (Input Validation)

```
tool.inputSchema.safeParse(input)
  |
  +-- 失败: -> InputValidationError
  |     附加 buildSchemaNotSentHint() (延迟工具未发现时)
  |     yield tool_use_error, return
  |
  +-- 成功: parsedInput.data
        |
        v
tool.validateInput?(parsedInput, toolUseContext)
  |
  +-- result === false: -> 验证错误消息
  |     yield tool_use_error, return
  |
  +-- result === true: 继续到阶段 B
```

**特殊处理**:
- `buildSchemaNotSentHint()`: 当延迟工具未出现在发现集合中时，提示模型先调用 ToolSearchTool
- Bash 工具: 推测性启动 `startSpeculativeClassifierCheck()` (与后续阶段并行)
- `_simulatedSedEdit` 字段: 深度防御剥离（仅供权限系统注入）

### 阶段 B: 前置工具 Hook (Pre-Tool Hooks)

```
runPreToolUseHooks(toolUseContext, tool, processedInput, toolUseID, ...)
  |
  +-- yield 多种结果类型:
  |     type: 'message'          -> 推入 resultingMessages
  |     type: 'hookPermissionResult' -> hookPermissionResult 变量
  |     type: 'hookUpdatedInput' -> 更新 processedInput (透传)
  |     type: 'preventContinuation' -> shouldPreventContinuation = true
  |     type: 'stopReason'       -> stopReason 变量
  |     type: 'additionalContext'-> 推入 resultingMessages
  |     type: 'stop'             -> yield stop 消息, return early
  |
  +-- 慢 Hook 日志: preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS
  +-- Ant-only: Hook 计时摘要消息
```

**backfillObservableInput**:
- 在 Pre-Tool Hook 之前对 `processedInput` 浅拷贝执行
- 添加遗留/派生字段（如 SendMessageTool 的额外字段、文件工具的 expandPath）
- 原始 `callInput` 保留模型发出的值（保证工具结果字符串和 VCR 夹具哈希稳定）
- Hook/权限后续返回的 `updatedInput` 覆盖 `processedInput`

### 阶段 C: 权限解析 (Permission Resolution)

```
resolveHookPermissionDecision(hookPermissionResult, tool, processedInput, ...)
  |
  +-- hookPermissionResult 存在?
  |     YES: 使用 hook 决定（allow/deny）
  |     NO:  调用 canUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)
  |
  +-- permissionDecision.behavior:
        'allow'  -> 继续到阶段 D
        'deny'   -> yield 拒绝消息 (含图片块), return
        'ask'    -> yield 拒绝消息 (含交互式内容块), return
```

**权限拒绝后处理**:
- 记录 OTel `tool_decision` 事件
- 分类器拒绝: 运行 PermissionDenied hooks，可能允许重试
- `shouldPreventContinuation` 无消息时使用通用 "Execution stopped by PreToolUse hook"

### 阶段 D: 工具执行 (Tool Execution)

```
tool.call(callInput, toolUseContext, canUseTool, assistantMessage, onProgress)
  |
  +-- callInput 收敛逻辑:
  |     如果 processedInput === backfilledClone: 使用 callInput (原始模型值)
  |     如果 processedInput !== backfilledClone: 使用 processedInput (hook 修改)
  |     特殊: hook 修改的 file_path 与 backfill 相同时恢复原始值
  |
  +-- 执行成功:
  |     result: ToolResult<Output>
  |     包含: data, newMessages?, contextModifier?, mcpMeta?
  |
  +-- 执行失败:
        异常捕获 -> yield tool_use_error
```

**toolUseContext 扩展**:
- 注入 `toolUseId` 和 `userModified` 标志
- 进度回调: `onProgress -> onToolProgress -> stream.enqueue(progressMessage)`

### 阶段 E: 结果映射 (Result Mapping)

```
tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)
  |
  +-- 计算 toolResultSizeBytes
  +-- 提取 fileExtension (Read/Edit/Write/Notebook/Bash)
  +-- 记录分析事件 (tengu_tool_use_success)
  +-- 记录 OTel 事件 (tool_result)
  +-- 处理结构化输出 (structured_output attachment)
  +-- processToolResultBlock(): 应用工具结果预算
        |
        +-- 超过 per-tool 阈值 (maxResultSizeChars)?
        |     持久化到磁盘, 返回预览 + 文件路径
        |
        +-- 超过 per-message 预算?
              与同批其他工具结果竞争, 最大块优先持久化
```

### 阶段 F: 后置工具 Hook (Post-Tool Hooks)

```
runPostToolUseHooks(toolUseContext, tool, toolOutput, toolUseID, ...)
  |
  +-- hook 结果处理:
  |     修改 toolOutput (hook 返回新输出)
  |     shouldPreventContinuation -> 标记阻止继续
  |     额外消息 -> 推入 resultingMessages
  |
  +-- 最终:
       重新映射 (如果 hook 修改了输出)
       返回 resultingMessages (MessageUpdateLazy[])
```

---

## 3. 并发模型

### canExecuteTool() 门控逻辑

```typescript
canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||  // 无工具执行中 -> 任何工具可启动
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    // 有工具执行中 -> 新工具必须并发安全，且所有执行中工具也并发安全
  )
}
```

### isConcurrencySafe 工具分类表

| 工具 | isConcurrencySafe | 原因 |
|------|-------------------|------|
| **Bash** | `true` (独立命令) | 并行 shell 命令安全 |
| **FileReadTool** | `true` | 只读操作 |
| **GlobTool** | `true` | 只读搜索 |
| **GrepTool** | `true` | 只读搜索 |
| **WebFetchTool** | `true` | 独立网络请求 |
| **WebSearchTool** | `true` | 独立网络请求 |
| **LSPTool** | `true` | 独立 LSP 请求 |
| **FileEditTool** | `false` (默认) | 文件修改需独占 |
| **FileWriteTool** | `false` (默认) | 文件修改需独占 |
| **NotebookEditTool** | `false` (默认) | 文件修改需独占 |
| **AgentTool** | `false` (默认) | 子 agent 修改状态 |
| **TodoWriteTool** | `false` (默认) | 状态修改 |
| **SkillTool** | `false` (默认) | 可能执行修改操作 |
| **MCP 工具** | `false` (默认) | 未知副作用 |
| **ConfigTool** | `false` (默认) | 配置修改 |

> 注: 默认值为 `false` (来自 `TOOL_DEFAULTS.isConcurrencySafe = () => false`)

### 兄弟错误级联 (Sibling Error Cascade)

```
工具 A (Bash) 执行中... -> 失败 (is_error=true)
  |
  +-- 工具 A 是 Bash?
  |     YES: this.hasErrored = true
  |          this.erroredToolDescription = getToolDescription(A)
  |          this.siblingAbortController.abort('sibling_error')
  |          -> 所有执行中的非 Bash 兄弟工具收到 synthetic error
  |          -> "Cancelled: parallel tool call {desc} errored"
  |
  +-- 工具 A 非 Bash?
        NO: 不级联。其他工具继续执行
            (Read/WebFetch 等独立失败不应终止其余)
```

**设计理由**: Bash 命令通常有隐式依赖链（如 `mkdir` 失败后续命令无意义），而只读工具独立失败不影响其他。

---

## 4. 中止控制器层级

```
toolUseContext.abortController (父级)
  |
  +-- 原因: 'interrupt' (用户输入新消息)
  |       'user_abort' (用户 Ctrl+C)
  |       其他工具特定原因
  |
  +-- siblingAbortController (子级)
  |     由 toolUseContext.abortController 派生
  |     Bash 错误时 abort('sibling_error')
  |     不终止父级 -> query 循环继续
  |
  +-- toolAbortController (孙级, 每个工具独立)
        由 siblingAbortController 派生
        权限对话框拒绝时 abort
        abort 事件冒泡到父级:
          if reason !== 'sibling_error'
             AND !toolUseContext.abortController.signal.aborted
             AND !this.discarded:
            this.toolUseContext.abortController.abort(reason)
            -> 终止整个查询轮次
```

**冒泡设计**: 权限拒绝（如 ExitPlanMode 的 "clear context + auto" 发出 REJECT_MESSAGE）需要冒泡到查询级别才能正确终止回合，否则模型收到 REJECT_MESSAGE 而不是中止信号。

---

## 5. 中断行为: 'cancel' vs 'block'

| 行为 | 描述 | 适用场景 |
|------|------|----------|
| `cancel` | 用户输入新消息时停止工具并丢弃结果 | 短期只读操作: Bash (某些命令), WebFetch |
| `block` | 保持运行，新消息等待 | 长期/修改操作: FileEdit, FileWrite, AgentTool |

**实现细节**:

```typescript
// StreamingToolExecutor
getToolInterruptBehavior(tool): 'cancel' | 'block' {
  const definition = findToolByName(this.toolDefinitions, tool.block.name)
  if (!definition?.interruptBehavior) return 'block'  // 默认 block
  return definition.interruptBehavior()
}

// 中断检查
updateInterruptibleState() {
  const executing = this.tools.filter(t => t.status === 'executing')
  this.toolUseContext.setHasInterruptibleToolInProgress?.(
    executing.length > 0 &&
    executing.every(t => this.getToolInterruptBehavior(t) === 'cancel')
  )
}
```

**中断流程**:
1. 用户在工具执行中输入新消息
2. `abortController.abort('interrupt')`
3. `getAbortReason()` 检查:
   - 如果 `reason === 'interrupt'`:
     - `interruptBehavior === 'cancel'` -> 返回 `'user_interrupted'`，生成 synthetic error
     - `interruptBehavior === 'block'` -> 返回 `null`，工具继续执行
   - 其他 abort -> 返回 `'user_interrupted'`

---

## 6. Streaming Fallback 处理

当 API 在流式响应中途触发 fallback（如 529）时:

```
streamingFallbackOccured = true
  |
  +-- 1. 墓碑处理: yield { type: 'tombstone', message } 对所有孤儿助手消息
  |     (thinking 块的签名无效，会导致 "thinking blocks cannot be modified" 400)
  |
  +-- 2. 清空状态: assistantMessages, toolResults, toolUseBlocks, needsFollowUp
  |
  +-- 3. 工具执行器重置:
        streamingToolExecutor.discard()   # 丢弃所有待处理/进行中的工具
        streamingToolExecutor = new StreamingToolExecutor(...)  # 重建
        # 防止旧 tool_use_id 的 tool_result 泄漏到重试响应
  |
  +-- 4. 模型切换:
        currentModel = fallbackModel
        toolUseContext.options.mainLoopModel = fallbackModel
        stripSignatureBlocks(messagesForQuery)  # ant-only
  |
  +-- 5. 重试: continue (while attemptWithFallback)
```

---

## 7. 结果收集与 yield 顺序

### getCompletedResults() (非阻塞)

```
for each tool in this.tools:
  1. yield 所有 pendingProgress 消息 (立即)
  2. if status === 'yielded': skip
  3. if status === 'completed' AND results:
       标记 'yielded'
       yield 每条 result 消息
       markToolUseAsComplete()
  4. if status === 'executing' AND !isConcurrencySafe:
       break  # 维护非并发工具的序列性
```

### getRemainingResults() (阻塞等待)

```
while hasUnfinishedTools():
  await processQueue()
  yield getCompletedResults()

  if hasExecutingTools() AND !hasCompletedResults() AND !hasPendingProgress():
    await Promise.race([...executingPromises, progressPromise])
    # 等待任一工具完成或进度可用

yield final getCompletedResults()
```

**进度优先**: `pendingProgress` 消息在任何状态下都立即 yield，不等待工具完成。这确保了用户界面能在工具执行期间显示进度（如 Bash 命令的实时输出）。