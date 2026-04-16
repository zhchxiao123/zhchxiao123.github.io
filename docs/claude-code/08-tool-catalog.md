---
title: "Step 8: 工具完整清单"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/08-tool-catalog/
---


> 分析日期: 2026-04-16
> 核心目录: src/tools/ (~42个工具目录, ~35+个 buildTool 定义)

---

## 1. 工具分类图

```
                        ┌─────────────────────────────────────────┐
                        │           Claude Code 工具体系           │
                        └─────────────────────────────────────────┘
                                      │
          ┌───────────┬───────────┬───┴───────┬───────────┬───────────┐
          │           │           │           │           │           │
    ┌─────▼─────┐ ┌──▼────┐ ┌───▼────┐ ┌────▼────┐ ┌───▼────┐ ┌───▼────┐
    │ 文件操作  │ │ Shell │ │  搜索  │ │  通信   │ │ Agent  │ │ 配置   │
    │  7个      │ │  2个  │ │  4个   │ │  4个    │ │  8个   │ │  4个   │
    └─────┬─────┘ └──┬────┘ └───┬────┘ └────┬────┘ └───┬────┘ └───┬────┘
          │          │          │           │          │          │
    Read,Edit,  Bash,     Grep,      SendMessage, Agent,    Config,
    Write,      PowerShell Glob,      AskUser,     Skill,    ToolSearch,
    Notebook,            WebFetch,   BriefTool,   Team*,    EnterPlan,
    ExitWorktree         WebSearch   MCP*,         Cron*,   ExitPlan,
    EnterWorktree                   TaskOutput     Task*    TodoWrite

                        ┌─────────────────────────────────────────┐
                        │              MCP / 元工具               │
                        │   MCPTool, ListMcpResources,            │
                        │   ReadMcpResource, LSPTool,            │
                        │   SyntheticOutput, RemoteTrigger,      │
                        │   TestingPermission                     │
                        └─────────────────────────────────────────┘
```

---

## 2. Tier 1 工具深度分析 (1,000+ 行)

### 2.1 AgentTool (1,397 行)

**目录**: `src/tools/AgentTool/`
**工具名**: `Agent` (常量 `AGENT_TOOL_NAME`)

| 属性 | 值 |
|------|-----|
| **用途** | 生成子 Agent 执行委派任务；支持多 Agent swarm、fork 子 Agent 和专业 Agent 类型 |
| **Schema** | `description`(必填), `prompt`(必填), `subagent_type`(可选), `model`(sonnet/opus/haiku), `run_in_background`(可选), `name`(可选), `team_name`(可选), `mode`(权限模式), `isolation`(worktree/remote), `cwd`(可选) |
| **输出** | 可辨识联合: `completed`(含 prompt) 或 `async_launched`(含 agentId, description) |
| **权限** | 按权限规则过滤拒绝的 Agent；计划模式下基于提示的权限请求 |
| **并发** | 非安全；`isConcurrencySafe` 取决于操作是否只读 |
| **渲染** | `AgentPromptDisplay`, `AgentResponseDisplay`, `FallbackToolUseErrorMessage` |
| **特性开关** | `KAIROS`(门控 cwd, isolation:remote), `FORK_SUBAGENT`, `COORDINATOR_MODE` |
| **中断** | 通过 `AbortController` 支持；异步 Agent 返回 `agentId` |

### 2.2 BashTool (1,143 行)

**目录**: `src/tools/BashTool/`
**工具名**: `Bash` (常量 `BASH_TOOL_NAME`)

| 属性 | 值 |
|------|-----|
| **用途** | 执行 Shell 命令；支持沙箱、后台执行、sed 编辑模拟、大结果持久化 |
| **Schema** | `command`(必填), `timeout`(可选), `description`(可选), `run_in_background`(可选), `dangerouslyDisableSandbox`(可选), `_simulatedSedEdit`(内部) |
| **输出** | `stdout`, `stderr`, `interrupted`, `isImage`, `persistedOutputPath`, `backgroundTaskId`, `returnCodeInterpretation`, `structuredContent` |
| **权限** | `bashToolHasPermission` — 只读约束检查；复合命令解析；`isReadOnly` 基于 `checkReadOnlyConstraints` |
| **并发** | `isConcurrencySafe` = `this.isReadOnly?.(input) ?? false` — 只读命令可并行 |
| **渲染** | `renderToolUseMessage`, `BashToolResultMessage`；沙箱模式显示 "SandboxedBash" |
| **特性开关** | `MONITOR_TOOL`(阻止 sleep 模式), 沙箱模式 |
| **中断** | `interrupted: true`；处理 `SIGINT`；后台命令通过 `TaskStopTool` 停止 |

### 2.3 FileReadTool (1,183 行)

**目录**: `src/tools/FileReadTool/`
**工具名**: `Read` (常量 `FILE_READ_TOOL_NAME`)

| 属性 | 值 |
|------|-----|
| **用途** | 读取本地文件；支持文本、图片(JPEG/PNG/GIF/WebP)、PDF(含页码范围)、Jupyter notebook、二进制检测、token 感知调整 |
| **Schema** | `file_path`(必填), `offset`(可选), `limit`(可选), `pages`(PDF页码, 可选) |
| **输出** | 可辨识联合 on `type`: `text`(content, lineCount), `image`(mediaType, data), `pdf`(pages), `notebook`(cells), `file_unchanged`, `partial_view` |
| **权限** | `checkReadPermissionForTool`；`preparePermissionMatcher` 使用 `matchWildcardPattern` |
| **并发** | `isConcurrencySafe = true`; `isReadOnly = true` |
| **渲染** | 文本/图片/PDF/notebook 分离渲染器；`extractSearchText` 返回内容用于搜索索引 |
| **特性开关** | PDF 支持, 图片调整, notebook 读取 |
| **中断** | 支持 `AbortController.signal`；`file_unchanged` 用于去重 |

### 2.4 SkillTool (1,108 行)

**目录**: `src/tools/SkillTool/`
**工具名**: `Skill`

| 属性 | 值 |
|------|-----|
| **用途** | 调用斜杠命令技能(如 /commit, /review-pr)；支持内联(同步)和子 Agent(异步)执行模式 |
| **Schema** | `skill`(必填), `args`(可选) |
| **输出** | 内联: `success, commandName, status:'inline'`；子 Agent: `status:'subagent', agentId` |
| **权限** | 继承技能定义的权限模型 |
| **并发** | 取决于技能类型 |
| **渲染** | 自定义 UI 渲染器 |
| **特性开关** | 技能发现门控；技能定义指定子 Agent 模式 |
| **中断** | 支持 `AbortController`；子 Agent 技能异步启动 |

### 2.5 PowerShellTool (1,000 行)

**目录**: `src/tools/PowerShellTool/`
**工具名**: `PowerShell`

| 属性 | 值 |
|------|-----|
| **用途** | Windows 专用 PowerShell 命令执行；镜像 BashTool 接口 |
| **Schema** | 与 BashTool 相同结构(命令、超时、描述、后台执行) |
| **输出** | 与 BashTool 相同 |
| **权限** | 与 BashTool 类似 |
| **并发** | 与 BashTool 相同 — 只读时安全 |
| **渲染** | 镜像 BashTool 的 TSX 组件 |
| **特性开关** | 仅 Windows；`isBackgroundTasksDisabled` 门控 |
| **中断** | 与 BashTool 相同 |

### 2.6 SendMessageTool (917 行)

**目录**: `src/tools/SendMessageTool/`
**工具名**: `SendMessage`

| 属性 | 值 |
|------|-----|
| **用途** | 向 swarm 中的 Agent 队友发送消息；支持直接消息、广播(`*`)、UDS 套接字对端、bridge/远程控制对端 |
| **Schema** | `to`(必填: 队友名/"*"/"uds:<path>"/"bridge:<id>"), `summary`(可选), `message`(string 或 StructuredMessage) |
| **输出** | 投递状态和路由信息 |
| **权限** | `isReadOnly(input)` 当消息为纯文本字符串时返回 true |
| **并发** | `shouldDefer: true` |
| **特性开关** | `UDS_INBOX`(门控 "uds:"/"bridge:" 寻址), `isAgentSwarmsEnabled` 门控可用性 |
| **中断** | 支持 abort controller；消息投递为即发即弃 |

### 2.7 LSPTool (860 行)

**目录**: `src/tools/LSPTool/`
**工具名**: `LSP`

| 属性 | 值 |
|------|-----|
| **用途** | 通过 LSP 提供代码智能：定义跳转、引用查找、悬停信息、文档/工作区符号、调用层次 |
| **Schema** | `operation`(必填: goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol/...), `filePath`(必填), `line`(必填), `character`(必填) |
| **输出** | 因操作而异：位置结果、悬停文本、符号信息、调用层次项 |
| **权限** | 只读；`isConcurrencySafe = true`; `isReadOnly = true` |
| **特性开关** | `isLspConnected()` 门控可用性；`shouldDefer: true` |
| **中断** | 支持 abort controller；LSP 请求可取消 |

---

## 3. Tier 2 工具中等分析 (400-999 行)

### 3.1 FileEditTool

**工具名**: `FileEdit`
**用途**: 执行精确字符串替换；强制编辑前读取和陈旧性检查

| 属性 | 值 |
|------|-----|
| **Schema** | `file_path`(必填), `old_string`(必填), `new_string`(必填), `replace_all`(可选, 默认 false) |
| **权限** | `checkWritePermissionForTool`；团队记忆秘密保护 |
| **并发** | 不安全(文件修改)；`strict: true` |
| **特性开关** | `CLAUDE_CODE_REMOTE` git diff, `fileHistoryEnabled`, LSP 集成 |
| **中断** | 原子读-修改-写；`FILE_UNEXPECTEDLY_MODIFIED_ERROR` 陈旧写入 |

### 3.2 TaskOutputTool

**工具名**: `TaskOutput`
**用途**: 读取后台任务/Agent 输出

| 属性 | 值 |
|------|-----|
| **权限** | 只读，继承任务上下文权限 |
| **并发** | 安全(读操作) |
| **特性开关** | 磁盘输出缓存 |
| **中断** | 支持 abort controller |

### 3.3 GrepTool

**工具名**: `Grep`
**用途**: 使用 ripgrep 快速内容搜索

| 属性 | 值 |
|------|-----|
| **Schema** | `pattern`(必填), `path`(可选), `glob`(可选), `type`(可选), `output_mode`(可选), `-i`/`-n`/`context`/`multiline`(可选) |
| **权限** | `checkReadPermissionForTool` |
| **并发** | `isConcurrencySafe = true`; `isReadOnly = true` |

### 3.4 ExitPlanModeTool (V2)

**工具名**: `ExitPlanMode`
**用途**: 退出计划模式并提供计划供用户审批

| 属性 | 值 |
|------|-----|
| **Schema** | `allowedPrompts`(可选: {tool, prompt}[]); SDK 增加 `plan`, `planFilePath` |
| **权限** | 计划审批流；`allowedPrompts` 语义权限 |
| **并发** | `shouldDefer: true` |
| **特性开关** | `TRANSCRIPT_CLASSIFIER`(门控自动模式退出), `KAIROS_CHANNELS`, `isPlanModeInterviewPhaseEnabled` |

### 3.5 NotebookEditTool

**工具名**: `NotebookEdit`
**用途**: 编辑 Jupyter notebook 单元格

| 属性 | 值 |
|------|-----|
| **Schema** | `notebook_path`(必填), `cell_id`(可选), `new_source`(必填), `cell_type`(可选), `edit_mode`(replace/insert/delete) |
| **权限** | `checkWritePermissionForTool` |
| **并发** | `shouldDefer: true`；不安全(文件修改) |
| **特性开关** | `TRANSCRIPT_CLASSIFIER`, `fileHistoryEnabled` |

### 3.6 ToolSearchTool

**工具名**: `ToolSearch`
**用途**: 搜索和选择延迟加载工具

| 属性 | 值 |
|------|-----|
| **Schema** | `query`(必填: 搜索词或 `select:<name>`), `max_results`(可选, 默认 5) |
| **权限** | 无需检查；`isConcurrencySafe = true` |
| **渲染** | `renderToolUseMessage` 返回 null(用户不可见)；`mapToolResultToToolResultBlockParam` 返回 `tool_reference` 块 |
| **特性开关** | `isToolSearchEnabledOptimistic()` 门控可用性 |

### 3.7 ConfigTool

**工具名**: `Config`
**用途**: 获取或设置 Claude Code 配置

| 属性 | 值 |
|------|-----|
| **Schema** | `setting`(必填), `value`(可选: 省略则读取) |
| **权限** | 读取自动允许；写入需要审批 |
| **并发** | `isConcurrencySafe = true`；只读时 `value === undefined` |
| **特性开关** | `VOICE_MODE`(门控 voiceEnabled 设置) |

### 3.8 FileWriteTool

**工具名**: `FileWrite`
**用途**: 创建或覆盖文件

| 属性 | 值 |
|------|-----|
| **Schema** | `file_path`(必填), `content`(必填) |
| **权限** | `checkWritePermissionForTool`；团队记忆秘密保护 |
| **并发** | 不安全(文件修改)；`strict: true` |
| **特性开关** | `CLAUDE_CODE_REMOTE` + `tengu_quartz_lantern` git diff, `fileHistoryEnabled`, LSP 集成 |
| **中断** | `FILE_UNEXPECTEDLY_MODIFIED_ERROR` 陈旧写入；`readFileState` 追踪 |

### 3.9 TaskUpdateTool

**工具名**: `TaskUpdate`
**用途**: 更新任务属性(状态、主题、描述等)

| 属性 | 值 |
|------|-----|
| **Schema** | `taskId`(必填), `subject`/`description`/`activeForm`/`status`/`addBlocks`/`addBlockedBy`/`owner`/`metadata`(可选) |
| **权限** | 无显式检查 |
| **并发** | 安全 |
| **渲染** | `renderToolUseMessage` 返回 null(不可见) |
| **特性开关** | `isTodoV2Enabled()`, `VERIFICATION_AGENT` + `tengu_hive_evidence` |

---

## 4. Tier 3 工具简要编目 (< 400 行)

| # | 工具名 | 用途 | 权限 | 并发安全 | 只读 | 延迟加载 | 特性开关 |
|---|--------|------|------|---------|------|---------|---------|
| 17 | Glob | 文件名模式匹配 | checkRead | ✓ | ✓ | - | - |
| 18 | WebFetch | 获取 URL 内容 | 域名规则 | ✓ | ✓ | ✓ | 15分钟缓存 |
| 19 | WebSearch | Web 搜索 | passthrough | ✓ | ✓ | ✓ | API 提供商门控 |
| 20 | EnterPlanMode | 进入计划模式 | 自动 | ✓ | ✓ | ✓ | KAIROS_CHANNELS |
| 21 | ExitWorktree | 退出工作树 | isDestructive | ✗ | ✗ | ✓ | - |
| 22 | EnterWorktree | 创建隔离工作树 | 自动 | ✗ | ✗ | ✓ | - |
| 23 | AskUserQuestion | 多选提问 | 阻塞等输入 | ✗ | ✗ | - | KAIROS_CHANNELS |
| 24 | TodoWrite | V1 待办管理 | 自动允许 | ✓ | ✗ | ✓ | !isTodoV2Enabled |
| 25 | TaskCreate | 创建 V2 任务 | 无检查 | ✓ | ✗ | ✓ | isTodoV2Enabled |
| 26 | TaskList | 列出 V2 任务 | 无检查 | ✓ | ✓ | ✓ | isTodoV2Enabled |
| 27 | TaskGet | 获取 V2 任务 | 无检查 | ✓ | ✓ | ✓ | isTodoV2Enabled |
| 28 | TaskStop | 停止后台任务 | 验证运行中 | ✓ | ✗ | ✓ | - |
| 29 | MCPTool | MCP 工具调用 | passthrough | 变化 | 变化 | - | isMcp |
| 30 | ListMcpResources | 列出 MCP 资源 | 无检查 | ✓ | ✓ | ✓ | - |
| 31 | ReadMcpResource | 读取 MCP 资源 | 无检查 | ✓ | ✓ | ✓ | - |
| 32 | BriefTool | 发送用户消息 | 自动允许 | ✓ | ✓ | - | KAIROS_BRIEF |
| 33 | SyntheticOutput | SDK 结构化输出 | 自动允许 | ✓ | ✓ | - | 仅非交互 |
| 34 | RemoteTrigger | 管理远程触发器 | OAuth 必需 | ✓ | 条件 | ✓ | tengu_surreal_dali |
| 35 | TeamCreate | 创建 swarm 团队 | isAgentSwarmsEnabled | ✗ | ✗ | ✓ | isAgentSwarmsEnabled |
| 36 | TeamDelete | 解散 swarm 团队 | isAgentSwarmsEnabled | ✗ | ✗ | ✓ | isAgentSwarmsEnabled |
| 37 | CronCreate | 创建定时任务 | 无检查 | ✗ | ✗ | ✓ | isKairosCronEnabled |
| 38 | CronDelete | 删除定时任务 | 队友仅删自己 | ✗ | ✗ | ✓ | isKairosCronEnabled |
| 39 | CronList | 列出定时任务 | 无检查 | ✓ | ✓ | ✓ | isKairosCronEnabled |
| 40 | TestingPermission | 测试权限工具 | 始终 ask | ✓ | ✓ | - | 仅测试环境 |

---

## 5. 跨工具通用模式

### 5.1 权限检查模式

```
工具调用
    |
    v
hasPermissionsToUseTool()  ──>  规则匹配  ──>  behavior: allow/deny/ask
    |
    v (ask)
useCanUseTool()  ──>  PermissionContext  ──>  handler 选择
    |                                          |
    |                        +-----------------+------------------+
    |                        |                 |                  |
    v                        v                 v                  v
interactiveHandler    coordinatorHandler  swarmWorkerHandler  speculativeClassifier
(用户对话框)          (协调器委托)        (swarm 邮箱转发)    (Bash 2秒竞速)
```

### 5.2 并发模型

- **可并行执行**: `isConcurrencySafe = true` 的工具(Read, Grep, Glob, LSP, WebFetch, WebSearch, Config, ToolSearch 等)
- **严格串行**: 文件修改工具(FileEdit, FileWrite, NotebookEdit) — `strict: true`
- **延迟加载**: `shouldDefer: true` 的工具不在初始 API 调用中发送 schema，通过 ToolSearch 按需发现
- **StreamingToolExecutor 管理**: `addTool()` 入队 -> `canExecuteTool()` 检查并发 -> `executeTool()` 执行

### 5.3 延迟加载机制

```
初始 API 调用
    |
    v
getTools() -> assembleToolPool()
    |
    +-- alwaysLoad: 始终包含 (Read, Edit, Write, Bash, Glob, Grep 等)
    +-- shouldDefer: 不包含 schema (ToolSearch, Config, WebSearch, LSP 等)
    |
    v (模型需要延迟工具时)
ToolSearch.call() -> 搜索/选择 -> 动态添加工具 schema 到对话
```

### 5.4 文件安全模式

- **读前检查**: FileEditTool 和 FileWriteTool 强制编辑/写入前先读取文件
- **陈旧性检测**: `readFileState` 追踪文件修改时间，写入时检查 `FILE_UNEXPECTEDLY_MODIFIED_ERROR`
- **团队记忆保护**: 检查 `isTeamMemorySecret()` 防止泄露团队记忆文件
- **UNC 路径安全**: NotebookEditTool 拒绝 UNC 路径