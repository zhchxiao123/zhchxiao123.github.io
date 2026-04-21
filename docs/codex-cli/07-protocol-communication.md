---
title: "Step 7: 协议与通信层"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/07-protocol-communication/
---
# OpenAI Codex CLI — 协议与通信层深度分析

> 生成时间: 2026-04-21  
> 项目路径: `codex-rs/`  
> 分析范围: 协议定义、App Server 协议/实现/客户端、API 客户端、Realtime/WebRTC、MCP 协议、认证系统

---

## 1. 协议栈层次图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户交互层 (TUI / CLI / VS Code)               │
├─────────────────────────────────────────────────────────────────────┤
│                   App Server Client (app-server-client)             │
│          ┌──────────────────┬────────────────────┐                  │
│          │ InProcessClient  │  RemoteClient (WS) │                  │
├──────────┴──────────────────┴────────────────────┴──────────────────┤
│               App Server Protocol (JSON-RPC / WebSocket)            │
│          ┌──────────┬──────────────┬──────────────┐               │
│          │   v1 API  │   v2 API     │  通知/请求    │               │
├──────────┴──────────┴──────────────┴──────────────┴──────────────────┤
│                    App Server 实现 (app-server)                      │
│            MessageProcessor → ThreadState → CodexThread             │
├─────────────────────────────────────────────────────────────────────┤
│                      Codex Protocol (protocol crate)                │
│          ┌────────────┬──────────────┬───────────────────┐         │
│          │  Submission │   EventMsg   │  Op (操作枚举)     │         │
│          │  Queue (SQ) │   Queue (EQ) │                   │         │
├────────────┴────────────┴──────────────┴───────────────────┴─────────┤
│               Core 引擎层 (codex-core)                              │
│     ┌───────────────┬────────────────┬──────────────────┐           │
│     │ ModelClient   │ CodexThread    │ Session/Config    │           │
├─────┴───────────────┴────────────────┴──────────────────┴───────────┤
│                       外部通信层                                     │
│  ┌────────────────┬──────────────────┬───────────────────┐         │
│  │ OpenAI Responses│  MCP Servers     │  Realtime API      │         │
│  │ API (SSE/WS)   │  (RMCP Client)   │  (WebSocket/WebRTC)│         │
│  └────────────────┴──────────────────┴───────────────────┘         │
├─────────────────────────────────────────────────────────────────────┤
│                       认证层 (login / secrets / keyring-store)       │
│  ┌──────────────┬────────────────┬────────────────────────┐         │
│  │  OAuth (PKCE) │  API Key Auth  │  ChatGPT Token Refresh  │         │
│  └──────────────┴────────────────┴────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Protocol Crate — 核心协议定义

### 2.1 通信模型: SQ/EQ (Submission Queue / Event Queue)

`protocol/src/protocol.rs` 定义了 Codex 会话的核心通信模型:

- **Submission** — 客户端 → 代理 的请求，包含唯一 `id`、操作 `op`、可选 `trace`(W3C trace context)
- **Event** — 代理 → 客户端 的事件，关联对应的 `id`

```
客户端 (TUI/CLI)                    代理 (CodexThread)
      │                                  │
      │──── Submission {id, op} ────────>│  (SQ - 提交队列)
      │                                  │
      │<──── Event {id, msg} ───────────│  (EQ - 事件队列)
      │                                  │
```

### 2.2 Op 枚举 — 用户可提交的操作

`Op` 是一个大型枚举（`protocol/src/protocol.rs:394-706`），定义了所有客户端可提交的操作:

| 类别 | Op 变体 | 说明 |
|------|---------|------|
| **用户输入** | `UserInput`, `UserTurn` | 发送消息/开始新对话轮次 |
| **实时语音** | `RealtimeConversationStart/Audio/Text/Close/ListVoices` | 实时语音交互 |
| **审批** | `ExecApproval`, `PatchApproval` | 批准/拒绝执行和补丁请求 |
| **MCP** | `ResolveElicitation`, `ListMcpTools`, `RefreshMcpServers` | MCP 工具交互 |
| **权限** | `RequestPermissionsResponse`, `DynamicToolResponse` | 权限与动态工具响应 |
| **上下文管理** | `AddToHistory`, `GetHistoryEntryRequest`, `Compact`, `Undo` | 历史与上下文管理 |
| **配置** | `OverrideTurnContext`, `ReloadUserConfig` | 动态配置更新 |
| **线程管理** | `SetThreadName`, `SetThreadMemoryMode`, `ThreadRollback` | 线程级操作 |
| **代理间通信** | `InterAgentCommunication` | 子代理间通信 |
| **其他** | `Interrupt`, `Shutdown`, `RunUserShellCommand`, `Review`, `ListModels` | 控制流 |

### 2.3 EventMsg 枚举 — 代理发出的事件

`EventMsg`（`protocol/src/protocol.rs:1418-1625`）定义了所有代理事件，核心事件类型包括:

**生命周期事件:**
- `TurnStarted` / `TurnComplete` — 对话轮次开始/结束
- `TurnAborted` — 轮次被中断
- `ShutdownComplete` — 代理关闭完成

**内容流事件 (增量):**
- `AgentMessageDelta` / `AgentMessageContentDelta` — 消息增量文本
- `AgentReasoningDelta` / `ReasoningContentDelta` / `ReasoningRawContentDelta` — 推理内容增量
- `ExecCommandOutputDelta` — 终端输出增量
- `PatchApplyUpdated` — 补丁应用更新
- `PlanDelta` — 计划增量

**工具调用事件:**
- `McpToolCallBegin` / `McpToolCallEnd` — MCP 工具调用生命周期
- `DynamicToolCallRequest` / `DynamicToolCallResponse` — 动态工具
- `WebSearchBegin` / `WebSearchEnd` — Web 搜索
- `ImageGenerationBegin` / `ImageGenerationEnd` — 图片生成
- `ExecCommandBegin` / `ExecCommandEnd` — Shell 命令执行
- `ViewImageToolCall` — 图片查看

**审批/交互事件:**
- `ExecApprovalRequest`, `ApplyPatchApprovalRequest` — 执行/补丁审批请求
- `RequestPermissions`, `RequestUserInput` — 权限/用户输入请求
- `ElicitationRequest` — MCP 诱导请求
- `GuardianAssessment` — Guardian 安全评估

**实时语音事件:**
- `RealtimeConversationStarted` / `RealtimeConversationRealtime` / `RealtimeConversationClosed` / `RealtimeConversationSdp`
- `RealtimeConversationListVoicesResponse`

**会话事件:**
- `SessionConfigured` — 会话配置完成
- `TokenCount` — Token 使用更新
- `ModelReroute` — 模型路由变更
- `ContextCompacted` — 上下文压缩完成
- `ThreadRolledBack` — 线程回滚

**协作代理事件:**
- `CollabAgentSpawnBegin/End`, `CollabAgentInteractionBegin/End`, `CollabWaitingBegin/End`, `CollabCloseBegin/End`, `CollabResumeBegin/End`

### 2.4 TurnItem — 轮次条目数据模型

`protocol/src/items.rs` 定义了结构化的轮次条目:

```rust
pub enum TurnItem {
    UserMessage(UserMessageItem),       // 用户消息
    HookPrompt(HookPromptItem),          // Hook 提示
    AgentMessage(AgentMessageItem),       // 代理消息
    Plan(PlanItem),                       // 计划条目
    Reasoning(ReasoningItem),             // 推理条目
    WebSearch(WebSearchItem),             // Web 搜索
    ImageGeneration(ImageGenerationItem), // 图片生成
    ContextCompaction(ContextCompactionItem), // 上下文压缩
}
```

每个 `TurnItem` 都有 `as_legacy_events()` 方法，可以将新格式转换为兼容的 `EventMsg` 事件序列。

### 2.5 安全与沙盒策略

`SandboxPolicy` 定义了四层安全模型:

| 策略 | 说明 |
|------|------|
| `DangerFullAccess` | 无限制完全访问 |
| `ReadOnly` | 只读文件系统访问 |
| `ExternalSandbox` | 外部沙盒，全盘读写但遵守网络设置 |
| `WorkspaceWrite` | 工作区可写，含可配置的 `writable_roots` 和 `read_only_access` |

审批策略 `AskForApproval` 从严格到宽松:
- `UnlessTrusted` — 只信任已知安全的命令
- `OnFailure` — 失败时审批（已废弃）
- `OnRequest` — 模型决定何时请求审批（默认）
- `Granular(config)` — 细粒度控制
- `Never` — 从不请求审批

### 2.6 会话元数据

`SessionMeta` 记录会话级别的持久信息:
- `id: ThreadId` — 线程标识
- `forked_from_id: Option<ThreadId>` — 分叉来源
- `cwd: PathBuf` — 当前工作目录
- `source: SessionSource` — 来源 (Cli/VSCode/Exec/Mcp/SubAgent)
- `base_instructions: Option<BaseInstructions>` — 基础指令
- `dynamic_tools: Option<Vec<DynamicToolSpec>>` — 动态工具
- `model_provider: Option<String>` — 模型提供者

---

## 3. App Server Protocol (v2) — JSON-RPC 协议

### 3.1 协议架构

`app-server-protocol` crate 定义了三层协议:

```
app-server-protocol/
├── protocol/
│   ├── v1.rs      — 版本 1 API (兼容旧版)
│   ├── v2.rs      — 版本 2 API (当前主力)
│   ├── common.rs  — 请求/响应/通知注册宏
│   ├── item_builders.rs — 构建器
│   ├── mappers.rs  — v1↔v2 映射
│   ├── thread_history.rs — 线程历史
│   └── serde_helpers.rs — 序列化辅助
├── jsonrpc_lite.rs — JSON-RPC 基础类型
├── experimental_api.rs — 实验性 API 标注
└── export.rs     — TypeScript/JSON Schema 导出
```

### 3.2 客户端请求 (ClientRequest)

`common.rs` 使用 `client_request_definitions!` 宏声明所有 RPC 方法:

```rust
client_request_definitions! {
    Initialize { ... },                          // 初始化握手
    ThreadStart => "thread/start" { ... },       // 创建新线程
    ThreadResume => "thread/resume" { ... },     // 恢复线程
    ThreadFork => "thread/fork" { ... },         // 分叉线程
    ThreadArchive => "thread/archive" { ... },  // 归档
    ThreadRollback => "thread/rollback" { ... },  // 回滚
    ThreadRead => "thread/read" { ... },         // 读取线程
    ThreadTurnsList => "thread/turns/list" { ... }, // 列出对话轮次
    TurnStart => "turn/start" { ... },           // 开始对话轮次
    TurnSteer => "turn/steer" { ... },           // 中途引导对话
    // ... 配置、文件操作、技能等更多方法
}
```

**关键设计原则:**

1. **`#[serde(rename_all = "camelCase")]`** — 所有 API 字段 camelCase 序列化
2. **`#[ts(export_to = "v2/")]`** — TypeScript 类型导出到 v2 命名空间
3. **`#[experimental("method/or/field")]`** — 实验性 API 标注，运行时门控
4. **`*Params` 请求载荷 / `*Response` 响应载荷** — 统一命名
5. **`*Notification` 通知类型** — 服务器推送事件
6. **游标分页** — 列表方法都包含 `cursor` 和 `limit` 参数

### 3.3 服务器通知 (ServerNotification)

v2 定义了丰富的通知类型，覆盖对话生命周期、命令执行、审批、实时语音等所有事件流。

### 3.4 服务器请求 (ServerRequest)

客户端需响应的服务器主动请求:
- `ToolRequestUserInput` — 请求用户输入（审批、选择等）
- `ChatgptAuthTokensRefresh` — ChatGPT Auth Token 刷新

---

## 4. App Server 实现

### 4.1 架构概览

```
                    ┌────────────────────────────────┐
                    │         Transport Layer        │
                    │  ┌──────────┬─────────────────┐ │
                    │  │  Stdio   │  WebSocket       │ │
                    │  └──────────┴─────────────────┘ │
                    └──────────┬─────────────────────┘
                               │ TransportEvent
                    ┌──────────┴─────────────────────┐
                    │       MessageProcessor          │
                    │  ┌──────────────────────────┐   │
                    │  │   ThreadState / Thread    │   │
                    │  │   (per-connection state)   │   │
                    │  └──────────────────────────┘   │
                    └──────────┬─────────────────────┘
                               │
                    ┌──────────┴─────────────────────┐
                    │     Outbound Router            │
                    │  (route messages to clients)    │
                    └────────────────────────────────┘
```

### 4.2 传输层

App Server 支持三种传输模式:

1. **Stdio** — 单客户端模式，通过标准输入/输出通信
2. **WebSocket** — 多客户端模式，支持远程连接
3. **Off** — 无传输（仅远程控制）

传输事件通过 `mpsc::channel` 传递给处理器:

```rust
enum TransportEvent {
    ConnectionOpened { connection_id, writer, disconnect_sender },
    ConnectionClosed { connection_id },
    IncomingMessage { connection_id, message: JSONRPCMessage },
}
```

### 4.3 出站消息路由

`OutboundControlEvent` 管理连接的注册/移除/断开:
- `Opened` — 注册新的出站连接写入器
- `Closed` — 移除断开的连接
- `DisconnectAll` — 优雅重启时断开所有连接

---

## 5. App Server Client — 客户端抽象

### 5.1 双模式架构

`app-server-client` 提供两种客户端模式:

```rust
pub enum AppServerClient {
    InProcess(InProcessAppServerClient),  // 进程内直接调用
    Remote(RemoteAppServerClient),          // 远程 WebSocket 连接
}

pub enum AppServerRequestHandle {
    InProcess(InProcessAppServerRequestHandle),
    Remote(RemoteAppServerRequestHandle),
}
```

### 5.2 InProcess 客户端

- 使用 `mpsc` 通道桥接调用方和底层 `InProcessClientHandle`
- 有界队列容量，背压控制
- **无损事件优先级:** AgentMessageDelta、PlanDelta、ReasoningDelta、ItemCompleted、TurnCompleted 等核心事件**必须送达**（阻塞等待），其他事件可以丢弃
- 服务器请求在队列满时自动拒绝（避免审批流挂起）

### 5.3 背压策略

`forward_in_process_event` 实现了智能事件转发:

1. **必需送达事件** (transcript deltas, completion signals) → `event_tx.send(event).await` (阻塞)
2. **尽力送达事件** (command output, progress) → `event_tx.try_send(event)` (非阻塞)
3. 队列满时累计 `skipped_events` 计数
4. 在下一个必需送达事件前插入 `Lagged { skipped: N }` 标记

### 5.4 请求类型

客户端请求通过 `ClientCommand` 枚举分发:

```rust
enum ClientCommand {
    Request { request: Box<ClientRequest>, response_tx },
    Notify { notification: ClientNotification, response_tx },
    ResolveServerRequest { request_id, result, response_tx },
    RejectServerRequest { request_id, error, response_tx },
    Shutdown { response_tx },
}
```

---

## 6. Responses API Client — 与 OpenAI API 通信

### 6.1 ModelClient 架构

`core/src/client.rs` 的 `ModelClient` 是与 OpenAI Responses API 的核心接口:

- **Session-scoped:** `ModelClientSession` 每个 turn 创建，管理 WebSocket 连接和 turn state
- **SSE 优先:** 默认使用 SSE (Server-Sent Events) 流式传输
- **WebSocket 预热:** V2 连接使用 `response.create` with `generate=false` 预暖
- **重试/回退:** 连接失败时回退到 SSE

### 6.2 关键 HTTP 头

```rust
pub const OPENAI_BETA_HEADER: &str = "OpenAI-Beta";
pub const X_CODEX_TURN_STATE_HEADER: &str = "x-codex-turn-state";
pub const X_CODEX_TURN_METADATA_HEADER: &str = "x-codex-turn-metadata";
pub const X_CODEX_PARENT_THREAD_ID_HEADER: &str = "x-codex-parent-thread-id";
```

### 6.3 SSE 事件流

通过 `eventsource_stream` crate 读取 SSE 事件 (`Event` 枚举: `Message`, `Retry`)，事件格式遵循 OpenAI Responses API 规范。

### 6.4 认证流程

```
AuthManager ─┬─ API Key (环境变量 / 文件)
             ├─ ChatGPT OAuth (PKCE 流程)
             │   ├─ request_device_code()
             │   ├─ complete_device_code_login()
             │   └─ token refresh
             └─ 外部 Auth Tokens (ChatGPT Auth Tokens)
                 └─ 外部宿主应用提供，仅内存存储
```

三种认证模式 (`AuthMode`):
- `ApiKey` — OpenAI API Key
- `Chatgpt` — ChatGPT OAuth，Codex 管理 token 持久化和刷新
- `ChatgptAuthTokens` — 外部提供的 ChatGPT tokens，仅内存存储

---

## 7. Realtime / WebRTC 语音交互

### 7.1 实时语音事件模型

`protocol/src/protocol.rs` 定义了实时语音协议:

```rust
pub enum RealtimeEvent {
    SessionUpdated { session_id, instructions },
    InputAudioSpeechStarted,
    InputTranscriptDelta/ Done,
    OutputTranscriptDelta/ Done,
    AudioOut(RealtimeAudioFrame),
    ResponseCreated/ ResponseCancelled/ ResponseDone,
    ConversationItemAdded/ ConversationItemDone,
    HandoffRequested(RealtimeHandoffRequested),
    NoopRequested(RealtimeNoopRequested),
    Error(String),
}
```

### 7.2 Realtime WebRTC 连接

`realtime-webrtc/src/lib.rs` 提供跨平台 WebRTC 连接:

```rust
pub struct StartedRealtimeWebrtcSession {
    pub offer_sdp: String,           // WebRTC Offer SDP
    pub handle: RealtimeWebrtcSessionHandle,
    pub events: mpsc::Receiver<RealtimeWebrtcEvent>,
}

pub enum RealtimeWebrtcEvent {
    Connected,
    LocalAudioLevel(u16),
    Closed,
    Failed(String),
}
```

- **macOS 原生实现** (`native.rs`) — 使用 macOS 原生 WebRTC API
- **不支持平台** — 返回 `UnsupportedPlatform` 错误

### 7.3 语音选项

支持 19 种预设语音（v1/v2 两代）:
- v1 默认: `Cove`
- v2 默认: `Marin`

对话传输模式:
- `Websocket` — WebSocket 传输
- `Webrtc { sdp: String }` — WebRTC SDP 传输

输出模态:
- `Text` — 文本输出
- `Audio` — 音频输出

---

## 8. MCP 协议桥接架构

### 8.1 McpConnectionManager

`codex-mcp/src/mcp_connection_manager.rs` 管理 MCP 服务器连接:

```
Configuration (McpServerConfig)
        │
        ▼
McpConnectionManager
  ├── McpServer "server-1" (RmcpClient)
  │     └── stdio transport → MCP Server Process
  ├── McpServer "server-2" (RmcpClient)
  │     └── HTTP SSE transport → Remote MCP Server
  └── ...
```

核心职责:
- 每个 MCP 服务器对应一个 `RmcpClient` 实例
- 使用 `StdioServerLauncher` / `ExecutorStdioServerLauncher` 启动 stdio 传输
- 工具名使用 `server_name__tool_name` 的全限定命名
- 支持 `ElicitationRequest` — MCP 服务器可以向用户发起信息征求

### 8.2 MCP 生命周期

1. **发现:** `configured_mcp_servers()` → `effective_mcp_servers()` 合并配置
2. **初始化:** `InitializeRequestParams` 握手，交换 `ClientCapabilities`
3. **工具发现:** `ListTools` / `ListResourceTemplates` / `ListResources`
4. **调用:** `CallTool` 带序列化参数
5. **审批:** 检查 `mcp_permission_prompt_is_auto_approved()` 
6. **Elicitation:** MCP 服务器通过 `SendElicitation` 请求用户输入
7. **刷新:** `RefreshMcpServers` 触发重连和工具列表刷新

### 8.3 工具命名空间

MCP 工具使用分隔符 `__` 组合服务器名和工具名:

```
qualify_tools(server_name, tool_name) → "{server_name}__{tool_name}"
```

这避免了不同 MCP 服务器间工具名冲突。

---

## 9. 认证系统

### 9.1 AuthManager

`login/src/auth.rs` 提供核心认证管理:

```
AuthManager
  ├── AuthConfig ─── AuthDotJson (持久化)
  │     ├── api_key: Option<String>
  │     └── chatgpt_tokens: Option<TokenData>
  ├── CodexAuth (trait-like interface)
  │     ├── auth_header() → Authorization value
  │     ├── refresh_if_needed() → token refresh
  │     └── is_expired() → bool
  └── Token 刷新策略:
        ├── refresh_token_url (可覆盖)
        ├── PKCE flow for ChatGPT
        └── 自动刷新过期 token
```

### 9.2 OAuth PKCE 流程

`login/src/pkce.rs` 和 `login/src/device_code_auth.rs`:

1. 生成 PKCE code_verifier + code_challenge
2. 启动本地 HTTP 服务器 (`LoginServer`) 监听回调
3. 打开浏览器到 ChatGPT 授权页面
4. 接收回调中的 `code`
5. 用 code + code_verifier 换取 access_token / refresh_token
6. 持久化到 `AuthDotJson`

### 9.3 密钥管理

`secrets/` + `keyring-store/`:

```
SecretsManager
  ├── Scope: Global | Environment(String)
  ├── Backend: Local (文件系统加密存储)
  │     ├── codex_home/global/{secret_name}
  │     └── codex_home/env/{env_id}/{secret_name}
  └── KeyringStore (trait)
        └── DefaultKeyringStore → OS keyring (keyring crate)
```

- `SecretScope::Global` — 全局密钥
- `SecretScope::Environment(environment_id)` — 环境级密钥（基于 git repo 根目录或 CWD hash）

### 9.4 Plan 类型 (计费层级)

```
KnownPlan: Free | Go | Plus | Pro | ProLite | Team | SelfServeBusinessUsageBased | Business | EnterpriseCbpUsageBased | Enterprise | Edu
```

---

## 10. 请求/响应数据流详解

### 10.1 完整对话轮次流程

```
[客户端]                              [App Server]                    [Core]
    │                                      │                            │
    │── thread/start ──────────────────────>│                            │
    │<── ThreadStartResponse ───────────────│                            │
    │                                      │                            │
    │── turn/start ────────────────────────>│── create CodexThread ───>│
    │                                      │                            │
    │<── TurnStarted ───────────────────── │<── Event: TurnStarted ────│
    │                                      │                            │
    │                                      │    ┌─── OpenAI API ────┐  │
    │                                      │    │  SSE/WS stream     │  │
    │<── AgentMessageDelta ───────────── │<───│── delta chunks ───>│  │
    │<── AgentReasoningDelta ─────────────│<───│── reasoning ──────>│  │
    │                                      │    └────────────────────┘  │
    │                                      │                            │
    │<── ExecApprovalRequest ─────────────│<── 需要用户审批 ───────────│
    │── ExecApproval {approved} ──────────>│── 继续执行 ───────────────>│
    │                                      │                            │
    │<── TurnCompleted ────────────────────│<── Event: TurnComplete ───│
    │<── TokenCount ─────────────────────│<── token 使用更新 ────────│
```

### 10.2 SSE 事件流协议

与 OpenAI Responses API 的 SSE 通信:

```
POST /responses
Authorization: Bearer {api_key}
OpenAI-Beta: responses_websockets=2026-02-06
x-codex-turn-state: {turn_state_token}

--- SSE Stream ---

event: response.created
data: {"id":"resp-xxx","type":"response.created",...}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,...}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"...","output_index":0}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"...","output_index":0}

event: response.completed
data: {"type":"response.completed","response":{...}}
```

### 10.3 App Server WebSocket 消息格式

```json
// 客户端请求
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "turn/start",
  "params": {
    "threadId": "thread-xxx",
    "userInput": [...],
    "model": "gpt-4.1",
    ...
  }
}

// 服务器通知
{
  "jsonrpc": "2.0",
  "method": "turn/completed",
  "params": {
    "threadId": "thread-xxx",
    "turnId": "turn-yyy",
    ...
  }
}
```

---

## 11. 关键设计模式与总结

### 11.1 架构特点

1. **双队列模式 (SQ/EQ):** Submission Queue + Event Queue 实现异步通信，解耦输入和输出
2. **JSON-RPC over WebSocket/Stdio:** App Server 使用 JSON-RPC 2.0 协议，支持双向通信
3. **SSE 流式传输:** 与 OpenAI API 通信使用 Server-Sent Events
4. **WebSocket v2 连接预热:** 新连接使用 `generate=false` 预创建，减少延迟
5. **渐进式类型系统:** `v1` (兼容) → `v2` (主力)，v2 使用 camelCase 和显式 `*Params`/`*Response` 命名
6. **TypeScript 同步:** `ts-rs` 自动导出 Rust 类型到 TypeScript，确保前后端类型一致
7. **实验性 API 标注:** `#[experimental("method/or/field")]` 宏标记实验性功能，运行时可检查
8. **背压感知的事件传递:** Lossless/Lossy 分级，确保核心 UI 数据不丢失
9. **TurnItem + EventMsg 双模式:** 新结构化数据模型 (`TurnItem`) 同时保持遗留事件兼容
10. **MCP 工具命名空间:** `server__tool` 模式避免 MCP 工具冲突

### 11.2 认证流对比

| 认证模式 | 存储 | 刷新 | 适用场景 |
|---------|------|------|---------|
| API Key | 环境变量/文件 | 手动替换 | 开发者、自动化 |
| ChatGPT OAuth | AuthDotJson 文件 | 自动刷新 | 终端用户 |
| ChatGPT Auth Tokens | 仅内存 | 外部应用负责 | VS Code 等宿主集成 |

### 11.3 安全沙盒层次

```
                    ┌────────────────────────┐
                    │   DangerFullAccess      │ 完全无限制
                    ├────────────────────────┤
                    │   ExternalSandbox       │ 外部沙盒，读写+可控网络
                    ├────────────────────────┤
                    │   WorkspaceWrite        │ CWD可写+可配置读写根
                    ├────────────────────────┤
                    │   ReadOnly              │ 只读文件系统
                    └────────────────────────┘
```

每层都维护 `WritableRoot` 列表及只读子路径（如 `.git`、`.codex`），确保即使在可写工作区中代理也不能修改关键元数据。

---

*文档完毕。涵盖 7 个 crate 的协议与通信层深度分析。*