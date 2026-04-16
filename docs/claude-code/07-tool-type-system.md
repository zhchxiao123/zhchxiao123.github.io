---
title: "Step 7: 工具类型系统"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/07-tool-type-system/
---


> 分析日期: 2026-04-16
> 核心文件: Tool.ts (793行), tools.ts (390行), utils/toolSearch.ts, tools/ToolSearchTool/prompt.ts, constants/toolLimits.ts

---

## 1. Tool<Input, Output, P> 类型契约

`Tool` 是所有工具的核心类型定义，三个泛型参数:
- `Input`: Zod schema 类型（必须输出 `object`）
- `Output`: `call()` 返回的数据类型
- `P`: 进度数据类型（`ToolProgressData` 子类型）

### 方法/属性分类

#### 身份与发现 (Identity & Discovery)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `name` | `readonly string` | 工具主名称 |
| `aliases` | `string[]?` | 向后兼容的别名列表 |
| `searchHint` | `string?` | ToolSearch 关键词匹配提示（3-10 词） |
| `isMcp` | `boolean?` | 是否为 MCP 工具 |
| `isLsp` | `boolean?` | 是否为 LSP 工具 |
| `mcpInfo` | `{ serverName, toolName }?` | MCP 原始服务器/工具名 |

#### Schema (模式)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `inputSchema` | `Input` (Zod schema) | 输入验证模式 |
| `inputJSONSchema` | `ToolInputJSONSchema?` | MCP 直接指定 JSON Schema |
| `outputSchema` | `z.ZodType<unknown>?` | 输出模式（可选） |

#### 核心执行 (Core Execution)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `call(args, context, canUseTool, parentMessage, onProgress?)` | `Promise<ToolResult<Output>>` | 执行工具 |
| `description(input, options)` | `Promise<string>` | 生成工具描述文本（发送给 API） |
| `prompt(options)` | `Promise<string>` | 生成工具提示段落（含权限上下文） |

#### 权限与验证 (Permission & Validation)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `validateInput?(input, context)` | `Promise<ValidationResult>` | 输入值验证（Zod 之后） |
| `checkPermissions(input, context)` | `Promise<PermissionResult>` | 权限检查（validateInput 通过后） |
| `getPath?(input)` | `string` | 提取文件路径（用于权限匹配） |
| `preparePermissionMatcher?(input)` | `Promise<(pattern: string) => boolean>` | Hook if 条件匹配器 |

#### 行为分类 (Behavioral Classification)

| 属性/方法 | 类型 | 默认 | 用途 |
|-----------|------|------|------|
| `isEnabled()` | `boolean` | `true` | 工具是否启用 |
| `isReadOnly(input)` | `boolean` | `false` | 是否只读操作 |
| `isConcurrencySafe(input)` | `boolean` | `false` | 是否可并行执行 |
| `isDestructive?(input)` | `boolean` | `false` | 是否不可逆操作 |
| `isOpenWorld?(input)` | `boolean` | - | 是否开放世界（网络访问等） |
| `interruptBehavior?()` | `'cancel' \| 'block'` | `'block'` | 用户中断时的行为 |
| `requiresUserInteraction?()` | `boolean` | - | 是否需要用户交互 |
| `isSearchOrReadCommand?(input)` | `{ isSearch, isRead, isList? }` | - | UI 折叠分类 |
| `isTransparentWrapper?()` | `boolean` | - | 透明包装器（委托渲染） |
| `strict` | `readonly boolean?` | - | API 严格模式标志 |

#### 延迟加载 (Defer Loading)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `shouldDefer` | `readonly boolean?` | 工具标记为延迟（需 ToolSearch 加载） |
| `alwaysLoad` | `readonly boolean?` | 始终加载（不延迟，即使 ToolSearch 启用） |

#### 输入变换 (Input Transformation)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `backfillObservableInput?(input)` | `void` | 在观察者看到之前回填遗留/派生字段 |
| `inputsEquivalent?(a, b)` | `boolean` | 判断两次输入是否等价 |

#### 显示与渲染 (Display & Rendering) — 15+ 方法

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `userFacingName(input)` | `string` | 用户可见工具名 |
| `userFacingNameBackgroundColor?(input)` | `keyof Theme?` | 名称背景色 |
| `getToolUseSummary?(input)` | `string \| null` | 紧凑视图摘要 |
| `getActivityDescription?(input)` | `string \| null` | Spinner 活动描述 |
| `toAutoClassifierInput(input)` | `unknown` | 自动模式分类器输入 |
| `renderToolUseMessage(input, options)` | `React.ReactNode` | 工具使用消息渲染 |
| `renderToolResultMessage?(content, progress, options)` | `React.ReactNode` | 工具结果消息渲染 |
| `renderToolUseProgressMessage?(progress, options)` | `React.ReactNode` | 进度消息渲染 |
| `renderToolUseQueuedMessage?()` | `React.ReactNode` | 排队消息渲染 |
| `renderToolUseRejectedMessage?(input, options)` | `React.ReactNode` | 拒绝消息渲染 |
| `renderToolUseErrorMessage?(result, options)` | `React.ReactNode` | 错误消息渲染 |
| `renderToolUseTag?(input)` | `React.ReactNode` | 标签渲染（超时/模型等） |
| `renderGroupedToolUse?(toolUses, options)` | `React.ReactNode?` | 分组渲染（非详细模式） |
| `isResultTruncated?(output)` | `boolean` | 结果是否被截断 |
| `extractSearchText?(output)` | `string` | 转录搜索索引文本 |

#### API 序列化 (API Serialization)

| 属性/方法 | 类型 | 用途 |
|-----------|------|------|
| `mapToolResultToToolResultBlockParam(content, toolUseID)` | `ToolResultBlockParam` | 将工具输出映射为 API 格式 |
| `maxResultSizeChars` | `number` | 结果持久化到磁盘的字符阈值 |

---

## 2. 支撑类型

### ToolResult<T>

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  // contextModifier 仅对非并发安全工具生效
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

### ValidationResult

```typescript
type ValidationResult =
  | { result: true }                    // 验证通过
  | { result: false; message: string; errorCode: number }  // 验证失败
```

### ToolUseContext

工具执行上下文，携带约 30+ 字段:

| 字段 | 类型 | 用途 |
|------|------|------|
| `messages` | `Message[]` | 当前消息列表 |
| `options` | `{ tools, commands, mainLoopModel, thinkingConfig, mcpClients, ... }` | 执行选项 |
| `abortController` | `AbortController` | 中止控制器（父级） |
| `getAppState` | `() => AppState` | 读取应用状态 |
| `setAppState` | `(f) => void` | 更新应用状态 |
| `readFileState` | `FileStateCache` | 文件读取缓存 |
| `queryTracking` | `{ chainId, depth }?` | 查询链追踪 |
| `agentId` | `AgentId?` | 子 Agent ID |
| `toolDecisions` | `Map<string, ...>?` | 权限决策记录 |
| `contentReplacementState` | `ContentReplacementState?` | 工具结果替换状态 |
| `addNotification` | `(n: Notification) => void?` | 通知添加器 |
| `setInProgressToolUseIDs` | `(f) => void` | 进行中工具 ID 集合 |
| `setHasInterruptibleToolInProgress` | `((b: boolean) => void)?` | 可中断状态标记 |
| `handleElicitation` | `(params) => Promise<ElicitResult>?` | MCP 需求处理 |

### ToolPermissionContext

```typescript
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode           // 'default' | 'auto' | 'plan'
  alwaysAllowRules: { command: string[] }
  denyRules: { command: string[] }
  additionalWorkingDirectories: Map<string, ...>
  ...
}>
```

### Tools

```typescript
type Tools = readonly Tool[]
```

使用 `readonly` 而非 `Tool[]` 以便追踪工具集合的组装、传递和过滤。

---

## 3. buildTool() 和 TOOL_DEFAULTS

### 7 个可默认键及其默认值

| 键 | 默认值 | 设计理由 |
|-----|--------|----------|
| `isEnabled` | `() => true` | 默认启用 |
| `isConcurrencySafe` | `(_input?) => false` | 假设不安全（fail-closed） |
| `isReadOnly` | `(_input?) => false` | 假设写入（fail-closed） |
| `isDestructive` | `(_input?) => false` | 假设非破坏性 |
| `checkPermissions` | `(input) => Promise.resolve({ behavior: 'allow', updatedInput: input })` | 委托给通用权限系统 |
| `toAutoClassifierInput` | `(_input?) => ''` | 跳过分类器（安全相关工具必须覆盖） |
| `userFacingName` | `(_input?) => ''` → 覆盖为 `() => def.name` | 默认使用工具名 |

### 合并机制

```typescript
function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,              // 1. 展开默认值
    userFacingName: () => def.name, // 2. userFacingName 特殊覆盖为工具名
    ...def,                        // 3. 定义覆盖默认值
  } as BuiltTool<D>
}
```

**类型级精确合并**: `BuiltTool<D>` 使用条件类型映射，确保:
- 如果 `D` 提供了某个键（非 optional），使用 `D` 的类型
- 如果 `D` 省略了某个键（从 `Partial<>` 继承 optional），使用默认值类型
- 所有其他键从 `D` 逐字传递，保留 arity、optional 和 literal 类型

---

## 4. 注册流程

```
getAllBaseTools()
  |
  +-- 返回所有可能的工具（特性开关条件展开）:
  |     始终包含: Bash, FileRead, FileEdit, FileWrite, Glob/Grep,
  |             NotebookEdit, WebFetch, TodoWrite, WebSearch,
  |             TaskStop, AskUserQuestion, SkillTool, EnterPlanMode,
  |             SendMessageTool, ListMcpResources, ReadMcpResource, ...
  |     条件包含: ConfigTool, TungstenTool (ant), SuggestBackgroundPRTool (ant),
  |             WebBrowserTool, TaskCreate/Get/Update/List (todoV2),
  |             LSPTool (ENABLE_LSP_TOOL), Enter/ExitWorktree (worktree mode),
  |             TeamCreate/Delete (agentSwarms), SleepTool (PROACTIVE/KAIROS),
  |             CronTools (AGENT_TRIGGERS), RemoteTriggerTool, MonitorTool,
  |             BriefTool, PushNotificationTool, SubscribePRTool,
  |             PowerShellTool, SnipTool, WorkflowTool, ToolSearchTool, ...
  |
  v

getTools(permissionContext)
  |
  +-- SIMPLE 模式 (CLAUDE_CODE_SIMPLE=1):
  |     Bash + FileRead + FileEdit (或 REPLTool)
  |     + coordinator 附加
  |
  +-- 正常模式:
  |     getAllBaseTools() - specialTools (ListMcpResources, ReadMcpResource, SyntheticOutput)
  |     filterToolsByDenyRules()
  |     REPL 模式: 移除 REPL_ONLY_TOOLS
  |     isEnabled() 过滤
  |
  v

assembleToolPool(permissionContext, mcpTools)
  |
  +-- builtInTools = getTools(permissionContext)
  +-- allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  +-- [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName))
  +-- uniqBy('name')  # 内置工具同名时优先（保留插入顺序）
  |
  +-- 排序理由: 提示缓存稳定性
  |     claude_code_system_cache_policy 在最后一个前缀匹配内置工具后放置缓存断点
  |     如果 MCP 工具与内置工具交错排序，每次 MCP 变化都会使所有下游缓存键失效
  |
  v

getMergedTools(permissionContext, mcpTools)
  |
  +-- 简单合并: [...builtInTools, ...mcpTools]
  +-- 用途: ToolSearch 阈值计算、token 计数等需要完整列表的场景
```

---

## 5. 工具预设与限制

### 预设

```typescript
const TOOL_PRESETS = ['default'] as const
// 目前仅一个预设，框架预留扩展
```

### 大小限制

| 常量 | 值 | 用途 |
|------|-----|------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000 | 单个工具结果持久化到磁盘的字符阈值 |
| `MAX_TOOL_RESULT_TOKENS` | 100,000 | 工具结果的最大 token 数 |
| `BYTES_PER_TOKEN` | 4 | 每个 token 的字节数估算 |
| `MAX_TOOL_RESULT_BYTES` | 400,000 | 工具结果的最大字节数 (`100,000 * 4`) |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000 | 单轮（单条 user 消息）中所有 tool_result 块的聚合上限 |
| `TOOL_SUMMARY_MAX_LENGTH` | 50 | 工具摘要字符串最大长度 |

### 工具结果持久化流程

```
tool.call() 返回 result.data
  |
  v
tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)
  |
  v
计算 toolResultSizeBytes
  |
  +-- <= maxResultSizeChars: 内联返回完整结果
  |
  +-- > maxResultSizeChars:
        持久化到磁盘文件
        返回预览 + 文件路径引用
        工具下次调用可读取完整内容

  +-- per-message 预算:
        同一轮中 N 个并行工具可能各 40K = 400K 聚合
        超过 200K 时最大块优先持久化直到预算内
        每条消息独立评估（跨轮不累积）
```

---

## 6. 延迟加载机制

### shouldDefer 和 alwaysLoad

```
isDeferredTool(tool):
  1. alwaysLoad === true?     -> false (不延迟)
  2. isMcp === true?          -> true  (MCP 工具始终延迟)
  3. name === ToolSearchTool? -> false (搜索工具自身不延迟)
  4. FORK_SUBAGENT + Agent?   -> false (Agent 首轮可用)
  5. KAIROS + BriefTool?      -> false (通信通道首轮可用)
  6. KAIROS + SendUserFile + bridgeActive? -> false
  7. shouldDefer === true?    -> true
  8. 其他                     -> false
```

### ToolSearchMode

| 模式 | ENABLE_TOOL_SEARCH 值 | 行为 |
|------|----------------------|------|
| `'tst'` | `true` / `auto:0` / (默认未设置) | 始终延迟 MCP 和 shouldDefer 工具 |
| `'tst-auto'` | `auto` / `auto:1-99` | 延迟工具 token 超过上下文窗口百分比时才启用 |
| `'standard'` | `false` / `auto:100` / `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 禁用工具搜索，所有工具内联 |

### 自动阈值计算

```
getAutoToolSearchTokenThreshold(model):
  contextWindow = getContextWindowForModel(model, betas)
  percentage = getAutoToolSearchPercentage() / 100  # 默认 10%
  return floor(contextWindow * percentage)
```

### 延迟工具列表 (shouldDefer === true 的内置工具)

| 工具 | searchHint |
|------|------------|
| `EnterPlanModeTool` | "enter planning mode for complex tasks" |
| `EnterWorktreeTool` | "create isolated git worktree" |
| `ExitPlanModeV2Tool` | "exit planning mode and execute" |
| `ExitWorktreeTool` | "exit and clean up git worktree" |
| `ListMcpResourcesTool` | "list available MCP resources" |
| `ReadMcpResourceTool` | "read MCP resource content" |
| `LSPTool` | "language server protocol operations" |
| `NotebookEditTool` | "edit jupyter notebook cells" |
| `RemoteTriggerTool` | "schedule remote agent trigger" |
| `CronCreateTool` | "create scheduled cron task" |
| `CronDeleteTool` | "delete scheduled cron task" |
| `CronListTool` | "list scheduled cron tasks" |
| `SendMessageTool` | "send message to team member" |
| `TaskCreateTool` | "create new subtask" |
| `TaskGetTool` | "get subtask details" |
| `TaskListTool` | "list all subtasks" |
| `TaskUpdateTool` | "update subtask status" |
| `TaskStopTool` | "stop running subtask" |
| `TeamCreateTool` | "create agent team" |
| `TeamDeleteTool` | "delete agent team" |
| `TodoWriteTool` | "update todo list" |
| `WebFetchTool` | "fetch content from URL" |
| `WebSearchTool` | "search the web" |

> 注: 所有 MCP 工具也始终延迟（`isMcp === true`）

### 始终加载工具列表 (10 个核心工具)

| 工具 | 不延迟原因 |
|------|-----------|
| `BashTool` | 核心执行工具 |
| `FileReadTool` | 核心读取工具 |
| `FileEditTool` | 核心编辑工具 |
| `FileWriteTool` | 核心写入工具 |
| `GlobTool` | 核心搜索工具 |
| `GrepTool` | 核心搜索工具 |
| `AgentTool` | 子 Agent 调度（FORK_SUBAGENT 下不延迟） |
| `SkillTool` | 技能调用 |
| `ToolSearchTool` | 工具发现自身必须可用 |
| `BriefTool` | Kairos 通信通道（KAIROS 下不延迟） |

### ToolSearchTool 搜索算法

```
ToolSearchTool.call({ query, max_results? }):
  |
  +-- 解析查询:
  |     "select:Read,Edit,Grep" -> 精确名称匹配
  |     "notebook jupyter"      -> 关键词搜索，最多 max_results 个
  |     "+slack send"           -> 名称必须含 "slack"，其余关键词排序
  |
  +-- 搜索范围: deferredTools (tools.filter(isDeferredTool))
  |
  +-- 名称匹配:
  |     精确匹配: 工具名 === 查询词
  |     前缀匹配: 工具名.startsWith(查询词)
  |     包含匹配: 工具名.includes(查询词)
  |
  +-- 关键词匹配:
  |     对每个查询词:
  |       工具名包含该词 -> 加分
  |       searchHint 包含该词 -> 加分
  |       工具描述包含该词 -> 加分
  |
  +-- 输出格式:
        <functions>
          <function>{"description":"...","name":"...","parameters":{...}}</function>
          ...
        </functions>
```

**关键约束**: 直到 ToolSearchTool 被调用并返回工具 schema，延迟工具的参数结构对模型不可见 —— 模型只知道工具名称，无法正确构造参数。这就是为什么 Zod 验证失败时会附加 `buildSchemaNotSentHint()` 提示模型先加载工具。

---

## 7. 工具发现后的生命周期

```
工具注册 (getAllBaseTools)
  |
  v
权限过滤 (getTools / filterToolsByDenyRules)
  |
  v
MCP 合并 (assembleToolPool / getMergedTools)
  |
  v
延迟分类 (isDeferredTool)
  |
  +-- alwaysLoad -> 完整 schema 包含在提示中
  +-- shouldDefer / isMcp -> defer_loading: true, 仅名称在提示中
  |
  v
API 请求 (tools 数组发送给 Anthropic API)
  |
  v
模型生成 tool_use 块
  |
  v
StreamingToolExecutor.addTool()
  |
  v
6 阶段权限+执行管线 (见 06-tool-dispatch-pipeline.md)
  |
  v
结果持久化 (applyToolResultBudget)
  |
  v
结果返回模型 (tool_result 块)
```

### 工具发现与动态加载

ToolSearchTool 的发现结果通过以下机制持久化:

1. **系统提醒附件**: `createAttachmentMessage({ type: 'discovered_tools', tools })` 附加到消息流
2. **消息历史提取**: `extractDiscoveredToolNames(messages)` 从历史中提取已发现工具名集合
3. **验证提示**: 当延迟工具未发现时，Zod 错误后附加 `buildSchemaNotSentHint()` 指导模型调用 ToolSearchTool
4. **Delta 模式**: `tengu_glacier_2xr` feature 启用时，发现结果通过 `<system-reminder>` 消息增量推送，而非预置 `<available-deferred-tools>` 块