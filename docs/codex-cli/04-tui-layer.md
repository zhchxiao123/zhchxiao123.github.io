---
title: "Step 4: TUI 交互层"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/04-tui-layer/
---
# OpenAI Codex CLI — TUI 交互层深度分析

> 分析范围：`codex-rs/tui` crate  
> 生成日期：2026-04-21

---

## 1. TUI 入口与初始化

### 1.1 程序入口 (`main.rs`)

`main.rs` 是极简入口：

- 定义 `TopCli`（组合 `Cli` + `CliConfigOverrides`），通过 `clap::Parser` 解析命令行。
- 调用 `run_main(cli, arg0_paths, LoaderOverrides::default(), None, None)` 启动异步主逻辑。
- 退出时根据 `AppExitInfo.exit_reason` 区分 `Fatal(message)` 与 `UserRequested`，并输出 token 用量摘要和 resume 命令提示。

### 1.2 CLI 参数 (`cli.rs`)

`Cli` 结构体承载所有 TUI 专属参数：

| 字段 | 用途 |
|------|------|
| `prompt: Option<String>` | 初始用户提示 |
| `resume_picker / resume_last / resume_session_id` | 会话恢复子命令参数 |
| `fork_picker / fork_last / fork_session_id` | 会话分支子命令参数 |
| `shared: TuiSharedCliOptions` | 委托给 `SharedCliOptions`（model、images 等） |
| `approval_policy` | 审批策略 |
| `web_search` | 启用网络搜索 |
| `no_alt_screen` | 禁用交替屏幕模式 |

`TuiSharedCliOptions` 是 `SharedCliOptions` 的 newtype wrapper，重写了 `augment_args` 以添加 `--dangerously-bypass-approvals-and-sandbox` 与 `--ask-for-approval` 的互斥约束。

### 1.3 库入口与启动流程 (`lib.rs`)

`run_main()` 是 TUI 的核心编排函数，执行以下步骤：

1. **配置加载**：解析 CLI config overrides → 加载 `config.toml` → 构建 `Config` 对象。
2. **App Server 连接**：根据 `AppServerTarget`（`Embedded` 或 `Remote`）启动嵌入式 in-process app-server 或连接远程 WebSocket。
3. **Onboarding**：根据 `should_show_onboarding()` 判断是否需要登录/信任屏幕。
4. **会话选择**：解析 `--resume`/`--fork` 参数，通过 `resume_picker` UI 选择历史会话。
5. **配置重载**：CWD 变更后重载 config。
6. **App::run()**：启动主事件循环。

关键数据结构 `AppServerTarget`：
```rust
enum AppServerTarget {
    Embedded,
    Remote { websocket_url: String, auth_token: Option<String> },
}
```

### 1.4 Tui 核心结构 (`tui.rs`)

`Tui` struct 封装终端状态，是渲染和事件的基础设施：

```rust
pub struct Tui {
    frame_requester: FrameRequester,
    draw_tx: broadcast::Sender<()>,
    event_broker: Arc<EventBroker>,
    pub terminal: Terminal,
    pending_history_lines: Vec<Line<'static>>,
    alt_saved_viewport: Option<Rect>,
    alt_screen_active: Arc<AtomicBool>,
    terminal_focused: Arc<AtomicBool>,
    enhanced_keys_supported: bool,
    notification_backend: Option<DesktopNotificationBackend>,
    is_zellij: bool,
    alt_screen_enabled: bool,
}
```

**终端初始化/恢复**：
- `init()` → `set_modes()` 启用 raw mode + bracketed paste + keyboard enhancement + focus change 事件。
- `restore()` 关闭上述模式，恢复终端。
- `set_panic_hook()` 确保 panic 时恢复终端状态。
- `with_restored()` 用于运行外部交互程序（编辑器等），暂停事件流、离开 alt screen、恢复终端、执行外部程序、重新初始化。

**Alt Screen 管理**：
- `enter_alt_screen()` / `leave_alt_screen()` 切换交替屏幕，保存/恢复 viewport。
- `--no-alt-screen` 选项禁用 alt screen（Zellij 兼容）。

**绘制流程**：`draw()` 方法在 `sync_update` 闭包内处理 viewport 调整、历史行插入、最终 `terminal.draw()`。

### 1.5 事件流 (`event_stream.rs`)

**核心架构**：`EventBroker` + `TuiEventStream`

- `EventBroker<S: EventSource>` 持有 `Mutex<EventBrokerState<S>>`（`Paused` / `Start` / `Running(S)`）和 `watch::Sender` 用于 resume 通知。
- `TuiEventStream` 组合 `EventBroker`、`BroadcastStream<()>(draw_tx)`、`WatchStream<()>(resume_tx)` 以及 `terminal_focused` 和 `suspend_context`。
- `TuiEvent` 枚举：`Key(KeyEvent)`、`Paste(String)`、`Draw`。

**事件轮询**：`Stream::poll_next` 实现公平轮询 — 交替优先检查 draw 事件和 crossterm 事件，确保不会饥饿。暂停状态时轮询 resume watch channel。

**Pause/Resume**：`pause_events()` 将 broker 状态设为 `Paused`（丢弃底层 EventStream），`resume_events()` 设为 `Start` 并发送 watch 通知唤醒。

### 1.6 帧率限制 (`frame_rate_limiter.rs`)

- `MIN_FRAME_INTERVAL = ~8.33ms`（120 FPS）。
- `FrameRateLimiter::clamp_deadline()` 确保两次 draw 通知之间至少间隔 `MIN_FRAME_INTERVAL`。

### 1.7 帧请求 (`frame_requester.rs`)

**Actor 模式**：`FrameRequester`（handle）→ `mpsc::UnboundedSender<Instant>` → `FrameScheduler`（task）

- `schedule_frame()` — 立即绘制请求。
- `schedule_frame_in(duration)` — 延迟绘制请求。
- `FrameScheduler` 合并请求（取最早 deadline），到达 deadline 时通过 `draw_tx.send(())` 通知主循环。
- 帧率限制器确保不超过 120 FPS。

### 1.8 任务控制 (`job_control.rs`)

Unix 专属 `SuspendContext` 处理 Ctrl+Z (SIGTSTP)：

- `suspend()` 保存 resume 策略（`RealignInline` 或 `RestoreAlt`）、移动光标到当前行、调用 `suspend_process()`（恢复终端 → `libc::kill(0, SIGTSTP)` → 重新设置终端模式）。
- `prepare_resume_action()` 在恢复后计算 viewport 调整。

---

## 2. App 状态机

### 2.1 App 核心 (`app.rs`)

`App` 是顶层状态容器（约 70+ 字段），关键领域：

```rust
pub(crate) struct App {
    chat_widget: ChatWidget,
    config: Config,
    overlay: Option<Overlay>,
    transcript_cells: Vec<Arc<dyn HistoryCell>>,
    commit_anim_running: Arc<AtomicBool>,
    thread_event_channels: HashMap<ThreadId, ThreadEventChannel>,
    side_threads: HashMap<ThreadId, SideThreadState>,
    active_thread_id: Option<ThreadId>,
    primary_thread_id: Option<ThreadId>,
    file_search: FileSearchManager,
    pending_app_server_requests: PendingAppServerRequests,
    // ... 更多
}
```

**`App::run()`** 是主事件循环：
```rust
loop {
    tokio::select! {
        event = event_stream.next() => { ... }  // 键盘/绘制事件
        event = app_event_rx.recv() => { ... }  // AppEvent
        buffered = active_thread_rx.recv() => { ... }  // 线程事件
    }
    app.draw(tui, height)?;
}
```

**`AppRunControl`** 控制循环退出：
```rust
enum AppRunControl { Continue, Exit(ExitReason) }
```

### 2.2 AppEvent (`app_event.rs`)

`AppEvent` 是 TUI 内部消息总线，约 100+ 变体：

| 分类 | 典型事件 | 说明 |
|------|---------|------|
| **会话管理** | `NewSession`, `ClearUi`, `ForkCurrentSession`, `Exit(ExitMode)` | 会话创建/切换/退出 |
| **流式控制** | `CodexOp(Op)`, `SubmitThreadOp` | 向 agent 发送操作 |
| **文件搜索** | `StartFileSearch`, `FileSearchResult` | 异步文件搜索 |
| **速率限制** | `RefreshRateLimits`, `RateLimitsLoaded` | 后台刷新速率限制 |
| **线程路由** | `SelectAgentThread`, `OpenAgentPicker`, `StartSide` | 多 agent 导航 |
| **插件** | `FetchPluginsList`, `PluginInstallLoaded` 等 | 插件市场 CRUD |
| **MCP** | `FetchMcpInventory`, `McpInventoryLoaded` | MCP 服务器清单 |
| **配置持久化** | `PersistModelSelection`, `PersistPersonalitySelection` | 写入 config.toml |
| **UI 弹窗** | `OpenReasoningPopup`, `OpenApprovalsPopup` | 弹窗触发 |
| **实时音频** | `RealtimeWebrtcOfferCreated`, `RealtimeWebrtcEvent` | 语音模式 |
| **动画** | `StartCommitAnimation`, `CommitTick`, `StopCommitAnimation` | 流式逐行动画 |

`ExitMode`：`ShutdownFirst`（优雅关机）vs `Immediate`（跳过 shutdown）。

### 2.3 AppCommand (`app_command.rs`)

`AppCommand` 是对 `Op` 的类型安全包装，提供 `view()` 方法返回 `AppCommandView` 枚举用于模式匹配：

```rust
enum AppCommandView<'a> {
    Interrupt, CleanBackgroundTerminals,
    UserTurn { items, cwd, approval_policy, ... },
    ExecApproval { id, decision, ... },
    PatchApproval { id, decision },
    // ...
}
```

### 2.4 事件分发 (`event_dispatch.rs`)

`handle_event()` 是一个超大型 `match event` 分发器（1000+ 行），将每个 `AppEvent` 路由到对应的处理逻辑：
- 会话事件 → `start_fresh_session` / `resume_target_session` / `fork`
- UI 事件 → `chat_widget.open_*` / `chat_widget.on_*`
- 持久化事件 → `ConfigEditsBuilder` 异步写配置
- 异步结果事件 → 更新 `chat_widget` 状态

### 2.5 线程路由 (`thread_routing.rs`)

多 agent 线程管理：
- `ThreadEventChannel` = 每个 `ThreadId` 对应一个 `mpsc::Receiver<ThreadBufferedEvent>`
- `side_threads` 跟踪侧对话线程
- `agent_navigation` 维护线程列表用于 agent picker

### 2.6 输入处理 (`input.rs`)

`handle_key_event()` 处理全局快捷键：
- `Alt+Left/Right`（空输入时）→ 切换 agent 线程
- `Ctrl+L` → 清屏
- Escape → 中断 / 关闭 popup
- 其他 → 委托给 `chat_widget.handle_key_event()`

### 2.7 配置持久化 (`config_persistence.rs`)

使用 `ConfigEditsBuilder` 构建 TOML 编辑，通过 `apply()` 异步写入磁盘：
- model / reasoning effort / personality / service tier / approvals / sandbox / memory / features 等。

---

## 3. ChatWidget 渲染

### 3.1 核心组件 (`chatwidget.rs`)

`ChatWidget` 是主聊天区域（11,000+ 行），是 TUI 最核心的渲染组件。关键职责：

- **流式消息渲染**：管理 `active_cell`（`Option<Box<dyn HistoryCell>>`），流式接收 delta 并增量渲染。
- **历史记录管理**：`transcript_cells` 是已提交的 `Arc<dyn HistoryCell>` 列表。
- **事件接收**：通过 `ThreadEventChannel` 接收 app-server 推送的通知。
- **Bottom Pane 控制**：持有 `BottomPane` 实例来管理输入区域、状态栏和各种弹窗。

**流式渲染模型**：
- 接收 `AgentMessageDeltaEvent` → 追加到 `StreamController` → 换行时提交到队列
- `CommitTick` 事件触发逐行动画（smooth mode 1行/帧，catch-up mode 全部排空）
- 流结束后 finalize → 生成 `HistoryCell`

### 3.2 Plan 实现 (`plan_implementation.rs`)

Plan 模式 UI：管理 `PlanStreamController`，处理计划步骤的创建/更新/删除事件，渲染计划步骤列表和状态指示器。

### 3.3 插件 (`plugins.rs`)

插件市场 UI：加载/安装/卸载插件的弹窗和状态管理。

### 3.4 实时语音 (`realtime.rs`)

WebRTC 实时语音模式：
- `VoiceCapture` — 麦克风采集
- `RealtimeWebrtcSessionHandle` — Peer connection 管理
- `RecordingMeterState` — 录音电平可视化（`⠤⠤⠤⠤` ASCII meter）
- 设备选择器弹窗

### 3.5 侧边栏 (`side.rs`)

`SideThreadState` / `SideParentStatus` 管理分支对话的 UI 路由。

### 3.6 技能 (`skills.rs`)

技能列表和启用/禁用管理。

### 3.7 Slash 命令 (`slash_dispatch.rs`)

`/slash` 命令的注册与分发。定义可用命令列表，解析用户输入并路由到对应处理逻辑。

### 3.8 会话头部 (`session_header.rs`)

会话信息显示（线程名、模型、token 用量等）。

### 3.9 状态显示 (`status_surfaces.rs`)

状态栏/状态行渲染：模型、reasoning effort、token 用量、速率限制等。

### 3.10 中断处理 (`interrupts.rs`)

用户中断（Ctrl+C）和超时的 UI 处理。

---

## 4. BottomPane 组件系统

### 4.1 模块结构 (`bottom_pane/mod.rs`)

`BottomPane` 管理底部交互区域的视图堆叠：

```rust
pub(crate) struct BottomPane {
    chat_composer: ChatComposer,
    view_stack: Vec<Box<dyn BottomPaneView>>,
    // ...
}
```

核心概念：
- **ChatComposer**：始终存在的文本输入区
- **BottomPaneView**：临时视图接口（弹窗），堆叠在 composer 之上
- **输入路由**：`BottomPane::handle_key_event()` 先给最顶层 view，然后给 composer

### 4.2 ChatComposer (`chat_composer.rs`)

8800+ 行的庞大状态机，是最复杂的组件：

**核心职责**：
- 文本编辑（TextArea）+ 附件管理（本地/远程图片）
- Slash 命令检测与弹窗联动
- `@` 提及（文件搜索、插件、技能）
- Enter 提交 vs Shift+Enter 换行
- Tab 排队（任务运行时排队，空闲时直提交）
- 粘贴处理（bracketed paste + 平台回退）
- 历史导航（↑/↓，Ctrl+R 搜索）

**Paste Burst 状态机**：
- 检测快速连续 paste 事件 → 合并为批量粘贴
- 防止终端 paste 被误判为多次独立输入

### 4.3 Footer (`footer.rs`)

底部状态栏，显示：
- 模型名称 + reasoning effort
- Token 用量
- 速率限制指示器
- 快捷键提示
- Collaboration mode 指示器

### 4.4 审批覆盖层 (`approval_overlay.rs`)

`ApprovalOverlay` 处理命令执行和文件变更的审批流程（approve/deny/for-session）。

### 4.5 其他弹窗

| 组件 | 文件 | 职责 |
|------|------|------|
| Slash 命令 | `slash_commands.rs` | `/` 命令选择弹窗 |
| 技能选择 | `skill_popup.rs` | 技能启用/禁用 |
| 命令弹窗 | `command_popup.rs` | 通用选择列表 |
| 文件搜索 | `file_search_popup.rs` | `@` 文件搜索 |
| MCP 请求 | `mcp_server_elicitation.rs` | MCP 服务器表单请求 |
| Memory 设置 | `memories_settings_view.rs` | Memory 开关 |
| 文本编辑 | `textarea.rs` | 自定义 TextArea（基于 ratatui textarea） |
| 滚动状态 | `scroll_state.rs` | 弹窗滚动偏移管理 |

### 4.6 视图容器 (`bottom_pane_view.rs`)

`BottomPaneView` trait 定义弹窗视图接口：
```rust
trait BottomPaneView {
    fn handle_key_event(&mut self, ...) -> Option<ViewCompletion>;
    fn render(&mut self, area: Rect, buf: &mut Buffer);
    fn desired_height(&self, width: u16) -> u16;
}
```

---

## 5. Streaming 与渲染管线

### 5.1 流式模块架构 (`streaming/`)

```
streaming/
├── mod.rs          — StreamState 核心数据结构
├── controller.rs   — StreamController / PlanStreamController
├── chunking.rs     — AdaptiveChunkingPolicy 两档策略
└── commit_tick.rs  — run_commit_tick() 桥接
```

### 5.2 StreamState (`streaming/mod.rs`)

```rust
struct StreamState {
    collector: MarkdownStreamCollector,
    queued_lines: VecDeque<QueuedLine>,  // 按 enqueue 时间排序
    has_seen_delta: bool,
}
```

- `collector` 管理 Markdown 流式解析
- `queued_lines` 是 FIFO 队列，每行附带 `enqueued_at: Instant` 时间戳
- `step()` → 弹出 1 行
- `drain_n(max)` → 弹出 N 行（用于 catch-up）
- `drain_all()` → 弹出全部
- `oldest_queued_age()` → 调度策略的输入

### 5.3 StreamController (`streaming/controller.rs`)

```rust
struct StreamController {
    state: StreamState,
    finishing_after_drain: bool,
    header_emitted: bool,
}
```

- `push(delta)` → 增量文本，遇到 `\n` 时提交完成行到队列
- `finalize()` → 结束流，生成 `HistoryCell`
- `on_commit_tick()` → 弹出 1 行，返回 `(Option<HistoryCell>, is_idle)`
- `on_commit_tick_batch(max)` → 弹出 N 行，用于 catch-up

### 5.4 两档分块策略 (`streaming/chunking.rs`)

`AdaptiveChunkingPolicy` 实现滞后切换：

| 模式 | 行为 | 进入条件 | 退出条件 |
|------|------|---------|---------|
| `Smooth` | 每帧 1 行 | 默认 | 队列深度 ≥ 8 或最老行 ≥ 120ms |
| `CatchUp` | 每帧排空全部 | 队列压力高 | 队列深度 ≤ 2 且最老行 ≤ 40ms |

滞后参数：
- `EXIT_HOLD = 80ms`：退出 catch-up 后保持一段时间
- `REENTER_CATCH_UP_HOLD = 200ms`：抑制立即重入
- `SEVERE_QUEUE_DEPTH_LINES = 100`：严重积压时立即重入

### 5.5 Commit Tick 桥接 (`streaming/commit_tick.rs`)

```rust
fn run_commit_tick(
    policy, stream_controller, plan_stream_controller, scope, now
) -> CommitTickOutput
```

1. 收集 `QueueSnapshot`（总深度 + 最老行年龄）
2. 调用 `resolve_chunking_plan()` 获取 `ChunkingDecision`
3. 根据 `DrainPlan` 应用到 controller
4. 返回 `CommitTickOutput { cells, has_controller, all_idle }`

`CommitTickScope::CatchUpOnly` 允许在 plan 流中仅 catch-up 模式才 commit。

### 5.6 Markdown 流式处理 (`markdown_stream.rs`)

`MarkdownStreamCollector`：
- 增量维护 `buffer: String`
- `push_delta(delta)` → 追加到 buffer
- `commit_complete_lines()` → 渲染到最新 `\n`，返回新增的已完成行
- `finalize_and_drain()` → 渲染全部，返回尾部行

关键设计：只在新行 (`\n`) 时提交渲染，避免中间状态闪烁。

### 5.7 Diff 渲染 (`diff_render.rs`)

2480+ 行的 diff 渲染器：
- 支持统一 diff 格式，显示行号、沟槽符号（+/-/空格）
- 语法高亮（使用 syntect）
- 主题感知：深色/浅色终端使用不同背景色
- 256 色和 16 色终端的降级调色板
- 行级别的硬换行

### 5.8 执行单元格 (`exec_cell/`)

`ExecCell` 模型：
```rust
struct ExecCell {
    calls: Vec<ExecCall>,
    animations_enabled: bool,
}
struct ExecCall {
    call_id: String,
    command: Vec<String>,
    parsed: Vec<ParsedCommand>,
    output: Option<CommandOutput>,
    start_time: Option<Instant>,
    duration: Option<Duration>,
}
```

- 支持 "exploring" 模式：多个读操作命令合并为一个 ExecCell
- `complete_call()` 标记某个 call 完成并返回是否匹配
- `should_flush()` 检查是否所有 call 都已完成

`exec_cell/render.rs` 提供命令行渲染、spinner 动画、输出行限制等功能。

### 5.9 实时包装 (`live_wrap.rs`)

`RowBuilder` 是增量文本行包装工具：
- 按 `target_width` 分割行为可视行
- 跟踪 `explicit_break`（硬换行 vs 软换行）
- 支持 `set_width()` 重包装

### 5.10 HistoryCell (`history_cell.rs`)

4868 行的转录单元渲染器。`HistoryCell` trait：
```rust
trait HistoryCell: Send + Sync {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>>;
    fn is_stream_continuation(&self) -> bool;
    // ...
}
```

多种 cell 类型：用户消息、agent 消息、exec 调用、patch 审批、MCP 调用、会话配置等。每个 cell 根据 `width` 自适应渲染。

---

## 6. 样式系统与其他

### 6.1 样式规范 (`styles.md`)

项目遵循严格的样式指南：

| 类别 | 规则 |
|------|------|
| 标题 | `bold` |
| 主要文本 | 默认前景色 |
| 次要文本 | `dim` |
| 用户输入/选择/状态 | ANSI `cyan` |
| 成功/添加 | ANSI `green` |
| 错误/删除 | ANSI `red` |
| Codex 品牌 | ANSI `magenta` |
| **避免** | 自定义颜色、`black`/`white` 前景色、`blue`/`yellow` |

代码约定：
- 使用 `"text".into()` 和 `"text".red()` Stylize trait
- 避免 `Span::styled` 和 `Style` 直接构造
- 不使用 `.white()`，使用默认前景色

### 6.2 颜色系统 (`color.rs`)

```rust
fn is_light(bg: (u8, u8, u8)) -> bool  // 亮度 > 128 → 浅色
fn blend(fg, bg, alpha) -> (u8, u8, u8)  // Alpha 混合
fn perceptual_distance(a, b) -> f32  // CIE76 Lab 空间距离
```

### 6.3 终端调色板 (`terminal_palette.rs`)

```rust
enum StdoutColorLevel { TrueColor, Ansi256, Ansi16, Unknown }
fn best_color(target) -> Color  // 根据终端能力选最佳颜色
fn default_colors() -> Option<DefaultColors>  // 查询终端前景/背景色
fn requery_default_colors()  // FocusGained 时重查
```

- 查询 OSC 转义序列获取终端默认前景/背景色（真色终端）
- `best_color()` 根据终端颜色级别选择最佳表示（真色直接用 / 256 色就近匹配 / 16 色回退默认）

### 6.4 应用样式 (`style.rs`)

```rust
fn user_message_style() -> Style     // 用户消息背景色（浅终端=4%黑，深终端=12%白）
fn proposed_plan_style() -> Style     // 计划模式背景色（同用户消息）
```

### 6.5 文本换行 (`wrapping.rs`)

1407 行的 URL 感知换行系统：

- **标准换行**：`word_wrap_line` / `word_wrap_lines` — 纯文本，委托给 `textwrap`
- **自适应换行**：`adaptive_wrap_line` / `adaptive_wrap_lines` — 检测 URL 后切换为 `AsciiSpace` 分词 + URL 感知 `WordSplitter`
- `text_contains_url_like()` — 启发式 URL 检测

### 6.6 渲染模块 (`render/mod.rs`)

```rust
struct Insets { left, top, right, bottom: u16 }
trait RectExt { fn inset(&self, insets: Insets) -> Rect; }
```

### 6.7 Renderable Trait (`render/renderable.rs`)

```rust
trait Renderable {
    fn render(&self, area: Rect, buf: &mut Buffer);
    fn desired_height(&self, width: u16) -> u16;
    fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>;
}
```

提供 `RenderableItem<'a>` 枚举（`Owned` / `Borrowed`）用于混合动态和静态渲染对象。实现了 `&str`、`String`、`Line`、`Paragraph` 等的 `Renderable`。

### 6.8 状态模块 (`status/mod.rs`)

格式化协议级快照为状态栏显示：
- `RateLimitSnapshotDisplay` — 速率限制用量
- `StatusHistoryHandle` — `/status` 命令的卡片式输出
- `compose_agents_summary()` — 多 agent 状态摘要

### 6.9 新手引导 (`onboarding/`)

首次运行引导流程：
- 登录认证（ChatGPT 账号）
- 目录信任确认
- Windows 沙箱设置
- 在独立的 TUI 屏幕中运行（`run_onboarding_app`）

### 6.10 行工具 (`render/line_utils.rs`)

`prefix_lines()` — 给多行文本添加前缀（首行/后续行可不同）
`push_owned_lines()` — 高效构建 `Vec<Line<'static>>`

---

## 架构总结

### 数据流

```
用户按键 → TuiEventStream → App::run() 主循环
     ↓                          ↓
  AppEvent ←─ mpsc ── AppEventSender ←─ 后台任务/线程事件
     ↓
  App::handle_event() → ChatWidget → BottomPane → ChatComposer
     ↓
  AppCommand ──→ AppServerSession ──→ App-Server Protocol
     ↓
  ServerNotification → ThreadEventChannel → App 事件循环
```

### 关键设计模式

1. **Actor 模式**：`FrameRequester`/`FrameScheduler` 使用 mpsc channel 实现帧调度 actor
2. **双缓冲流式渲染**：`StreamState` + `StreamController` + `MarkdownStreamCollector` 三级管线
3. **滞后切换策略**：`AdaptiveChunkingPolicy` Smooth/CatchUp 两档自动切换
4. **Event Broker**：`EventBroker` 允许暂停/恢复 crossterm 事件流，安全交接 stdin 给外部进程
5. **HistoryCell trait**：统一渲染接口，支持流式（`is_stream_continuation`）和已提交两种模式
6. **BottomPaneView trait**：弹窗视图的堆叠式组合，composer 始终存在于底层
7. **终端自适应**：颜色级别检测、alt screen 管理、Zellij 兼容、键盘增强检测

### 模块依赖图（简化）

```
main.rs → lib.rs::run_main() → App::run()
    ↓                           ↓
    Tui (终端抽象)          App (状态机)
    ↓                       ↓     ↓
    EventBroker         ChatWidget  BottomPane
    FrameRequester      ↓           ↓
                       Streaming   ChatComposer
                       HistoryCell  Views/Popups
                       Markdown     Footer
                       DiffRender   Approval
```