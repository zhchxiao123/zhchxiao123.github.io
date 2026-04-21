---
title: "Step 8: 测试体系"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/08-testing-infrastructure/
---
# Codex CLI 测试基础设施深度分析

## 1. 测试分层架构概览

Codex CLI 项目采用典型的三层测试架构：

| 层级 | 位置 | 工具/框架 | 说明 |
|------|------|-----------|------|
| **单元测试** | `src/**/*_tests.rs` + `#[cfg(test)] mod tests` | Rust 内置 `#[test]` | 模块内私有函数测试 |
| **集成测试** | `tests/all.rs` → `tests/suite/*.rs` + `tests/common/` | wiremock + tokio + insta | 核心 crate 级别功能验证 |
| **E2E/系统测试** | `app-server-test-client`、PTY 测试 | 进程启动 + JSON-RPC/WebSocket | 完整用户场景验证 |

## 2. 核心测试支持工具 (`core_test_support`)

### 2.1 Crate 结构

核心测试基础设施位于 `codex-rs/core/tests/common/`，通过 `Cargo.toml` 编译为 `codex-test-support`（即 `core_test_support`）crate。模块包括：

```
core/tests/common/
├── lib.rs                 # 公共 re-export、全局初始化、辅助宏
├── test_codex.rs          # TestCodex/TestCodexHarness/TestCodexBuilder
├── test_codex_exec.rs     # exec 模式的测试实例创建
├── responses.rs           # HTTP Mock 响应构建（SSE/JSON/WebSocket）
├── streaming_sse.rs       # 流式 SSE 服务器模拟
├── context_snapshot.rs     # 请求上下文快照格式化
├── process.rs             # 进程存活/退出检测
├── zsh_fork.rs            # Zsh fork 模式专用测试 runtime
├── tracing.rs             # OpenTelemetry 测试 tracing 安装
└── apps_test_server.rs     # ChatGPT Apps 连接器 Mock 服务器
```

### 2.2 全局初始化（`ctor`）

`lib.rs` 通过 `#[ctor]` 属性在测试进程启动时执行三个关键初始化：

1. **确定性进程 ID**：`set_thread_manager_test_mode(true)` + `set_deterministic_process_ids(true)`，确保 `unified_exec` 进程 ID 可预测。
2. **Arg0 调度**：`arg0_dispatch()` 配置二进制分发机制，支持测试进程以 `codex`/`codex-exec` 等不同 argv[0] 运行。
3. **Insta workspace root**：自动设置 `INSTA_WORKSPACE_ROOT`，确保 snapshot 文件写入正确位置。

### 2.3 环境判断宏

项目定义了多个条件跳过宏，适配不同测试环境：

| 宏 | 用途 |
|----|------|
| `skip_if_sandbox!()` | 在 Seatbelt 沙箱内跳过（macOS 限制） |
| `skip_if_no_network!()` | 在禁用网络的沙箱内跳过 |
| `skip_if_remote!()` | 在远程执行环境中跳过 |
| `codex_linux_sandbox_exe_or_skip!()` | 找不到 Linux 沙箱二进制时跳过 |
| `skip_if_windows!()` | Windows 不兼容时跳过 |

### 2.4 配置管理

`load_default_config_for_test()` 创建隔离的临时 `codex_home` 目录，确保测试不污染用户真实配置。Linux 上还自动查找 `codex-linux-sandbox` 二进制。

### 2.5 文件系统等待工具 (`fs_wait`)

异步等待文件出现或匹配特定条件的文件：
- `wait_for_path_exists()`：使用 `notify` crate 监听文件系统事件，而非轮询
- `wait_for_matching_file()`：递归扫描目录查找匹配文件

## 3. Mock Server 模式详解

### 3.1 WireMock (`responses.rs`)

核心 Mock 框架基于 `wiremock` crate，提供 HTTP 级别的完整请求/响应模拟。

#### 关键数据结构

```
ResponseMock              # 捕获所有 POST /v1/responses 请求
├── single_request()      # 断言恰好收到 1 个请求
├── requests()            # 获取所有请求
├── last_request()        # 获取最后一个请求
├── saw_function_call()   # 查找指定 call_id 的 function_call
└── function_call_output_text()  # 提取 function_call_output 的 output 文本

ResponsesRequest          # 封装 wiremock::Request
├── body_json()            # 解析 JSON 请求体（支持 zstd 解压）
├── input()                # 获取 input 数组
├── inputs_of_type()      # 按类型过滤 input 条目
├── function_call_output() # 按 call_id 提取 function_call_output
├── custom_tool_call_output() # 提取 custom_tool_call_output
├── tool_search_output()  # 提取 tool_search_output
├── message_input_texts() # 提取用户/助手消息文本
├── instructions_text()   # 获取 instructions 字段
├── header()/path()/query_param() # 请求元信息
└── call_output()          # 通用 call_output 提取

WebSocketTestServer        # WebSocket 测试服务器
├── connections()           # 所有连接的请求日志
├── single_connection()    # 单连接断言
├── wait_for_request()     # 异步等待特定请求
├── wait_for_handshakes()  # 等待指定数量的握手完成
├── single_handshake()     # 单握手断言
└── shutdown()             # 优雅关闭
```

#### SSE 事件构建器

`responses.rs` 提供了丰富的 SSE 事件构建函数：

| 函数 | 用途 |
|------|------|
| `sse(events)` | 从 JSON 事件数组构建 SSE 流文本 |
| `ev_response_created(id)` | `response.created` 事件 |
| `ev_completed(id)` | `response.completed` 事件 |
| `ev_completed_with_tokens(id, n)` | 带令牌计数的完成事件 |
| `ev_assistant_message(id, text)` | 助手文本消息事件 |
| `ev_function_call(call_id, name, args)` | 函数调用事件 |
| `ev_custom_tool_call(call_id, name, input)` | 自定义工具调用事件 |
| `ev_local_shell_call(call_id, status, cmd)` | 本地 Shell 调用事件 |
| `ev_apply_patch_call(call_id, patch, type)` | Apply Patch 调用（5 种输出模式） |
| `ev_reasoning_item(id, summary, raw)` | 推理事件 |
| `ev_web_search_call_*` | Web 搜索调用事件 |
| `ev_image_generation_call()` | 图像生成事件 |
| `sse_failed(id, code, msg)` | 失败响应 |

#### Mount 模式

| 函数 | 说明 |
|------|------|
| `mount_sse_once(server, body)` | 挂载单次 SSE 响应 |
| `mount_sse_once_match(server, matcher, body)` | 带匹配器的单次 SSE |
| `mount_sse_sequence(server, bodies)` | 有序序列响应 |
| `mount_response_once(server, response)` | 单次 JSON 响应 |
| `mount_response_sequence(server, responses)` | JSON 响应序列 |
| `mount_models_once(server, body)` | /v1/models 响应 |
| `mount_function_call_agent_response()` | 函数调用→完成两步响应 |
| `mount_compact_*` | 上下文压缩 Mock |
| `start_mock_server()` | 启动带默认 /models 的 Mock 服务器 |

#### 请求体不变量验证

`validate_request_body_invariants()` 在每次 Mock 匹配时自动验证：
- `function_call_output`/`custom_tool_call_output` 必须有非空 `call_id`
- `tool_search_output` 必须有 `call_id`（server-executed legacy 除外）
- `function_call_output` 必须匹配先前的 `function_call`/`local_shell_call`
- `custom_tool_call_output` 必须匹配先前的 `custom_tool_call`
- `tool_search_output` 必须匹配先前的 `tool_search_call`
- 对称性：每个 `function_call`/`custom_tool_call`/`tool_search_call` 都应有对应 output

### 3.2 流式 SSE 服务器 (`streaming_sse.rs`)

`StreamingSseServer` 是一个手工编写的轻量 HTTP 服务器，支持：

- **分块信号门控**：每个 `StreamingSseChunk` 可选包含 `gate: Option<oneshot::Receiver<()>>`，测试可以在指定时机释放下一个数据块
- **多响应队列**：FIFO 顺序服务于多个 POST `/v1/responses` 请求
- **完成时间戳**：每个响应完成后发送完成通知
- **GET /v1/models**：内置空模型列表响应
- **请求体捕获**：记录所有 POST body 供断言

关键特性：

```rust
pub struct StreamingSseChunk {
    pub gate: Option<oneshot::Receiver<()>>,  // 可选门控
    pub body: String,                          // SSE 文本块
}
```

这使得测试能够精确控制 SSE 流的时序，验证竞态条件、背压、超时等复杂场景。

### 3.3 WebSocket 测试服务器 (`WebSocketTestServer`)

支持实时 WebSocket 通信测试：

- 多连接管理，每连接维护独立的请求日志
- 握手头捕获（含自定义响应头）
- 连接 accept 延迟（测试 warmup 路径）
- 可选 close-after-requests 控制
- `wait_for_request()` / `wait_for_handshakes()` 异步等待
- 支持 permessage-deflate 压缩扩展

### 3.4 Apps 测试服务器 (`apps_test_server.rs`)

专门模拟 ChatGPT Connectors（OAuth、JSON-RPC、searchable tools），用于 Apps/MCP 集成测试。

## 4. TestCodex 构建器模式

`TestCodexBuilder` 采用 Builder 模式创建完全隔离的测试实例：

```rust
// 典型使用模式
let server = start_mock_server().await;
let mut builder = test_codex();
let test = builder
    .with_config(|config| { config.model = Some("test-model".into()); })
    .with_workspace_setup(|cwd, fs| {
        // 异步设置工作区文件
        Box::pin(async move { fs.write_file(&cwd.join("test.txt"), data).await })
    })
    .build(&server)
    .await?;
```

### TestCodexBuilder 配置能力

| 方法 | 用途 |
|------|------|
| `with_config(mutator)` | 自定义 `Config` 修改 |
| `with_auth(auth)` | 自定义认证 |
| `with_model(model)` | 指定模型名称 |
| `with_pre_build_hook(hook)` | Config 构建前回调 |
| `with_workspace_setup(setup)` | 异步工作区文件设置 |
| `with_home(home)` | 自定义 home 目录 |
| `with_user_shell(shell)` | 覆盖用户 Shell |
| `build(&server)` | 构建本地测试实例 |
| `build_remote_aware(&server)` | 构建远程感知实例 |
| `build_with_streaming_server(&server)` | 使用 StreamingSseServer |
| `build_with_websocket_server(&server)` | 使用 WebSocket 服务器 |
| `resume(&server, home, rollout_path)` | 从 rollout 恢复 |

### TestCodex 实例核心功能

```rust
pub struct TestCodex {
    pub home: Arc<TempDir>,           // 隔离的 home 目录
    pub cwd: Arc<TempDir>,            // 隔离的工作目录
    pub codex: Arc<CodexThread>,      // 核心 Codex 线程
    pub session_configured: SessionConfiguredEvent,
    pub config: Config,
    pub thread_manager: Arc<ThreadManager>,
    _test_env: TestEnv,              // 执行环境（本地/远程）
}
```

- `submit_turn(prompt)`：提交用户会话并等待 `TurnComplete`
- `submit_turn_with_policy(prompt, sandbox_policy)`：带沙箱策略提交
- `request_bodies()`：获取所有发送到 Mock 服务器的请求体

### TestCodexHarness

更高层级的封装，组合了 MockServer + TestCodex：

```rust
pub struct TestCodexHarness {
    server: MockServer,
    test: TestCodex,
}
```

提供：`write_file()`, `read_file_text()`, `create_dir_all()`, `path_exists()`, `submit()`, `request_bodies()`, `function_call_output_value()` 等便捷方法。

## 5. 上下文快照系统 (`context_snapshot.rs`)

为测试断言提供了结构化的请求上下文格式化工具，主要用于验证 API 请求的内容正确性。

### 渲染模式

| 模式 | 说明 |
|------|------|
| `RedactedText` | 默认，敏感内容用占位符替换 |
| `FullText` | 完整文本（保留换行规范化） |
| `KindOnly` | 仅显示类型（`00:message/user`） |
| `KindWithTextPrefix { max_chars }` | 类型 + 截断文本前缀 |

### 动态路径规范化

`canonicalize_snapshot_text()` 自动将以下动态内容替换为稳定占位符：

- `<permissions instructions>` → `<PERMISSIONS_INSTRUCTIONS>`
- `<apps_instructions>` → `<APPS_INSTRUCTIONS>`
- `<skills_instructions>` → `<SKILLS_INSTRUCTIONS>`
- `<plugins_instructions>` → `<PLUGINS_INSTRUCTIONS>`
- `# AGENTS.md instructions for ...` → `<AGENTS_MD>`
- `<environment_context>` → `<ENVIRONMENT_CONTEXT:cwd=<CWD>:subagents=N>`
- `You are performing a CONTEXT CHECKPOINT COMPACTION.` → `<SUMMARIZATION_PROMPT>`
- 系统技能路径：`/.system/*/SKILL.md` → `<SYSTEM_SKILLS_ROOT>/*/SKILL.md`

### 示例快照

```
00:message/developer:<PERMISSIONS_INSTRUCTIONS>
01:message/developer:<APPS_INSTRUCTIONS>
02:message/user:<ENVIRONMENT_CONTEXT:cwd=<CWD>>
03:function_call/shell
04:function_call_output:done
05:message/assistant:Here is the result
```

## 6. TUI 测试体系

### 6.1 VT100 Backend (`test_backend.rs`)

`VT100Backend` 是 TUI 测试的核心模拟层：

```rust
pub struct VT100Backend {
    crossterm_backend: CrosstermBackend<vt100::Parser>,
}
```

它将 `vt100::Parser` 作为 writer 传给 `CrosstermBackend`，实现：
- 不写入真实终端
- 通过 `vt100().screen().contents()` 获取渲染结果
- 支持光标位置查询
- 完整的 Backend trait 实现（draw, clear, append_lines 等）

### 6.2 测试结构

```
tui/tests/
├── all.rs                       # 入口：mod test_backend; mod suite;
├── test_backend.rs              # 重导出 src/test_backend.rs
├── fixtures/                    # 测试固件
└── suite/
    ├── mod.rs
    ├── model_availability_nux.rs
    ├── no_panic_on_startup.rs   # PTY 进程级 E2E 测试
    ├── status_indicator.rs
    ├── vt100_history.rs         # Snapshot 测试示例
    └── vt100_live_commit.rs
```

TUI 模块内单元测试：
- `src/markdown_render_tests.rs`
- `src/chatwidget/tests/status_command_tests.rs`

### 6.3 Snapshot 测试流程

1. 使用 `VT100Backend` 创建虚拟终端
2. 在虚拟终端上执行 UI 操作
3. 使用 `insta` 断言 `backend.vt100().screen().contents()` 快照
4. 快照存储在 `tui/tests/suite/snapshots/` 下
5. 更新流程：`cargo insta review -p codex-tui`

### 6.4 PTY 进程级测试

`no_panic_on_startup.rs` 展示了完整的 CLI 进程测试模式：
- 使用 `codex_utils_pty::spawn_pty_process()` 启动真实进程
- 通过 PTY 模拟终端交互
- 监听 `\x1b[6n`（光标位置查询）并回应 `\x1b[1;1R`
- 超时控制避免挂起

## 7. App Server 测试体系

### 7.1 结构

```
app-server/tests/
├── all.rs                       # 入口
├── common/
│   ├── lib.rs                   # re-export core_test_support + 自有工具
│   ├── analytics_server.rs      # 分析事件 Mock 服务器
│   ├── auth_fixtures.rs         # ChatGPT 认证固件
│   ├── config.rs                # 测试配置生成
│   ├── mcp_process.rs           # MCP 进程管理
│   ├── mock_model_server.rs     # Mock 模型服务器创建
│   ├── models_cache.rs          # 模型缓存写入
│   ├── responses.rs             # App Server 专用 SSE 响应构建
│   └── rollout.rs               # 假 rollout 文件创建
└── suite/
    ├── mod.rs
    ├── auth.rs
    ├── conversation_summary.rs
    ├── fuzzy_file_search.rs
    └── v2/                       # v2 协议测试
```

### 7.2 App Server Test Client

`codex-app-server-test-client` 是独立的 CLI 工具，通过 JSON-RPC 与 App Server 交互：

- 启动 `codex` 二进制作为子进程
- 通过 stdio 建立 JSON-RPC 连接
- 实现完整的 v2 协议交互（initialize, thread/start, thread/send-message, approval 等）
- 支持 WebSocket 升级

### 7.3 App Server 公共测试工具

```
app-server/tests/common/ 提供：
├── create_mock_responses_server_*   # SSE Mock 服务器工厂
├── create_*_sse_response           # 预构建 SSE 响应
├── create_fake_rollout*             # 假 rollout JSONL 文件
├── write_mock_responses_config_toml # 测试配置文件
├── write_models_cache*             # 模型缓存
├── ChatGptAuthFixture               # ChatGPT 认证固件
└── to_response<T>()                # JSONRPCResponse → T 反序列化
```

## 8. 其他 Crate 测试

### 8.1 exec Crate (`codex-rs/exec/tests/`)

```
exec/tests/
├── all.rs
├── event_processor_with_json_output.rs
└── suite/
    ├── mod.rs
    ├── apply_patch.rs
    ├── auth_env.rs
    ├── ephemeral.rs
    ├── mcp_required_exit.rs
    ├── originator.rs
    ├── output_schema.rs
    ├── prompt_stdin.rs
    ├── resume.rs
    ├── sandbox.rs
    ├── server_error_exit.rs
    └── add_dir.rs
```

特点：
- 进程级 E2E 测试，通过 `codex_utils_cargo_bin::cargo_bin()` 定位二进制
- 使用 `codex_utils_pty::spawn_pty_process()` 启动进程并交互
- 验证退出码、输出内容、环境变量传递等

### 8.2 Sandboxing 测试

沙箱测试分散在核心集成测试中的 `#[cfg(target_os = "linux")]` 条件编译块，以及 `exec/tests/suite/sandbox.rs` 中。

### 8.3 单元测试模式

各 crate 内部的 `#[cfg(test)] mod tests` 和 `*_tests.rs` 文件：
- `tui/src/markdown_render_tests.rs` — Markdown 渲染快照测试
- `tui/src/chatwidget/tests/status_command_tests.rs` — 状态命令测试
- `core/src/test_support.rs` — 暴露给集成测试的生产代码辅助

## 9. 测试工具与约定

### 9.1 Justfile 命令

| 命令 | 用途 |
|------|------|
| `just test` | `cargo nextest run --no-fail-fast` |
| `just fmt` | `cargo fmt -- --config imports_granularity=Item` |
| `just fix [args]` | `cargo clippy --fix --tests --allow-dirty` |
| `just clippy [args]` | `cargo clippy --tests` |
| `just write-config-schema` | 重新生成 config JSON schema |
| `just write-app-server-schema` | 重新生成 app-server 协议 schema |
| `just bazel-test` | Bazel 运行测试（排除 argument-comment-lint） |
| `just bazel-argument-comment-lint` | 参数注释 lint |

### 9.2 Insta Snapshot 测试流程

1. 编写使用 `insta::assert_snapshot!` 或 `insta::assert_debug_snapshot!` 的测试
2. 运行 `cargo test -p <crate>` 生成 `.snap.new` 文件
3. 查看：`cargo insta pending-snapshots -p <crate>`
4. 审查特定文件：`cargo insta show -p <crate> path/to/file.snap.new`
5. 接受所有：`cargo insta accept -p <crate>`

### 9.3 Argument Comment Lint

遵循 `argument_comment_lint` 约定：对不透明的位置参数使用 `/*param_name*/` 注释：

```rust
// 好：
config.features.enable(/*enabled*/ true)?;
// 差：
config.features.enable(true)?;
```

运行：`just argument-comment-lint` 或 Bazel CI。

### 9.4 `codex_utils_cargo_bin`

提供 `cargo_bin("binary_name")` 在 Cargo 和 Bazel 环境下统一解析二进制路径：
- 在 Cargo 中：从 `CARGO_BIN_EXE_*` 环境变量推导
- 在 Bazel 中：使用 runfiles 解析

### 9.5 `codex_utils_absolute_path::test_support`

路径测试辅助：
- `PathBufExt::abs()` — 转换为 `AbsolutePathBuf`
- `test_path_buf(unix_path)` — 跨平台路径
- `test_absolute_path(unix_path)` — 跨平台绝对路径

### 9.6 测试断言约定

- 使用 `pretty_assertions::assert_eq` 以获得更清晰的 diff
- 优先对比整个对象而非逐字段
- 避免在测试中修改进程环境变量

### 9.7 平台条件编译

- `#[cfg(target_os = "linux")]`：Linux 沙箱测试
- `#[cfg(target_os = "macos")]`：Seatbelt 测试
- `#[cfg(not(target_os = "windows"))]`：Unix-only 功能测试
- 运行时检查：`skip_if_sandbox!()` / `skip_if_no_network!()` / `skip_if_windows!()`
- 环境变量：`CODEX_SANDBOX=seatbelt` 和 `CODEX_SANDBOX_NETWORK_DISABLED=1` 自动跳过不可运行测试

### 9.8 测试文件组织约定

- 单一二进制入口：所有测试模块聚合到 `tests/all.rs`，子模块在 `tests/all/` 或 `tests/suite/`
- 测试支持代码在 `tests/common/` crate 中
- 二进制分发：`tests/all.rs` 的 `#[ctor]` 设置 `arg0_dispatch()`，使测试二进制可作为多个子命令运行（如 apply_patch, linux-sandbox）

## 10. 核心集成测试场景覆盖

### 10.1 测试套件模块清单（core/tests/suite/，85 个模块）

| 类别 | 模块 | 说明 |
|------|------|------|
| **执行** | `exec`, `unified_exec`, `shell_command`, `shell_serialization`, `exec_policy`, `user_shell_cmd` | Shell 命令执行、沙箱策略 |
| **工具** | `tools`, `tool_harness`, `tool_parallelism`, `tool_suggest`, `search_tool`, `openai_file_mcp` | 工具调用、MCP 集成 |
| **客户端/API** | `client`, `cli_stream`, `responses_api_proxy_headers`, `request_compression` | API 客户端、流式响应、压缩 |
| **审查** | `review`, `apply_patch_cli` | 代码审查和 patch 应用 |
| **上下文压缩** | `compact`, `compact_remote`, `compact_resume_fork` | 上下文窗口管理 |
| **恢复** | `resume`, `resume_warning`, `rollout_list_find` | 会话恢复 |
| **Agent** | `agent_jobs`, `fork_thread`, `hierarchical_agents`, `spawn_agent_description`, `codex_delegate`, `subagent_notifications` | 多 Agent 架构 |
| **功能** | `skills`, `plugins`, `web_search`, `image_rollout`, `view_image`, `memories`, `items`, `truncation`, `undo`, `safety_check_downgrade`, `deprecation_notice`, `unstable_features_warning` | 功能特性 |
| **模型** | `model_overrides`, `model_switching`, `model_visible_layout`, `models_cache_ttl`, `models_etag_responses`, `remote_models` | 模型管理 |
| **WebSocket** | `agent_websocket`, `client_websockets`, `realtime_conversation`, `websocket_fallback` | WebSocket 传输 |
| **其他** | `approvals`, `hooks`, `live_cli`, `live_reload`, `pending_input`, `personality`, `personality_migration`, `quota_exceeded`, `stream_error_allows_next_turn`, `stream_no_completed`, `turn_state`, `js_repl`, `json_result`, `otel` | 杂项 |

### 10.2 异步测试策略

几乎所有集成测试使用 `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`，因为：

- `CodexThread` 内部使用 tokio 运行时
- 多线程 flavor 支持阻塞操作（如进程启动）
- 2 个 worker threads 足以处理并发 I/O

### 10.3 Mock 数据模式

典型测试遵循以下模式：

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_name() -> Result<()> {
    skip_if_no_network!(Ok(()));           // 条件跳过
    
    let server = start_mock_server().await;  // 1. 启动 Mock 服务器
    let mut builder = test_codex();          // 2. 创建 Builder
    let test = builder.build(&server).await?; // 3. 构建测试实例
    
    mount_sse_once(&server, sse(vec![        // 4. 挂载第一轮响应
        ev_response_created("resp-1"),
        ev_function_call("call-1", "shell", &args),
        ev_completed("resp-1"),
    ])).await;
    
    mount_sse_once(&server, sse(vec![        // 5. 挂载第二轮响应
        ev_assistant_message("msg-1", "done"),
        ev_completed("resp-2"),
    ])).await;
    
    codex.submit(Op::UserTurn { ... }).await?;  // 6. 提交操作
    let event = wait_for_event(&codex, |ev| ...).await; // 7. 等待事件
    
    // 8. 断言
    assert_eq!(event, expected);
    let request = mock.single_request();
    assert_eq!(request.function_call_output("call-1")....);
    
    Ok(())
}
```

### 10.4 请求断言模式

`ResponsesRequest` 提供了丰富的结构化断言方法：

```rust
let request = mock.single_request();
// 按 call_id 查找
request.function_call_output("call-1");
request.custom_tool_call_output("call-2");
// 按 type 过滤 input
request.inputs_of_type("message");
// 提取文本
request.message_input_texts("user");
// 混合断言
request.has_message_with_input_texts("user", |texts| texts.len() > 1);
```

## 11. 测试覆盖的典型场景

### 11.1 完整对话流

1. 用户发送文本 → Mock 返回 function_call → Codex 执行工具 → Mock 返回助手消息
2. 验证请求体包含正确的 input 序列（用户消息 + function_call_output + function_call）

### 11.2 上下文压缩

1. 发起多轮对话触发自动压缩
2. 验证压缩请求包含正确的 summary
3. 验证压缩后上下文正确恢复

### 11.3 会话恢复

1. 创建会话并产生 rollout 文件
2. 使用 `TestCodexBuilder::resume()` 恢复
3. 验证恢复后 `initial_messages` 正确

### 11.4 WebSocket 实时对话

1. 使用 `WebSocketTestServer` 创建 WebSocket 连接
2. 验证实时消息收发
3. 测试连接断开/重连场景

### 11.5 流式 SSE 时序控制

1. 使用 `StreamingSseServer` + `StreamingSseChunk { gate, body }` 门控
2. 精确控制每个数据块的发送时机
3. 验证竞态条件下的行为

### 11.6 远程执行环境

1. 设置 `CODEX_TEST_REMOTE_ENV` 环境变量
2. `TestCodexBuilder::build_remote_aware()` 自动检测
3. 通过 Docker 容器验证文件操作

### 11.7 多 Agent 并行

1. `agent_jobs.rs` 中使用 `AgentJobsResponder` 自定义 Mock 响应
2. 验证子 Agent 的 spawn/join 语义
3. 验证并行 Agent 的请求隔离性