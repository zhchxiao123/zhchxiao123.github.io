---
title: "Step 16: ACP 适配器与 Cron"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/16-acp-and-cron/
---

# ACP 适配器与 Cron 调度深度分析

## 1. 概述

ACP（Agent Client Protocol）适配器和 Cron 调度系统是 Hermes Agent 的两个外围基础设施模块。ACP 适配器将 Hermes 的 `AIAgent` 封装为符合 Agent Client Protocol 标准的服务，便于 IDE（VS Code、Zed、JetBrains）和外部工具集成。Cron 系统提供定时任务调度，支持一次性、间隔和标准 cron 表达式三种调度模式，并能将执行结果投递到聊天平台。

**关键文件清单：**

| 文件 | 行数 | 职责 |
|------|------|------|
| `acp_adapter/entry.py` | ~50 | 入口：创建 HermesACPAgent 实例并启动 |
| `acp_adapter/server.py` | ~600 | ACP 服务器核心：会话管理、消息流、斜杠命令 |
| `acp_adapter/auth.py` | ~100 | 认证：API Key 验证与权限检查 |
| `acp_adapter/session.py` | ~200 | 会话持久化：SQLite 存储与恢复 |
| `acp_adapter/events.py` | ~300 | 事件桥接：sync 回调 → async ACP 事件 |
| `acp_adapter/permissions.py` | ~150 | 权限映射：ACP 权限模型 → hermes 审批 |
| `acp_adapter/tools.py` | ~400 | 工具映射：hermes 工具 → ACP ToolKind |
| `cron/jobs.py` | ~500 | 作业定义与存储：CRUD、序列化、原子写入 |
| `cron/scheduler.py` | ~600 | 调度引擎：tick 循环、并发控制、投递 |

---

## 2. ACP 适配器

### 2.1 架构：同步 Agent → 异步 ACP 桥接

核心设计问题是 `AIAgent.run_conversation()` 完全同步，而 ACP 协议基于 async/await。适配器通过 `ThreadPoolExecutor` 桥接两者：

```python
class HermesACPAgent(acp.Agent):
    def __init__(self):
        super().__init__()
        self._executor = ThreadPoolExecutor(max_workers=4)
        self._loop = asyncio.new_event_loop()

    async def handle_message(self, conn, session_id, message):
        agent = self._get_or_create_agent(session_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            self._executor,
            agent.run_conversation,
            message
        )
```

每个 ACP 会话对应一个独立的 `AIAgent` 实例，保证会话间隔离。`run_in_executor` 将同步调用卸载到线程池，避免阻塞事件循环。

### 2.2 会话持久化

`SessionManager` 使用 Hermes 内置的 `SessionDB`（SQLite）存储 ACP 会话，支持重启恢复：

```python
class SessionManager:
    def save_session(self, session_id, messages, model, provider, cwd, api_mode):
        """持久化会话状态到 SessionDB"""

    def load_session(self, session_id):
        """从 SessionDB 恢复会话，返回 messages 列表和元数据"""
```

存储的元数据包括：对话历史、模型名、provider、工作目录、api_mode。会话恢复时重建完整 `AIAgent` 状态。

### 2.3 事件桥接

`events.py` 创建四个回调工厂，将 AIAgent 的同步回调桥接到 ACP 的 async 事件：

| 回调工厂 | 触发时机 | ACP 事件 |
|----------|----------|----------|
| `make_tool_progress_cb` | 工具调用开始/进度 | `ToolCallStart` / `ToolCallProgress` |
| `make_thinking_cb` | Agent 模型推理中 | `ThinkingStart` / `ThinkingProgress` |
| `make_step_cb` | 迭代步骤完成 | `StepComplete` |
| `make_message_cb` | 最终响应生成 | `MessageComplete` |

桥接机制核心是 `asyncio.run_coroutine_threadsafe()`，从同步线程向事件循环注入协程：

```python
def make_tool_progress_cb(conn, session_id, loop):
    def cb(event_type, data):
        async def _send():
            await conn.session_update(session_id, [
                TextualContent(type="tool_call_progress", ...)
            ])
        asyncio.run_coroutine_threadsafe(_send(), loop)
    return cb
```

### 2.4 权限映射

`permissions.py` 将 ACP 的 `PermissionOption` 映射到 hermes 内部审批字符串：

| ACP Permission Kind | Hermes Approval |
|---------------------|-----------------|
| `read` | `"file_read"` |
| `edit` | `"file_edit"` |
| `execute` | `"execute"` |
| `fetch` | `"web_fetch"` |
| `browser` | `"browser"` |

`make_approval_callback` 将 ACP 的异步权限请求（带超时）桥接到 hermes 同步审批回调。ACP 客户端（如 IDE 扩展）显示权限弹窗，用户批准后异步返回。

### 2.5 工具映射与 Diff 视图

`tools.py` 建立了 hermes 工具名到 ACP `ToolKind` 的映射表：

```python
TOOL_KIND_MAP = {
    "terminal":       ToolKind.execute,
    "read_file":      ToolKind.read,
    "write_file":     ToolKind.edit,
    "search_files":   ToolKind.search,
    "web_search":     ToolKind.fetch,
    "web_extract":    ToolKind.fetch,
    "browser_navigate": ToolKind.browser,
    "think":          ToolKind.think,
    ...
}
```

对于文件补丁操作（`apply_diff`），`ToolCallProgress` 生成 diff 视图（unified diff format），让 IDE 扩展可以在编辑器内展示变更预览。

### 2.6 斜杠命令

ACP 服务器支持以下本地命令，无需 LLM 调用：

- `/help` — 显示可用命令
- `/model` — 查看/切换模型
- `/tools` — 列出启用/禁用工具集
- `/context` — 查看上下文文件
- `/reset` — 重置会话
- `/compact` — 压缩上下文
- `/version` — 显示版本

这些命令复用了 `agent/skill_commands.py` 中的逻辑，通过 `resolve_command()` 进行别名解析。

---

## 3. Cron 调度系统

### 3.1 作业模型

Cron 作业存储在 `~/.hermes/cron/jobs.json`，每个作业包含：

```python
class CronJob:
    id: str                    # UUID
    name: str                  # 人类可读名称
    schedule: ScheduleConfig   # 调度配置
    prompt: str                # Agent 提示词
    platform: str              # 来源平台（telegram/discord/...）
    chat_id: str               # 来源聊天 ID
    delivery: DeliveryConfig   # 投递配置
    model: str = None          # 可选模型覆盖
    provider: str = None       # 可选 provider 覆盖
    enabled: bool = True       # 启用/禁用
    created_at: str            # ISO 时间戳
    last_run: str = None       # 上次执行时间
    next_run: str = None       # 下次执行时间
    run_count: int = 0        # 执行计数
```

### 3.2 调度类型

支持三种调度模式：

| 类型 | 配置 | 示例 |
|------|------|------|
| `once` | `run_at: ISO时间戳` + `grace_minutes: int` | `"2024-01-15T09:00:00"` |
| `interval` | `every_minutes: int` | `30`（每30分钟） |
| `cron` | `expression: str` | `"0 9 * * 1-5"`（工作日9点） |

`once` 类型支持 `grace_minutes` 容错窗口——如果调度器在指定时间后 `grace_minutes` 分钟内启动，任务仍会执行。

### 3.3 调度引擎

`scheduler.py` 实现了完整的调度循环：

1. **Tick 循环**：每 60 秒触发一次 tick，检查所有作业的 `next_run` 时间
2. **并发控制**：基于文件的互斥锁（`~/.hermes/cron/.tick.lock`），防止多进程并发调度
3. **At-most-once 语义**：`advance_next_run()` 在执行前更新 `next_run`，确保即使执行失败也不会重复触发
4. **作业执行**：`run_job()` 创建完整的 `AIAgent` 实例，设置不活跃超时，执行提示词
5. **结果投递**：根据 `delivery` 配置，将结果发送到聊天平台或仅本地保存

### 3.4 原子写入

作业存储使用原子写入模式防止数据损坏：

```python
def save_jobs(jobs):
    tmp = jobs_path.with_suffix('.tmp')
    with open(tmp, 'w') as f:
        json.dump(jobs, f, indent=2)
    os.replace(tmp, jobs_path)  # Atomic on POSIX
```

输出文件同样使用原子写入（`~/.hermes/cron/output/{job_id}/{timestamp}.md`）。

### 3.5 投递机制

作业结果可以投递到多个目标：

| 投递模式 | 行为 |
|----------|------|
| `origin` | 投递到作业来源的聊天平台和频道 |
| `platform:chat_id` | 投递到指定平台和频道 |
| `local` | 仅保存到本地文件 |
| `[SILENT]` 标记 | 抑制投递，仅保存 |

投递通过 Gateway 的平台适配器完成，复用 `send()` 方法。如果 Gateway 未运行，结果仅保存到本地。

---

## 4. 代码质量评估

### 4.1 优点

1. **桥接模式清晰**：ACP 适配器通过 ThreadPoolExecutor + `run_coroutine_threadsafe()` 干净地解决了同步/异步不匹配问题，这是 Python 中标准的桥接模式。

2. **原子写入**：Cron 的文件存储使用 `os.replace()` 原子操作，避免部分写入导致的数据损坏。

3. **权限模型完整**：ACP 的权限请求有超时机制，5 秒无响应自动拒绝，防止无限等待。

4. **会话恢复**：ACP 的 `SessionManager` 利用已有的 `SessionDB`，不需要额外的持久化基础设施。

5. **Cron 的 at-most-once 语义**：`advance_next_run()` 在执行前推进时间戳，这是分布式调度中的标准做法。

### 4.2 不足与风险

1. **线程池大小硬编码**：ACP 的 `ThreadPoolExecutor(max_workers=4)` 硬编码为 4。如果同时有 5 个 ACP 会话并发请求，第 5 个会排队等待。应改为可配置值，或根据实际连接数动态调整。

2. **Cron 单文件存储**：所有作业存储在单个 `jobs.json` 中。当作业数量增长时（数百个），每次 tick 都需要读取和解析完整文件。考虑使用 SQLite 或分片存储。

3. **事件桥接的线程安全**：`events.py` 中的回调工厂捕获 `loop` 引用，但如果 ACP 服务器重启，旧回调可能持有失效的事件循环引用。`run_coroutine_threadsafe()` 在目标循环关闭时会抛出 `RuntimeError`，需要捕获处理。

4. **Cron 无作业优先级**：所有到期作业按顺序执行，没有优先级概念。如果一个高优先级监控作业排在低优先级作业后面，可能延迟执行。

5. **ACP 缺少速率限制**：ACP 服务器没有内置速率限制，恶意客户端可以无限发送消息。生产环境需要添加速率限制中间件。

6. **工具映射不完整**：`tools.py` 中有约 60+ hermes 工具，但 `TOOL_KIND_MAP` 只映射了约 30 个。未映射的工具默认归类为 `ToolKind.other`，这可能使 ACP 客户端无法正确展示某些工具的类型信息。

7. **Cron 输出无清理机制**：`~/.hermes/cron/output/` 下的输出文件永久累积，没有基于时间或数量的清理策略。

---

## 5. 改进建议

### 5.1 高优先级

1. **ACP 线程池可配置化**：将 `max_workers` 改为配置项，默认值从 `config.yaml` 的 `acp.max_workers` 读取，回退到 `min(32, os.cpu_count() + 4)`。

2. **Cron 存储迁移到 SQLite**：将 `jobs.json` 迁移到 SQLite 数据库，支持并发读写、索引查询和事务性保证。可以复用 `hermes_state.py` 中的 `SessionDB` 模式。

3. **ACP 事件回调异常处理**：在所有回调工厂中添加 `try/except RuntimeError`，捕获事件循环关闭导致的异常，降级为日志记录而非静默失败。

### 5.2 中优先级

4. **完善工具映射**：遍历 `model_tools.py` 中的 `TOOL_TO_TOOLSET_MAP`，为每个工具添加 `ToolKind` 映射。对于无法归类的工具（如 `delegate`、`memory`），使用更细粒度的自定义种类。

5. **Cron 输出清理**：添加基于配置的清理策略（如保留最近 7 天或最近 100 个输出文件），在每次 tick 开始时执行清理。

6. **ACP 速率限制**：添加基于会话的速率限制（如每分钟 30 条消息），使用令牌桶算法。可参考 Gateway 中的速率限制实现。

### 5.3 低优先级

7. **Cron 作业优先级**：为 `CronJob` 添加 `priority` 字段（默认 5，范围 1-10），调度器按优先级排序执行到期作业。

8. **ACP 会话超时清理**：添加空闲会话自动清理机制。如果会话超过 N 分钟无活动，释放 `AIAgent` 实例及相关资源，仅保留序列化的会话数据。