---
title: "Step 14: Gateway 核心架构"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/14-gateway-core/
---

# Gateway 核心架构深度分析

## 1. 概述

Hermes Gateway 是一个异步消息网关系统，负责连接 AI Agent 与多个即时通讯平台（Telegram、Discord、Slack、飞书、微信等）。核心代码量约 25,000+ 行（仅 `run.py` 就近 10,000 行），支撑了消息接收、Agent 调用、响应分发、会话管理、Hook 扩展等全生命周期。

**核心文件清单：**

| 文件 | 行数 | 职责 |
|------|------|------|
| `gateway/run.py` | 9,892 | 主循环、消息处理、Slash 命令、Agent 调度 |
| `gateway/config.py` | 1,178 | 平台配置、会话重置策略、流式配置 |
| `gateway/session.py` | 1,090 | 会话持久化（SQLite + JSONL 双写） |
| `gateway/session_context.py` | 145 | 协程安全的会话变量（contextvars） |
| `gateway/hooks.py` | 170 | 基于 YAML + Python 的 Hook 事件系统 |
| `gateway/delivery.py` | 256 | 消息投递路由 |
| `gateway/stream_consumer.py` | 761 | 流式 Token 消费与消息编辑 |
| `gateway/status.py` | 455 | PID 文件、运行时状态、作用域锁 |
| `gateway/restart.py` | 20 | 重启常量与 drain 超时解析 |
| `gateway/display_config.py` | 194 | 每平台显示偏好解析 |
| `gateway/channel_directory.py` | 276 | 渠道发现与名称解析 |
| `gateway/mirror.py` | 132 | 跨平台会话镜像 |
| `gateway/sticker_cache.py` | 111 | Telegram 贴纸描述缓存 |

---

## 2. 核心流程与架构

### 2.1 消息处理主循环

```
┌─────────────────────────────────────────────────────────────────┐
│                    Platform Adapter (async)                      │
│  (telegram.py / discord.py / slack.py / ...)                    │
│  接收平台消息 → 构建 MessageEvent → 调用 _message_handler       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              GatewayRunner._handle_message()                     │
│  1. 用户授权检查（authorized / pairing / ignore）               │
│  2. /update 响应拦截                                            │
│  3. 运行中的 Agent 检查（interrupt / queue / stale eviction）  │
│  4. Slash 命令分发（/new, /reset, /model, /stop 等）            │
│  5. 媒体预处理（STT / Vision / Document）                       │
│  6. 进入 _handle_message_with_agent()                           │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│          _handle_message_with_agent() (under sentinel guard)     │
│  1. _running_agents[session_key] = _AGENT_PENDING_SENTINEL     │
│  2. get_or_create_session() → 会话获取/重置                     │
│  3. build_session_context() → 注入上下文                        │
│  4. Hook emit("agent:start")                                   │
│  5. 加载对话历史 / 自动压缩                                     │
│  6. 创建/复用 AIAgent (agent cache per session)                 │
│  7. run_in_executor → AIAgent.run_conversation()                │
│  8. 流式消费 (GatewayStreamConsumer) 或 批量发送                │
│  9. Hook emit("agent:end")                                      │
│  10. 后处理：媒体投递、内存刷新、会话更新                        │
└─────────────────────────────────────────────────────────────────┘
```

**关键并发控制：**
- `_running_agents` 字典以 `session_key` 为键，值可以是 AIAgent 实例或 `_AGENT_PENDING_SENTINEL`（防止异步窗口期并发）
- Stale eviction：通过 `_running_agents_ts` 时间戳 + `get_activity_summary()` 空闲时间检测陈旧锁
- 照片突发合并：`merge_pending_message_event()` 合并同一会话的连续 PHOTO 事件

### 2.2 会话持久化策略

**双层存储架构：SQLite（主） + JSONL（遗留）**

```
SessionStore
├── _entries: Dict[str, SessionEntry]     # 内存索引
├── sessions.json                          # 持久化索引（atomic write）
├── {session_id}.jsonl                     # 每会话消息日志（遗留）
└── SessionDB (SQLite)                     # 结构化存储（主）
    ├── sessions 表                        # 会话元数据
    └── messages 表                        # 消息记录（FTS5）
```

**会话键构建规则 (`build_session_key`)：**

| 场景 | 格式 |
|------|------|
| DM | `agent:main:{platform}:dm:{chat_id}[:{thread_id}]` |
| Group (per-user) | `agent:main:{platform}:group:{chat_id}:{user_id}` |
| Thread (shared) | `agent:main:{platform}:group:{chat_id}:{thread_id}` |
| 无标识 | `agent:main:{platform}:{chat_type}` |

**重置策略（`SessionResetPolicy`）：**
- `idle`：空闲 N 分钟后重置（默认 1440 分钟 = 24 小时）
- `daily`：每天指定小时重置（默认 04:00）
- `both`：两者取先触发
- `none`：永不自动重置

**重置时的内存刷写：** 自动重置前，启动一个子 Agent（`_flush_memories_for_session`）让模型主动保存重要事实到 MEMORY.md / USER.md，防止上下文丢失。使用 `skip_memory=True` 避免递归。

### 2.3 协程安全的会话变量

`session_context.py` 用 `contextvars.ContextVar` 替代 `os.environ`：

```python
_SESSION_PLATFORM: ContextVar = ContextVar("HERMES_SESSION_PLATFORM", default=_UNSET)
_SESSION_CHAT_ID: ContextVar = ContextVar("HERMES_SESSION_CHAT_ID", default=_UNSET)
# ... 7 个变量
```

**解决问题：** 旧实现用 `os.environ` 在并发 asyncio 任务间互相覆盖。`ContextVar` 每个 asyncio task 独立副本，但通过 `_UNSET` 哨兵保持向后兼容——CLI/cron 等不使用 `set_session_vars` 的场景自动 fallback 到 `os.getenv()`。

### 2.4 Hook 系统

**事件类型：**

| 事件 | 触发时机 |
|------|----------|
| `gateway:startup` | 网关启动 |
| `session:start` | 新会话创建 |
| `session:end` | 会话结束 (/new, /reset) |
| `session:reset` | 会话重置完成 |
| `agent:start` | Agent 开始处理消息 |
| `agent:step` | Agent 每个工具循环步骤 |
| `agent:end` | Agent 处理结束 |
| `command:*` | 任意 Slash 命令（通配符） |

**Hook 发现机制：**
1. 内建 Hook `boot_md`：自动注册 `gateway:startup` 事件，运行 `~/.hermes/BOOT.md`
2. 用户自定义 Hook：扫描 `~/.hermes/hooks/` 目录，每个子目录需要 `HOOK.yaml` + `handler.py`
3. 支持同步和异步 Handler，错误不阻塞主流程

### 2.5 流式消息消费与分片 (`stream_consumer.py`)

**核心架构：线程安全队列 + asyncio 消费**

```
Agent Worker Thread          asyncio Event Loop
    │                              │
    │ on_delta(text)               │
    ├──────── queue.Queue ────────►│ run() loop
    │ on_segment_break()           │  ├── _filter_and_accumulate() (think-block 过滤)
    │ finish()                     │  ├── _send_or_edit() (edit 新/旧消息)
    │                              │  ├── 溢出分片 (truncate_message)
    │                              │  ├── Flood 控制 (自适应退避)
    │                              │  └── Fallback 最终发送
```

**关键机制：**

1. **Think-block 过滤：** 状态机过滤 `<REASONING_SCRATCHPAD>`, `</think>`, `<thinking>` 等推理标签，避免网关用户看到原始推理内容
2. **自适应 Flood 控制：** 连续 3 次 flood 错误后禁用编辑模式，退化为只发最终结果的 fallback 模式；2 次内自适应倍增 `edit_interval`
3. **消息溢出分片：** 当累积文本超过 `MAX_MESSAGE_LENGTH - cursor - 100` 时，在换行符处拆分，通过 `(1/N)` 标记多消息发送
4. **Segment Break：** 工具调用边界（`on_segment_break()`）结束当前流式消息，下一段文本作为新消息发送，确保工具进度消息出现在回复之间
5. **`__no_edit__` 哨兵：** 对于不支持编辑的平台（Signal、webhook），用此哨兵防止每个工具边界都创建新消息

### 2.6 重启机制

**优雅重启流程：**

```
/restart 命令 → _handle_restart_command()
    │
    ├─ drain 模式 (busy_input_mode="queue"):
    │   ├─ 继续处理运行中的 Agent
    │   ├─ 将新消息队列化（不拒绝）
    │   └─ drain 超时后退出
    │
    ├─ interrupt 模式 (busy_input_mode="interrupt"):
    │   ├─ 中断运行中的 Agent
    │   └─ 立即重启
    │
    └─ exit code 75 (EX_TEMPFAIL) → systemd Restart=on-failure 自动重启
```

**PID 管理（`status.py`）：**
- `gateway.pid`：JSON 格式，包含 pid、argv、start_time
- `gateway_state.json`：运行时状态（gateway_state、active_agents、platforms 状态）
- `acquire_scoped_lock()` / `release_scoped_lock()`：基于文件锁的令牌作用域锁（防止多 profile 复用同一 bot token）
- `remove_pid_file()`：仅在 PID 属于当前进程时删除，避免 `--replace` 场景误删新进程的 PID

### 2.7 配置系统 (`config.py`)

**配置层级（高优先级覆盖低优先级）：**

```
环境变量 → config.yaml → gateway.json (遗留)
```

**关键数据类：**

- `PlatformConfig`：每平台配置（enabled, token, api_key, home_channel, reply_to_mode, extra）
- `SessionResetPolicy`：支持 idle/daily/both/none 四种模式
- `GatewayConfig`：汇总所有配置，含 `get_connected_platforms()` 和 `get_reset_policy()`
- `StreamingConfig`：流式 token 编辑配置（transport, edit_interval, buffer_threshold, cursor）
- `HomeChannel`：每平台的默认目标渠道

**`display_config.py`** 实现了四级配置解析：
1. `display.platforms.<platform>.<key>` — 每平台覆盖
2. `display.<key>` — 全局设置
3. 每平台默认值（Tier 1-4 分级）
4. 全局默认

### 2.8 消息投递路由 (`delivery.py`)

**目标格式：**
- `"origin"` → 回到消息来源
- `"local"` → 保存到本地文件（`~/.hermes/cron/output/`）
- `"telegram"` → Telegram Home Channel
- `"telegram:123456"` → Telegram 特定聊天
- `"telegram:123456:789"` → Telegram 特定线程

**截断保护：** `MAX_PLATFORM_OUTPUT = 4000`，超长的 cron 输出自动截断并保存完整版本到本地文件。

---

## 3. 代码质量评估

### 3.1 架构优势

1. **清晰的分层设计：** 平台适配器 → GatewayRunner → AIAgent，每层职责边界明确
2. **并发安全：** `contextvars` 替代 `os.environ`，`_AGENT_PENDING_SENTINEL` 防并发窗口竞争
3. **双存储会话：** SQLite + JSONL 双写，JSONL 作为过渡期兼容，读时取较长的来源
4. **流式消费设计精良：** Think-block 过滤、Flood 自适应退避、Segment Break、`__no_edit__` 哨兵等细节考虑周全
5. **Hook 系统简洁实用：** 基于 YAML + Python 函数，通配符匹配，不阻塞主流程
6. **Profile 安全：** 使用 `get_hermes_home()` 而非硬编码 `~/.hermes`

### 3.2 架构问题

1. **`run.py` 过度膨胀（9,892 行）：** 包含消息处理、Slash 命令、Agent 调度、媒体预处理、内存刷新、会话卫生、配置加载等所有逻辑。单一 `_handle_message` 超过 800 行，`_handle_message_with_agent` 超过 600 行
2. **配置桥接代码过于内联：** `run.py` 前 255 行是将 `config.yaml` 映射到 `os.environ` 的硬编码逻辑，应抽取到独立模块
3. **模块间隐式依赖：** `run.py` 直接操作 `adapter._pending_messages`（私有属性）、直接构造 `MessageEvent`、直接调用 `_flush_memories_for_session` 等
4. **会话卫生逻辑嵌入 run.py：** 上下文压缩阈值判断、模型解析等本应属于 SessionStore 或独立模块的逻辑散落在 `_handle_message_with_agent` 中
5. **缺少类型化的命令处理器：** Slash 命令散落在 `_handle_message` 的 if-elif 链中，而非结构化的命令注册表
6. **配置加载时序脆弱：** SSL 检测 → .env 加载 → config.yaml 桥接 → 模块导入，任何顺序错位都可能导致问题

### 3.3 代码风格观察

- 防御性编程：大量 `try/except` 包裹，非致命错误用 `logger.debug` 而非 `raise`
- 配置优先级明确：环境变量 > YAML > JSON > 默认值
- 向后兼容意识强：JSONL 双写、遗留 `gateway.json` 支持、旧配置键迁移
- 注释质量高：关键设计决策有 `#` 注释解释原因（如 `# Don't hardcode ~/.hermes`）

---

## 4. 改进建议

### 4.1 短期（低风险）

1. **拆分 `run.py` 为模块：**
   - `gateway/commands.py`：Slash 命令处理（从 `_handle_message` 提取）
   - `gateway/media_preprocess.py`：媒体预处理（Vision/STT/Document）
   - `gateway/config_bridge.py`：config.yaml → env var 桥接逻辑
   - `gateway/agent_runner.py`：Agent 创建、缓存、运行、后处理

2. **提取配置桥接到独立函数：** 前 255 行的 `os.environ` 桥接应抽取为 `gateway/config_bridge.py` 的 `_bridge_config_to_env()` 函数

3. **命令注册表模式：** 当前 `_handle_message` 中的 if-elif 链可以替换为类似于 CLI `COMMAND_REGISTRY` 的命令注册表

### 4.2 中期（中等风险）

4. **会话管理抽象：** 将 `_handle_message_with_agent` 中的会话卫生逻辑提取为 `SessionManager` 类：
   ```python
   class SessionManager:
       def maybe_compress(self, history, session_entry) -> list
       def get_agent_config(self, session_key, source) -> tuple
       def update_after_turn(self, session_key, result) -> None
   ```

5. **Agent 生命周期管理器：** `_running_agents`、`_running_agents_ts`、`_pending_messages`、`_agent_cache` 等散落属性应整合为 `AgentPool` 或 `AgentManager` 类

6. **流式消费器与平台解耦：** `GatewayStreamConsumer` 直接引用 `adapter.send()` 和 `adapter.edit_message()`，可提取为协议接口以方便测试

### 4.3 长期（架构级）

7. **事件总线模式：** 当前 Hook 系统只有 fire-and-forget，可扩展为有返回值的事件总线，使平台适配器可以更灵活地注入行为（如消息预处理管道）

8. **会话存储统一：** 完成从 JSONL 到 SQLite 的迁移后，移除 JSONL 双写和 `load_transcript()` 的兼容逻辑

9. **配置热重载：** 当前 `config.yaml` 只在启动时加载，运行时修改需要重启。可引入文件 watch + 热重载机制