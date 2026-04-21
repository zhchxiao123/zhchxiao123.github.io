---
title: "Step 3: 核心逻辑层"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/03-core-logic/
---
# Codex Core Logic Layer (codex-core) 深度分析

## 总览

`codex-core` 是 OpenAI Codex CLI 的核心逻辑层，封装了会话管理、Agent 系统、工具路由、审批机制、记忆、插件、配置等全部业务逻辑。它以 Rust 异步运行时（tokio）为基础，采用消息驱动的队列对架构（`Sender<Submission>` / `Receiver<Event>`），实现了单会话单任务（at most 1 running turn）的串行执行模型。

---

## 1. Session 生命周期

### 核心数据结构

**`Codex`**（`session/mod.rs`）—— 对外暴露的高层接口，持有一个 `Sender<Submission>` 提交通道和一个 `Receiver<Event>` 事件通道：

```rust
pub struct Codex {
    pub(crate) tx_sub: Sender<Submission>,
    pub(crate) rx_event: Receiver<Event>,
    pub(crate) agent_status: watch::Receiver<AgentStatus>,
    pub(crate) session: Arc<Session>,
    pub(crate) session_loop_termination: SessionLoopTermination,
}
```

**`Session`**（`session/session.rs`）—— 会话核心状态容器，持有：

| 字段 | 用途 |
|---|---|
| `conversation_id: ThreadId` | 线程唯一标识 |
| `tx_event: Sender<Event>` | 事件广播通道 |
| `state: Mutex<SessionState>` | 互斥保护的可变会话状态 |
| `conversation: Arc<RealtimeConversationManager>` | 实时对话管理 |
| `active_turn: Mutex<Option<ActiveTurn>>` | 当前活跃的 turn |
| `mailbox: Mailbox` / `mailbox_rx: Mutex<MailboxReceiver>` | Agent 间消息邮箱 |
| `guardian_review_session: GuardianReviewSessionManager` | Guardian 审批会话管理 |
| `services: SessionServices` | 所有服务依赖的集合（model_client, auth_manager, models_manager 等） |

**`SessionConfiguration`** —— 不可变的 per-session 配置，包含 provider、model、sandbox policy、approval policy、CWD、base_instructions 等。

**`SessionState`**（`state/session.rs`）—— session 内部可变状态：

```rust
pub(crate) struct SessionState {
    pub(crate) session_configuration: SessionConfiguration,
    pub(crate) history: ContextManager,
    pub(crate) latest_rate_limits: Option<RateLimitSnapshot>,
    pub(crate) previous_turn_settings: Option<PreviousTurnSettings>,
    pub(crate) agent_task: Option<SessionAgentTask>,
    pub(crate) active_connector_selection: HashSet<String>,
    // ...
}
```

**`CodexThread`**（`codex_thread.rs`）—— 对 `Codex` 的一层包装，附加了 rollout_path 和 file watcher 注册，代表一个持久化的线程。

### Session 创建流程

```
Codex::spawn(CodexSpawnArgs)
  ├─ 并行初始化：rollout_recorder / shell_discovery / history_metadata / auth_and_mcp
  ├─ 构造 SessionConfiguration
  ├─ Session::new(SessionConfiguration, ...)
  │    ├─ 初始化 McpConnectionManager、NetworkApprovalService、Hooks 等
  │    ├─ 发射 SessionConfigured 事件
  │    ├─ 启动 SkillsWatcher listener
  │    ├─ 记录 initial_history (New/Resumed/Forked)
  │    └─ 启动 memories startup task
  └─ 启动 submission_loop 异步任务
```

### 事件处理循环

`submission_loop`（`session/handlers.rs`）从 `rx_sub` 接收 `Submission`，根据 `Op` 枚举分发：

- `Op::UserTurn` / `Op::UserInput`：进入 `run_turn`
- `Op::Steer`：转向输入到当前 turn
- `Op::Shutdown`：关闭会话
- `Op::Compact`：手动压缩 context
- `Op::Undo`：回滚
- `Op::McpServerRefresh`：刷新 MCP 服务
- `Op::SetThreadMemoryMode`：设置 memory 模式
- 其他：审批响应、用户输入响应等

### Turn 处理（`turn.rs`）

`run_turn` 是核心采样循环：

```
run_turn(sess, turn_context, input, prewarmed_client_session, cancellation_token)
  ├─ run_pre_sampling_compact() → 自动压缩判断
  ├─ record_context_updates_and_set_reference_context_item()
  ├─ 加载 Plugins / Connectors / Skills → 构建 skill injections
  ├─ run_pending_session_start_hooks()
  ├─ build_prompt() → 组装模型输入
  ├─ 循环 run_sampling_request()
  │    ├─ built_tools() → 构建工具路由
  │    ├─ try_run_sampling_request() → 调用模型 API 流式响应
  │    │    ├─ 处理 tool calls → ToolOrchestrator → approval → sandbox → execution
  │    │    └─ 处理 assistant messages → emit events
  │    ├─ token limit check → auto compact if needed
  │    └─ stop hooks → after_agent hooks
  └─ 返回 last_agent_message
```

**`TurnContext`**（`turn_context.rs`）—— per-turn 上下文快照，包含 model_info, config, auth, sandbox policy, tools_config 等。每次 turn 开始时从 `SessionConfiguration` 构建，支持 `with_model()` 动态切换模型。

---

## 2. Agent 系统

### 架构

Agent 系统采用 **线程级多 Agent** 模型，每个 Agent 对应一个独立的 `CodexThread`（线程），通过 `AgentControl` 管理。

**`AgentControl`**（`agent/control.rs`） —— 多 Agent 控制面板：

```rust
pub(crate) struct AgentControl {
    manager: Weak<ThreadManagerState>,
    state: Arc<AgentRegistry>,
}
```

- 持有 `Weak<ThreadManagerState>` 引用全局线程管理器
- 共享 `AgentRegistry` 跟踪活跃 Agent 元数据

**关键方法：**

| 方法 | 功能 |
|---|---|
| `spawn_agent()` | 创建新 Agent 线程，支持 fork 模式 |
| `spawn_agent_with_metadata()` | 带元数据创建 Agent |
| `resume_agent_from_rollout()` | 从 rollout 文件恢复 Agent |
| `send_input()` | 向 Agent 发送输入 |
| `send_inter_agent_communication()` | Agent 间通信 |
| `interrupt_agent()` | 中断 Agent |
| `shutdown_live_agent()` / `close_agent()` | 关闭 Agent |
| `list_agents()` | 列出 Agent |
| `subscribe_status()` | 订阅 Agent 状态变更 |

**`AgentRegistry`**（`agent/registry.rs`）—— Agent 注册表：

- `active_agents: Mutex<ActiveAgents>` —— 维护 agent_tree (path → metadata)、used_nicknames
- `total_count: AtomicUsize` —— 原子计数，支持 `max_threads` 限制
- `SpawnReservation` —— RAII 式的 slot 占用，commit 时注册，drop 时释放

### 角色系统

**`AgentRoleConfig`** 定义在 `config/agent_roles.rs`：

```rust
pub(crate) struct AgentRoleConfig {
    pub(crate) description: Option<String>,
    pub(crate) config_file: Option<PathBuf>,  // 角色 TOML 配置文件
    pub(crate) nickname_candidates: Option<Vec<String>>,
}
```

内置角色：
- `default`：默认角色
- `explorer`：快速代码探索者，使用 `explorer.toml` 配置
- `worker`：执行和生产的工人

`apply_role_to_config()` 将角色配置叠加到 session config，通过 ConfigLayerStack 机制保证优先级。

### 消息传递

**`Mailbox`**（`agent/mailbox.rs`）—— 基于 `mpsc::UnboundedSender/Receiver` 的邮箱：

```rust
pub(crate) struct Mailbox {
    tx: mpsc::UnboundedSender<InterAgentCommunication>,
    next_seq: AtomicU64,
    seq_tx: watch::Sender<u64>,
}
```

- 每个 session 持有 `Mailbox` + `MailboxReceiver`
- 序列号单调递增，支持 `trigger_turn` 标记唤醒 turn
- `drain()` 一次性取出所有待处理消息

### 状态模型

**`AgentStatus`** 由事件派生（`agent/status.rs`）：

```
TurnStarted → Running
TurnComplete(msg) → Completed(msg)
TurnAborted(reason) → Interrupted / Errored
Error(msg) → Errored(msg)
ShutdownComplete → Shutdown
```

---

## 3. 工具注册与路由

### ToolSpec 与注册

**`ToolRegistry`**（`tools/registry.rs`）—— 核心工具注册表：

- `ToolHandler` trait：定义 `handle(ToolInvocation)`、`is_mutating()`、`kind()`、`pre/post_tool_use_payload()` 等
- `ToolKind`：`Function` | `Mcp`
- `AnyToolHandler` —— type-erased handler wrapper
- 工具通过 `ToolRegistryBuilder` 构建，注册各种 handler（Shell, UnifiedExec, ApplyPatch, Mcp, SpawnAgent 等）

**`build_specs_with_discoverable_tools()`** （`tools/spec.rs`）—— 根据配置动态构建可用工具列表：

1. 注册原生工具（Shell, UnifiedExec, ApplyPatch, ListDir, RequestPermissions 等）
2. 注册 MCP 工具（来自 `mcp_tools` 和 `deferred_mcp_tools`）
3. 注册多 Agent 工具（SpawnAgent, ListAgents, SendMessage, WaitAgent, CloseAgent 等 v1/v2 版本）
4. 注册 code-mode 工具（CodeModeExecute, CodeModeWait, JsRepl 等）
5. 注册不可用工具占位符（UnavailableDummyTools）

### ToolRouter

**`ToolRouter`**（`tools/router.rs`）—— 请求路由到具体 handler：

```rust
pub struct ToolRouter {
    registry: ToolRegistry,
    specs: Vec<ConfiguredToolSpec>,
    model_visible_specs: Vec<ToolSpec>,
    parallel_mcp_server_names: HashSet<String>,
}
```

- `from_config()` 根据配置和参数构建
- `dispatch()` 路由到 handler，支持并行 MCP 服务器
- `tool_supports_parallel()` 判断工具是否支持并行调用
- `model_visible_specs()` 过滤给模型可见的工具列表

### ToolOrchestrator

**`ToolOrchestrator`**（`tools/orchestrator.rs`）—— 编排审批 + sandbox + 重试：

```
run(tool, req, tool_ctx, turn_context, approval_policy)
  ├─ 1) Approval：判断是否需要审批
  │    ├─ Skip → 直接执行
  │    ├─ Forbidden → 拒绝
  │    └─ NeedsApproval →
  │         ├─ Guardian review（如果 on-request + guardian）
  │         └─ User approval request → emit event
  ├─ 2) Select sandbox：根据 approval 结果选择 sandbox 策略
  │    ├─ FullAccess
  │    ├─ NetworkOnly
  │    └─ Sandbox（bwrap/network-proxy）
  ├─ 3) Attempt：在 sandbox 中执行工具
  └─ 4) Retry with escalated sandbox（on denial, no re-approval）
```

### 并行执行

**`ToolCallRuntime`**（`tools/parallel.rs`）—— 封装并行工具调用：

```rust
pub(crate) struct ToolCallRuntime {
    router: Arc<ToolRouter>,
    session: Arc<Session>,
    turn_context: Arc<TurnContext>,
    tracker: SharedTurnDiffTracker,
    parallel_execution: Arc<RwLock<()>>,
}
```

- `handle_tool_call()` 处理单个工具调用
- `handle_tool_call_with_source()` 支持不同调用来源（Direct/JsRepl/CodeMode）
- 支持 `CancellationToken` 取消

---

## 4. Guardian 审批系统

### 设计哲学

Guardian 是一个 **AI 驱动的自动审批子系统**，用于在 `on-request` 模式下代替用户进行审批决策。其核心流程：

1. 重建紧凑的会话转录（保留用户意图 + 相关工具上下文）
2. 使用独立 Guardian review session 评估请求的操作
3. 返回严格的 JSON 格式判定（allow/deny + risk_level + rationale）
4. 超时或执行失败时 fail closed

### 核心组件

**`GuardianApprovalRequest`**（`guardian/approval_request.rs`）—— 审批请求枚举：

```rust
pub(crate) enum GuardianApprovalRequest {
    Shell { id, command, cwd, sandbox_permissions, ... },
    ExecCommand { id, command, cwd, ... },
    Execve { id, source, program, argv, cwd, ... },
    ApplyPatch { id, cwd, files, patch },
    NetworkAccess { id, target, host, protocol, port },
    McpToolCall { id, server, tool_name, arguments, annotations, ... },
}
```

**`GuardianReviewSessionManager`**（`guardian/review_session.rs`）—— 管理 Guardian review 会话：

- 维护 `trunk`（干线会话）和 `ephemeral_reviews`（临时评审会话）
- 支持会话复用 —— 相同 model 设置可重用已有 session
- `Semaphore` 控制并发评审

**`GuardianAssessment`**（`guardian/mod.rs`）—— Guardian 的结构化输出：

```rust
pub(crate) struct GuardianAssessment {
    risk_level: GuardianRiskLevel,       // Low/Medium/High/Critical
    user_authorization: GuardianUserAuthorization,
    outcome: GuardianAssessmentOutcome,   // Allow/Deny
    rationale: String,
}
```

### 审批流程

```
routes_approval_to_guardian(turn) ← 判断是否路由到 Guardian
  └─ approval_policy == OnRequest && approvals_reviewer == GuardianSubagent

review_approval_request(session, turn, request, ...)
  ├─ 获取或创建 Guardian review session
  ├─ 构建 guardian prompt items（transcript + action JSON）
  ├─ 提交 Op::UserTurn 到 Guardian session
  ├─ 等待响应（with timeout = 90s）
  └─ 解析 GuardianAssessment
       ├─ Allow → 自动批准
       └─ Deny → GuardianRejection（存入 session.services.guardian_rejections）
```

### Prompt 构建

`guardian/prompt.rs` 实现了转录的截断和格式化：

- `GuardianTranscriptEntry` —— 转录条目（User/Assistant/Tool）
- `GuardianTranscriptCursor` —— 增量转录指针
- `GuardianPromptMode::Delta` —— 仅发送新增内容，减少 token 消耗
- 各种截断限制：`GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS=10_000`、`GUARDIAN_MAX_ACTION_STRING_TOKENS=16_000`

---

## 5. Memory 系统

### 两阶段设计

Memory 系统采用两阶段管线：

**Phase 1（Startup Extraction）**：

- 在 session 启动时运行
- 扫描最近的 rollout 文件
- 使用 `gpt-5.4-mini`（low reasoning）提取结构化记忆
- 输出：`raw_memory`（markdown）+ `rollout_summary`（compact summary）+ `rollout_slug`
- 并发限制：`CONCURRENCY_LIMIT=8`
- Job 机制：基于 state_db 的 lease claim，避免重复提取

**Phase 2（Consolidation）**：

- 使用 `gpt-5.4`（medium reasoning）合并多条 raw memories
- 全局 consolidation lock 防止并发冲突
- 输出合并后的 `MEMORY.md` 和 `memory_summary.md`

### 存储

**`storage.rs`** —— 文件系统存储层：

- `codex_home/memories/` —— memory root
- `raw_memories.md` —— 合并后的原始记忆
- `rollout_summaries/` —— 每个 thread 的摘要文件
- `codex_home/memories_extensions/` —— 扩展目录
- 数据库后端：使用 `codex_state::Stage1Output` 存储 stage-1 输出

**`control.rs`** —— 提供清理操作 `clear_memory_roots_contents()`，安全删除（拒绝清空符号链接目录）。

### 使用追踪

**`usage.rs`** —— 追踪工具读取 memory 文件的遥测数据，区分 MemoryMd、MemorySummary、RawMemories、RolloutSummaries、Skills 五种类型。

### 与 Session 的交互

`memories/start.rs` 中的 `start_memories_startup_task()` 在 `Session::new()` 末尾调用，异步启动 phase-1 提取。提取结果不会注入到当前 turn 的 context，而是在后续 turn 中通过 `instructions` 系统注入。

---

## 6. Plugins 系统

### 架构

**`PluginsManager`**（`plugins/manager.rs`）—— 核心插件管理器：

- 从 `ConfigLayerStack` 多层配置加载插件（全局、项目、会话标志层）
- 支持 `configured_plugins_from_stack()` 合并配置层
- `plugins_for_config(&Config)` → `PluginLoadOutcome`
- 支持 App Connectors（MCP 工具映射到 app 概念）

**Plugin 生命周期：**

1. **发现（Discovery）**：从配置层发现已声明的插件
2. **同步（Sync）**：`startup_sync` 从远端仓库拉取最新插件数据
3. **加载（Loading）**：`plugins_for_config()` 根据 session 配置过滤和加载
4. **注入（Injection）**：`build_plugin_injections()` 构建注入到模型 prompt 的内容

### Marketplace 集成

**`marketplace_add.rs`** —— 支持从 marketplace 添加插件：

- `MarketplaceAddRequest` → `MarketplaceAddOutcome`
- 验证插件 ID、版本兼容性
- 写入配置层

**`marketplace_remove.rs`** —— 从 marketplace 移除插件

### 插件发现

**`discoverable.rs`** —— 列出用户可见但未启用的工具建议（tool_suggest 功能），根据认证状态过滤。

### 渲染

**`render.rs`** —— 将插件信息渲染为模型可消费的 prompt 文本：

- `render_plugins_section()` → 渲染所有活跃插件的指令
- `render_explicit_plugin_instructions()` → 渲染用户显式提到的插件

---

## 7. 配置系统

### 配置层级

配置采用 **多层级覆盖** 模型，优先级从低到高：

1. **Cloud requirements** —— 托管云强制要求
2. **System** —— `/etc/codex/requirements.toml` (Unix) 或 `C:\ProgramData\codex\requirements.toml` (Windows)
3. **Admin managed preferences** —— 管理员偏好
4. **System config** —— `/etc/codex/config.toml`
5. **Global user config** —— `~/.codex/config.toml`
6. **Project config** —— 项目目录下的 AGENTS.md 和配置
7. **Session flags** —— 运行时命令行标志和 API 指令
8. **Agent role layer** —— agent 角色叠加层

**`ConfigLayerStack`**（`config_loader/mod.rs`）—— 按优先级管理配置层：

```rust
pub struct ConfigLayerStack {
    layers: Vec<ConfigLayerEntry>,
    requirements: ConfigRequirements,
    requirements_toml: ConfigRequirementsToml,
}
```

每层有 `ConfigLayerSource`（System/User/Project/SessionFlags 等），约束层（requirements）不可被后续覆盖。

### Config 结构体

**`Config`**（`config/mod.rs`，约2500行）—— 庞大的配置结构体，包含：

| 分类 | 关键字段 |
|---|---|
| 模型 | `model`, `model_provider`, `model_provider_id`, `model_reasoning_effort` |
| 权限 | `permissions: Permissions`（approval_policy, sandbox_policy, network, shell_environment_policy） |
| MCP | `mcp_servers`, `mcp_oauth_credentials_store_mode` |
| 功能 | `features: ManagedFeatures` |
| 多 Agent | `agent_max_threads`, `agent_max_depth`, `multi_agent_v2` |
| 记忆 | `memories: MemoriesConfig` |
| 路径 | `codex_home`, `cwd`, `zsh_path`, `js_repl_node_path` |
| 遥测 | `analytics_enabled`, `otel`, `chatgpt_base_url` |

**`Permissions`** 子结构体：
- `approval_policy: Constrained<AskForApproval>` —— 约束值，不可被低优先级层松化
- `sandbox_policy: Constrained<SandboxPolicy>`
- `file_system_sandbox_policy`
- `network_sandbox_policy`
- `network: Option<NetworkProxySpec>` —— 托管网络代理配置

### 权限策略

`config/permissions.rs` 负责将 TOML 声明的权限配置编译为运行时策略：

```
PermissionsToml → compile_permission_profile() → (FileSystemSandboxPolicy, NetworkSandboxPolicy)
```

- 文件系统策略：支持 `allow_read`, `allow_write`, `deny_read` 路径模式（在 macOS 上支持 glob）
- 网络策略：`allow_domains`, `deny_domains` 过滤
- `SandboxPolicy` 运行时枚举：`DangerFullAccess` | `NetworkOnly` | `StrictSandbox` | 自定义 profile

### ConfigService

**`ConfigService`**（`config/service.rs`）—— 提供 RPC 式的配置读写：

- `read_config(params)` → `ConfigReadResponse`
- `write_config(params)` → `ConfigWriteResponse`
- 支持合并策略（`MergeStrategy::DeepMerge` / `Replace`）
- 配置层元数据（source, overridden status）

### Agent Role 配置

`config/agent_roles.rs` —— 从配置层加载 agent 角色定义：

- 遍历 `ConfigLayerStack` 各层的 `agents.roles` 配置
- 支持从 `agents/` 目录发现角色文件
- 角色定义包括：description, config_file 路径, nickname_candidates
- 角色配置以最高优先级 SessionFlags 层叠加到 base config

---

## 模块间关系图

```
                         ┌─────────────┐
                         │  CodexThread │
                         │  (codex_thread.rs) │
                         └──────┬──────┘
                                │
                         ┌──────▼──────┐
                         │    Codex     │
                         │ (session/mod.rs) │
                         └──────┬──────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                   │
       ┌──────▼──────┐  ┌──────▼──────┐  ┌───────▼────────┐
       │   Session    │  │  handlers   │  │   TurnContext   │
       │ (session.rs) │  │ (handlers.rs)│  │(turn_context.rs)│
       └──────┬──────┘  └──────┬──────┘  └───────┬────────┘
              │                │                   │
    ┌─────────┼──────┬───────┼──────┬────────────┤
    │         │      │       │      │            │
┌───▼──┐ ┌───▼──┐ ┌─▼──┐ ┌─▼──┐ ┌─▼────┐ ┌─────▼─────┐
│Agent │ │Guardian│ │MCP │ │Mem │ │Tools  │ │  Compact   │
│System │ │Review  │ │Mgr │ │ory │ │Router │ │  (compact) │
└───┬──┘ └───┬──┘ └─┬──┘ └─┬──┘ └───┬───┘ └──────────┘
    │        │       │      │        │
┌───▼──┐ ┌──▼───┐ ┌─▼──┐ ┌─▼──┐ ┌──▼────┐
│Agent │ │Agent │ │MCP │ │Ph1 │ │Tool   │
│Regist│ │Mailbox│ │Conn│ │Ph2 │ │Handler│
│  ry   │ │      │ │Mgr │ │    │ │  Orch  │
└──────┘ └──────┘ └────┘ └────┘ └───────┘

    ┌──────────────────────────────────────────┐
    │              Config System               │
    │  ConfigLayerStack → Config → SessionConfig │
    │  Permissions → SandboxPolicy → ToolPolicy  │
    │  AgentRoles → AgentRoleConfig → RoleLayer   │
    └──────────────────────────────────────────┘

    ┌──────────────────────────────────────────┐
    │            Plugins System                 │
    │  PluginsManager → PluginLoadOutcome      │
    │  Marketplace → Sync → Load → Inject     │
    └──────────────────────────────────────────┘
```

---

## 关键流程总结

### 1. Turn 生命期

```
UserTurn/Steer
  → new_turn_with_sub_id() → 构建 TurnContext
  → run_turn()
    → pre_sampling_compact (自动压缩)
    → context updates
    → skills / plugins injection
    → session hooks (before_agent)
    → build_prompt() → 组装 Prompt
    → sampling loop:
        → try_run_sampling_request()
            → built_tools() → ToolRouter
            → model API streaming response
            → tool call → ToolOrchestrator → approval → sandbox → execute
            → assistant message → emit events
        → token limit → auto compact
    → stop hooks (after_agent)
```

### 2. Guardian 审批流

```
OnRequest + GuardianReviewer
  → ToolOrchestrator.run()
    → NeedsApproval
    → routes_approval_to_guardian() == true
    → review_approval_request()
      → get/create Guardian review session
      → spawn_review_thread()
        → build guardian prompt (transcript + action JSON)
        → Op::UserTurn to Guardian session
      → parse GuardianAssessment
        → Allow → auto-approve
        → Deny → GuardianRejection → inject rejection message
```

### 3. Multi-Agent 通信

```
Parent Thread (Codex)
  → AgentControl.spawn_agent()
    → ThreadManagerState.spawn_new_thread_with_source()
    → Register in AgentRegistry
    → Start completion watcher
  → Agent Mailbox
    → Mailbox.send(InterAgentCommunication)
    → MailboxReceiver.drain() in turn loop
  → Child sends InterAgentCommunication → parent injects message
```

### 4. Context 压缩流

```
Token usage >= auto_compact_limit
  → run_auto_compact()
    → should_use_remote_compact_task() ?
      → run_inline_remote_auto_compact_task() (server-side)
      → run_inline_auto_compact_task() (local)
    → 新 turn 以 compact prompt 运行
    → 替换 history 为摘要
```

---

## 分析总结

`codex-core` 是一个高度模块化、事件驱动的单线程 per-session 架构。其核心设计特点：

1. **队列对模型**：`Codex` 通过 `Sender<Submission>` / `Receiver<Event>` 实现异步事件驱动，session loop 单线程处理所有 submission
2. **Turn 串行性**：一个 Session 最多 1 个 active turn，通过 `active_turn: Mutex<Option<ActiveTurn>>` 保证
3. **Guardian 子系统**：AI-driven 自动审批，独立 session 复用，fail-closed 策略
4. **多层配置覆盖**：从云要求到 session 标志的 7+ 层叠加，Constrained<> 泛型保证约束不可软化
5. **Agent 线程模型**：每个 Agent 是独立 CodexThread，AgentControl 管理 spawn/resume/interrupt 生命周期
6. **Memory 两阶段管线**：异步 startup extraction + global consolidation lock，与 model API 交互提取记忆
7. **Plugin 动态发现**：从配置层、marketplace、本地目录多源加载，注入到模型 prompt