---
title: "Step 5: 工具系统"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/05-tools-system/
---
# OpenAI Codex CLI 工具系统深度分析

## 1. 架构概览

Codex CLI 的工具系统采用**注册-路由-编排**三层架构：

```
模型调用 → ToolRouter.build_tool_call() → ToolRegistry.dispatch_any()
                                                   ↓
                                          ToolHandler.handle()
                                                   ↓
                                          ToolOrchestrator.run() (审批+沙箱)
```

核心组件：

| 组件 | 位置 | 职责 |
|------|------|------|
| `ToolRouter` | `core/src/tools/router.rs` | 将模型调用分发到注册的处理器 |
| `ToolRegistry` | `core/src/tools/registry.rs` | 工具名→处理器的映射表，执行前后钩子 |
| `ToolOrchestrator` | `core/src/tools/orchestrator.rs` | 审批流程、沙箱选择、失败重试 |
| `ToolHandler` trait | `core/src/tools/registry.rs` | 统一异步工具处理接口 |
| `ToolRuntime` trait | `core/src/tools/sandboxing.rs` | 需要沙箱隔离的工具运行时接口 |

---

## 2. 工具注册机制

### 2.1 注册流程

注册入口在 `spec.rs:build_specs_with_discoverable_tools()`：

1. 调用 `codex_tools::build_tool_registry_plan()` 根据 `ToolsConfig` 生成工具规格列表和处理器类型列表
2. 每个处理器类型 (`ToolHandlerKind`) 映射到一个具体的 `Arc<dyn ToolHandler>` 单例
3. 通过 `ToolRegistryBuilder::push_spec()` 注册规格，`register_handler()` 注册处理器
4. 最终 `build()` 返回 `(Vec<ConfiguredToolSpec>, ToolRegistry)`

### 2.2 ToolHandler trait

```rust
pub trait ToolHandler: Send + Sync {
    type Output: ToolOutput + 'static;
    fn kind(&self) -> ToolKind;  // Function 或 Mcp
    fn is_mutating(&self, invocation: &ToolInvocation) -> Future<Output=bool>;
    fn pre_tool_use_payload(&self, ...) -> Option<PreToolUsePayload>;
    fn post_tool_use_payload(&self, ...) -> Option<PostToolUsePayload>;
    fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>;
    fn handle(&self, invocation: ToolInvocation) -> Future<Output=Result<Self::Output>>;
}
```

`ToolKind` 枚举区分 `Function` 和 `Mcp` 两类。`matches_kind()` 方法确保处理器和调用载荷类型匹配。

### 2.3 ToolPayload 类型

```
ToolPayload
├── Function { arguments: String }        // 标准函数调用
├── Mcp { server, tool, raw_arguments }    // MCP 服务调用
├── ToolSearch { arguments }               // 工具搜索
├── Custom { input: String }              // 自定义（如 Code Mode）
└── LocalShell { params }                  // 本地 Shell 调用
```

### 2.4 已注册处理器清单

| ToolHandlerKind | 处理器类 | 说明 |
|-----------------|---------|------|
| `Shell` | `ShellHandler` | 传统 Shell 执行 |
| `ShellCommand` | `ShellCommandHandler` | 增强型 Shell 命令 |
| `UnifiedExec` | `UnifiedExecHandler` | 统一执行（交互式 PTY） |
| `ApplyPatch` | `ApplyPatchHandler` | 文件补丁应用 |
| `Mcp` | `McpHandler` | MCP 工具调用 |
| `McpResource` | `McpResourceHandler` | MCP 资源读取 |
| `SpawnAgentV1/V2` | `SpawnAgentHandler`/`SpawnAgentHandlerV2` | 子 Agent 生成 |
| `CloseAgentV1/V2` | `CloseAgentHandler`/`CloseAgentHandlerV2` | 关闭子 Agent |
| `WaitAgentV1/V2` | `WaitAgentHandler`/`WaitAgentHandlerV2` | 等待 Agent 完成 |
| `SendMessageV2` | `SendMessageHandlerV2` | Agent 间消息 |
| `FollowupTaskV2` | `FollowupTaskHandlerV2` | 后续任务 |
| `ListAgentsV2` | `ListAgentsHandlerV2` | 列出活跃 Agent |
| `ResumeAgentV1` | `ResumeAgentHandler` | 恢复暂停的 Agent |
| `SendInputV1` | `SendInputHandler` | 向 Agent 发送输入 |
| `CodeModeExecute` | `CodeModeExecuteHandler` | Code Mode 执行 |
| `CodeModeWait` | `CodeModeWaitHandler` | Code Mode 等待 |
| `JsRepl` | `JsReplHandler` | JavaScript REPL |
| `JsReplReset` | `JsReplResetHandler` | JS REPL 重置 |
| `ListDir` | `ListDirHandler` | 目录列表 |
| `ViewImage` | `ViewImageHandler` | 图像查看 |
| `RequestPermissions` | `RequestPermissionsHandler` | 权限请求 |
| `RequestUserInput` | `RequestUserInputHandler` | 用户输入请求 |
| `PlanHandler` | `PlanHandler` | 计划更新 |
| `ToolSearch` | `ToolSearchHandler` | 工具搜索（BM25） |
| `ToolSuggest` | `ToolSuggestHandler` | 工具建议 |
| `DynamicTool` | `DynamicToolHandler` | 动态工具 |
| `AgentJobs` | `BatchJobHandler` | 批量 Agent 任务 |
| `TestSync` | `TestSyncHandler` | 测试同步 |

对于不可用工具 (`unavailable_called_tools`)，系统动态创建占位符规格并注册 `UnavailableToolHandler`，调用时返回错误说明。

---

## 3. 工具编排器与沙箱隔离

### 3.1 ToolOrchestrator 编排流程

`orchestrator.rs` 实现核心编排逻辑：

```
1) 判断审批需求 (ExecApprovalRequirement)
   ├── Skip → 跳过审批，直接执行
   ├── NeedsApproval → 请求用户审批
   └── Forbidden → 拒绝执行

2) 审批路径：
   a) 首先尝试 PermissionRequest hooks
   b) 若无 hook 决策，走 guardian 自动审批 或 用户手动审批

3) 选择沙箱策略 (SandboxAttempt)
   - SandboxOverride::BypassSandboxFirstAttempt → 无沙箱
   - SandboxOverride::NoOverride → SandboxManager.select_initial()

4) 第一次尝试执行
   ├── 成功 → 返回结果
   └── 沙箱拒绝 (SandboxErr::Denied) → 若工具允许升级
       ├── 请求升级审批 (AskForApproval::OnRequest)
       ├── 用户批准 → 无沙箱重试
       └── 用户拒绝 → 返回错误
```

### 3.2 审批体系

**审批策略层级** (`AskForApproval` 枚举)：

| 策略 | 行为 |
|------|------|
| `Never` | 从不请求审批 |
| `OnFailure` | 沙箱拒绝后请求升级 |
| `OnRequest` | 每次都需要审批 |
| `UnlessTrusted` | 除非已信任，否则审批 |
| `Granular` | 细粒度控制 |

**审批缓存** (`ApprovalStore`)：当用户选择"本次会话允许"时，缓存审批决定，后续相同键的请求自动跳过。

### 3.3 沙箱机制

**沙箱类型** (`SandboxType`)：
- `None` - 无沙箱
- 平台相关：Seatbelt (macOS)、Landlock (Linux)、Windows Sandbox

**SandboxAttempt** 结构体封装了沙箱配置：
```rust
pub(crate) struct SandboxAttempt<'a> {
    pub sandbox: SandboxType,
    pub policy: &'a SandboxPolicy,
    pub file_system_policy: &'a FileSystemSandboxPolicy,
    pub network_policy: NetworkSandboxPolicy,
    pub enforce_managed_network: bool,
    pub manager: &'a SandboxManager,
    // ...
}
```

**ToolRuntime trait** 定义了沙箱偏好：
```rust
pub(crate) trait ToolRuntime<Req, Out>: Approvable<Req> + Sandboxable {
    fn network_approval_spec(&self, ...) -> Option<NetworkApprovalSpec>;
    fn run(&mut self, req: &Req, attempt: &SandboxAttempt, ctx: &ToolCtx) -> Result<Out, ToolError>;
}
```

**网络审批**：支持即时 (`Immediate`) 和延迟 (`Deferred`) 两种模式。延迟模式在沙箱内执行命令后再决议网络策略修改。

---

## 4. Shell 执行工具

### 4.1 ShellHandler（传统）

位于 `core/src/tools/handlers/shell.rs`，处理两种载荷：

- `ToolPayload::Function` — 标准 `shell` 工具调用，解析 `ShellToolCallParams`
- `ToolPayload::LocalShell` — 协议级的本机 Shell 调用

执行流程：
1. 解析参数 → 构建 `ExecParams`
2. 解析依赖环境变量
3. 权限处理：执行策略审批、权限请求工具、隐式授权
4. **拦截 apply_patch**：`intercept_apply_patch()` 检测 `apply_patch` 命令并路由到专用处理器
5. 通过 `ToolOrchestrator` 执行 `ShellRequest`
6. 格式化输出并返回

### 4.2 ShellCommandHandler

同样位于 `shell.rs`，支持两种后端：
- `ShellCommandBackend::Classic` — 传统模式
- `ShellCommandBackend::ZshFork` — Zsh 分叉模式

与 `ShellHandler` 共享 `run_exec_like()` 方法，但支持 login shell 和 freeform 模式。

### 4.3 UnifiedExecHandler（交互式执行）

位于 `core/src/tools/handlers/unified_exec.rs`，支持两个子命令：

| 子命令 | 功能 |
|--------|------|
| `exec_command` | 启动新进程或向已有进程发送命令 |
| `write_stdin` | 向运行中的进程写入标准输入 |

**输入参数** (`ExecCommandArgs`)：
```rust
struct ExecCommandArgs {
    cmd: String,
    workdir: Option<String>,
    shell: Option<String>,
    login: Option<bool>,
    tty: bool,
    yield_time_ms: u64,         // 默认 10_000ms
    max_output_tokens: Option<usize>,
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<PermissionProfile>,
    justification: Option<String>,
    prefix_rule: Option<Vec<String>>,
}
```

### 4.4 进程管理（UnifiedExecProcessManager）

位于 `core/src/unified_exec/process_manager.rs`：

- **进程池** (`ProcessStore`)：最多 64 个活跃进程，LRU 淘汰策略保护最近 8 个
- **进程生命周期**：`allocate_process_id()` → `exec_command()` → `write_stdin()` → `release_process_id()`
- **输出缓冲** (`HeadTailBuffer`)：固定 1MiB 容量，保留头部和尾部，丢弃中间
- **流式输出**：异步监视器 (`async_watcher.rs`) 向客户端推送增量输出事件
- **终止处理**：退出监视器在进程结束后发送 `ExecCommandEnd` 事件

### 4.5 输出缓冲（HeadTailBuffer）

位于 `core/src/unified_exec/head_tail_buffer.rs`：

- 总容量 1 MiB (`UNIFIED_EXEC_OUTPUT_MAX_BYTES`)
- 头部预算 = 512 KiB，尾部预算 = 512 KiB
- 新数据先填充头部，溢出写入尾部
- 保留输出首尾，中间省略，适配模型上下文窗口

---

## 5. Apply Patch 工具

### 5.1 处理器结构

两个层次：

1. **`ApplyPatchHandler`** (`core/src/tools/handlers/apply_patch.rs`) — 工具入口
   - 解析 `ApplyPatchToolArgs` 输入
   - 支持流式差分消费 (`ApplyPatchArgumentDiffConsumer`)
   - 计算权限需求、委托到运行时

2. **`ApplyPatchRuntime`** (`core/src/tools/runtimes/apply_patch.rs`) — 沙箱运行时
   - 实现 `ToolRuntime<ApplyPatchRequest, ExecToolCallOutput>`
   - 实现 `Approvable<ApplyPatchRequest>` — 按文件路径审批，支持会话级缓存
   - 实现 `Sandboxable` — `SandboxablePreference::Auto`, 支持失败升级
   - 在沙箱内执行补丁操作

### 5.2 补丁算法（codex-apply-patch crate）

位于 `apply-patch/src/lib.rs`，支持三种补丁类型：

| 类型 | 格式 | 说明 |
|------|------|------|
| `AddFile` | `*** Add File: <path>` | 创建新文件 |
| `DeleteFile` | `*** Delete File: <path>` | 删除文件 |
| `UpdateFile` | `*** Update File: <path>` | 更新文件（含上下文匹配+替换） |

**UpdateFile 算法**：
1. 解析 `@@context@@` + `-old_lines` + `+new_lines` 块
2. `seek_sequence` 在文件中定位旧行上下文
3. 收集 `(start_idx, old_len, new_lines)` 替换列表
4. 按降序应用替换（避免索引偏移）
5. 支持模糊匹配（Unicode 标点归一化）

### 5.3 拦截机制

`intercept_apply_patch()` 函数让 Shell 工具能拦截通过命令行调用的 `apply_patch`，路由到专用处理器，避免沙箱外的文件操作。

---

## 6. MCP 工具协议

### 6.1 架构

```
McpConnectionManager (codex-mcp)
    ↓ 管理多个 MCP 服务器连接
McpHandler (core/src/tools/handlers/mcp.rs)
    ↓ 委托到
handle_mcp_tool_call() (core/src/mcp_tool_call.rs)
    ↓ 审批 + 调用
Session.call_tool() → RmcpClient
```

### 6.2 McpHandler

轻量层，解析 `ToolPayload::Mcp { server, tool, raw_arguments }` 并委托到 `handle_mcp_tool_call()`。

### 6.3 MCP 工具调用流程

`handle_mcp_tool_call()` (`mcp_tool_call.rs`) 负责：

1. **解析参数** — JSON 字符串到 `Option<Value>`
2. **元数据查找** — 从 `McpConnectionManager` 获取工具注解、connector 信息
3. **审批判断** — `maybe_request_mcp_tool_approval()` 实现：
   - 自动批准策略 (`auto-approved`)
   - Guardian 自动审查
   - MCP Elicitation 协议（服务端向用户发确认）
   - RequestUserInput 路径（传统确认对话框）
   - 会话级/持久化批准缓存
   - ARC 安全监控 (`maybe_monitor_auto_approved_mcp_tool_call()`)
4. **执行调用** — `execute_mcp_tool_call()` 重写 OpenAI 文件参数，注入沙箱状态
5. **结果消毒** — 对不支持图像的模型，将图像内容替换为文本提示
6. **事件发射** — `McpToolCallBegin`/`McpToolCallEnd` 协议事件

### 6.4 MCP 资源工具

`McpResourceHandler` 支持三个子命令：
- `list_mcp_resources` — 列出 MCP 服务器资源（支持按服务器过滤+分页）
- `list_mcp_resource_templates` — 列出资源模板
- `read_mcp_resource` — 读取具体资源

### 6.5 MCP 工具可见性

`McpToolExposure` (`mcp_tool_exposure.rs`) 实现延迟加载策略：

- 当 MCP 工具数 ≥ 100 或启用 `ToolSearchAlwaysDeferMcpTools` 特性时，非 codex-apps 工具推迟加载
- 直接暴露的工具仅包含通过连接器认证的 codex-apps 工具
- 延迟工具通过 `tool_search` 按需发现

### 6.6 McpConnectionManager

位于 `codex-mcp/src/mcp_connection_manager.rs`：

- 管理每个配置的 MCP 服务器一个 `RmcpClient` 连接
- 按服务器名索引工具，使用 `__` 分隔符限定工具名
- 支持 stdio 和 streamable_http 两种传输
- 提供工具发现、调用、资源操作、elicitation 等能力
- 集成 codex-apps MCP 服务器，含工具缓存

---

## 7. 多 Agent 工具

### 7.1 V1 版本（multi_agents/）

| 工具 | 处理器 | 功能 |
|------|--------|------|
| `spawn_agent` | `SpawnAgentHandler` | 生成子 Agent |
| `close_agent` | `CloseAgentHandler` | 关闭指定 Agent |
| `send_input` | `SendInputHandler` | 向 Agent 发送输入 |
| `wait_agent` | `WaitAgentHandler` | 等待 Agent 完成（超时 10s-1h） |

### 7.2 V2 版本（multi_agents_v2/）

| 工具 | 处理器 | 功能 |
|------|--------|------|
| `spawn_agent` | `SpawnAgentHandlerV2` | 支持 fork 模式、agent_type、model 选择 |
| `close_agent` | `CloseAgentHandlerV2` | 关闭 Agent |
| `list_agents` | `ListAgentsHandlerV2` | 列出活跃 Agent |
| `send_message` | `SendMessageHandlerV2` | Agent 间消息传递 |
| `wait_agent` | `WaitAgentHandlerV2` | 等待 Agent（支持超时配置） |
| `followup_task` | `FollowupTaskHandlerV2` | 向已完成 Agent 发送后续任务 |

### 7.3 共享逻辑（multi_agents_common.rs）

- `DEFAULT_WAIT_TIMEOUT_MS = 30_000` (30s)
- `MIN_WAIT_TIMEOUT_MS = 10_000` (10s)
- `MAX_WAIT_TIMEOUT_MS = 3_600_000` (1h)
- 配置构建：`build_agent_spawn_config()` / `build_agent_resume_config()`
  - 继承父 Agent 的审批策略、沙箱策略、环境变量策略
  - 深度限制检查
  - 模型和推理力度覆盖

### 7.4 Agent Jobs（批量任务）

`BatchJobHandler` 支持 CSV 批量处理：
- `spawn_agents_on_csv` — 从 CSV 文件生成多个子 Agent
- `report_agent_job_result` — 报告单个任务结果
- 支持并发（默认16，最大64）、超时控制、进度发射

---

## 8. Code Mode 执行

### 8.1 架构

`CodeModeService` 封装了 `codex_code_mode` crate 的 JavaScript 沙箱执行：

- **CodeModeExecuteHandler** — 接收 `Custom { input }` 载荷，解析 JS 源码
- **CodeModeWaitHandler** — 等待异步代码输出
- **ExecContext** — 持有 session 和 turn，构建启用的工具列表

### 8.2 工具暴露

`build_enabled_tools()` 构建代码模式可用的工具子集，通过 `collect_code_mode_tool_definitions()` 和 `augment_tool_spec_for_code_mode()` 处理工具规格。

---

## 9. 其他工具处理器

### 9.1 ListDirHandler

- 输入：`dir_path`, `offset` (1-indexed), `limit` (默认25), `depth` (默认2)
- 尊重 `ReadDenyMatcher` 策略
- 递归 BFS 收集目录条目，按名称排序

### 9.2 JsReplHandler / JsReplResetHandler

- JS REPL 交互执行（通过 `codex_code_mode` crate）
- 支持变量持久化、存储值管理
- 输出 `ExecToolCallOutput` 格式

### 9.3 RequestPermissionsHandler

- 请求额外文件系统/网络权限
- 调用 `session.request_permissions()` 向用户请求批准
- 权限规范化通过 `normalize_additional_permissions()`

### 9.4 RequestUserInputHandler

- 向用户发送问题并等待回复
- 仅在 `SessionSource::SubAgent` 外可用
- 支持多选和单选问题

### 9.5 ToolSearchHandler

- **BM25 搜索引擎**，索引延迟加载的 MCP 工具和动态工具
- 输入：`query` + 可选 `limit`
- 返回匹配工具的名称、描述和命名空间

### 9.6 ToolSuggestHandler

- 根据对话上下文建议可能需要的工具

### 9.7 PlanHandler

- 更新会话计划状态
- 发射 `PlanUpdated` 事件

### 9.8 UnavailableToolHandler

- 为模型调用过但不可用的工具提供占位符
- 返回描述不可用状态的错误消息

---

## 10. 独立工具 Crate

### 10.1 codex-tools (`tools/src/lib.rs`)

共享工具定义 crate，不依赖 `codex-core`：

- `ToolSpec` — 工具规格（Function/Freeform/Namespace/ToolSearch/LocalShell/ImageGeneration/WebSearch）
- `ResponsesApiTool` — Responses API 工具定义
- `JsonSchema` — JSON Schema 构建器
- `ToolRegistryPlanParams` / `build_tool_registry_plan()` — 根据配置生成工具注册计划
- 所有工具的 `create_*_tool()` 工厂函数

### 10.2 codex-apply-patch (`apply-patch/src/lib.rs`)

独立 diff/patch 算法 crate：

- `parse_patch()` / `parse_patch_streaming()` — 解析 `*** Begin/End Patch` 格式
- `apply_patch()` — 应用补丁到文件系统
- `maybe_parse_apply_patch_verified()` — 从命令行参数识别并验证补丁

### 10.3 codex-shell-command (`shell-command/src/lib.rs`)

命令解析和安全工具：
- `parse_command::shlex_join()` — Shell 词法拼接
- `is_safe_command` / `is_dangerous_command` — 命令安全分类

### 10.4 codex-exec-server

为 `UnifiedExecProcessManager` 提供远程执行后端，实现 `ExecProcess` trait 和文件系统沙箱接口。

---

## 11. 工具调度流程详解

### 11.1 ToolRegistry.dispatch_any()

```
dispatch_any(invocation)
  → 查找 handler
  → 检查 payload 兼容性 (matches_kind)
  → 运行 PreToolUse hooks (可能阻断)
  → 检查 is_mutating → 等待 tool_call_gate
  → handler.handle_any(invocation)
  → 运行 PostToolUse hooks (可能替换输出)
  → 记录遥测指标
  → 发射 AfterToolUse 遗留 hook
  → 返回 AnyToolResult
```

### 11.2 变更守门 (tool_call_gate)

`is_mutating` 返回 `true` 的工具调用必须等待 `tool_call_gate` 就绪，确保变更操作串行化。

### 11.3 钩子系统

- **PreToolUse** — 可阻断工具执行，返回拒绝原因
- **PostToolUse** — 可替换工具输出或停止执行
- **AfterToolUse**（遗留）— 非阻断通知

---

## 12. 关键依赖关系图

```
codex-core
├── codex-tools          (工具定义、注册计划)
├── codex-apply-patch   (补丁算法)
├── codex-shell-command  (命令解析/安全)
├── codex-mcp            (MCP 连接管理)
├── codex-sandboxing     (沙箱策略转换)
├── codex-exec-server    (远程执行后端)
├── codex-protocol       (协议定义、模型类型)
├── codex-code-mode      (Code Mode 沙箱)
├── codex-rmcp-client    (MCP 客户端)
└── codex-utils-*        (输出截断、PTY、路径等)
```