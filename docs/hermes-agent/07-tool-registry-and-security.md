---
title: "Step 7: 工具注册与调度体系"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/07-tool-registry-and-security/
---

# 07 — 工具注册与安全体系深度分析

## 1. 概述：工具体系架构

hermes-agent 的工具体系由四个核心层组成，形成一条从注册 → 发现 → 过滤 → 调度 → 安全审查的完整链路：

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Tool Lifecycle (Top-Level View)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐ │
│  │ tools/*.py    │───▶│ registry.py   │───▶│ model_tools.py        │ │
│  │ (自注册)      │    │ (ToolRegistry │    │ (编排层: 过滤+调度)   │ │
│  └──────────────┘    │  singleton)   │    └──────────┬────────────┘ │
│                      └──────┬────────┘               │              │
│                             │                         │              │
│  ┌──────────────┐          │              ┌────────────▼────────────┐ │
│  │ toolsets.py  │──────────┤              │ Security Pipeline      │ │
│  │ (工具集定义)  │          │              │ ┌────────────────────┐│ │
│  └──────────────┘          │              │ │ approval.py         ││ │
│                             │              │ │ (危险命令检测)       ││ │
│  ┌──────────────────────┐  │              │ ├────────────────────┤│ │
│  │ toolset_distributions │──┤              │ │ tirith_security.py  ││ │
│  │ (平台分发配置)         │  │              │ │ (外部安全扫描)      ││ │
│  └──────────────────────┘  │              │ ├────────────────────┤│ │
│                             │              │ │ path_security.py   ││ │
│                             │              │ │ (路径遍历防护)      ││ │
│                             │              │ ├────────────────────┤│ │
│                             │              │ │ budget_config.py   ││ │
│                             │              │ │ (结果大小预算)      ││ │
│                             │              │ └────────────────────┘│ │
│                             │              └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

核心设计理念：**自注册 + 中央注册表 + 声明式工具集**。

---

## 2. 各组件职责详解

### 2.1 `tools/registry.py` — 核心注册表（482 行）

#### 2.1.1 `ToolRegistry` 类

**核心数据结构：**

| 属性 | 类型 | 用途 |
|------|------|------|
| `_tools` | `Dict[str, ToolEntry]` | 工具名 → 元数据映射 |
| `_toolset_checks` | `Dict[str, Callable]` | 工具集名 → 可用性检查函数 |
| `_toolset_aliases` | `Dict[str, str]` | 别名 → 规范工具集名映射 |
| `_lock` | `threading.RLock` | 保护并发读写 |

**`ToolEntry` 数据类（使用 `__slots__` 优化内存）：**

| 字段 | 说明 |
|------|------|
| `name` | 工具唯一标识（如 `"web_search"`） |
| `toolset` | 所属工具集（如 `"web"`） |
| `schema` | OpenAI 格式的函数定义 JSON Schema |
| `handler` | `(args: dict, **kwargs) → str` 调用入口 |
| `check_fn` | 可用性检查函数（返回 `bool`） |
| `requires_env` | 依赖的环境变量列表 |
| `is_async` | 是否为异步处理函数 |
| `description` | 人类可读描述 |
| `emoji` | UI 显示图标 |
| `max_result_size_chars` | 单工具结果大小上限（覆盖全局默认值） |

#### 2.1.2 `register()` 完整参数与生命周期

```python
def register(
    self,
    name: str,
    toolset: str,
    schema: dict,
    handler: Callable,
    check_fn: Callable = None,
    requires_env: list = None,
    is_async: bool = False,
    description: str = "",
    emoji: str = "",
    max_result_size_chars: int | float | None = None,
):
```

**注册时的关键行为：**

1. **命名冲突保护** — 如果已存在同名工具且两者不都属于 MCP 工具集，注册会被拒绝并记录 `ERROR` 级日志。只有当新旧工具都属于 `mcp-*` 工具集时才允许覆盖（MCP 服务器刷新场景）。
2. **check_fn 只存第一个** — 如果同一工具集中多个工具提供了 `check_fn`，只有最先注册的那个会被保存到 `_toolset_checks`。这意味着同一工具集的所有工具共享同一个可用性检查函数。
3. **线程安全** — 注册操作使用 `RLock` 保护，且读取操作通过 `_snapshot_state()` 返回不可变快照。

**注册时序：** 在 `model_tools.py` 模块加载时调用 `discover_builtin_tools()` → `importlib.import_module()` 触发各个 `tools/*.py` 文件顶层的 `registry.register()` 调用。这是 **import-time registration** 模式。

#### 2.1.3 自动发现机制

```python
def discover_builtin_tools(tools_dir=None) -> List[str]:
```

**发现流程：**

1. 扫描 `tools/` 目录下所有 `.py` 文件
2. 排除 `__init__.py`、`registry.py`、`mcp_tool.py`（MCP 有独立的发现机制）
3. 使用 AST 解析每个文件，检查模块顶层是否有 `registry.register(...)` 调用（`_is_registry_register_call()`）
4. 对匹配的模块执行 `importlib.import_module()`，触发注册
5. 所有导入异常被捕获并记录 `WARNING` 日志

**AST 检查的限制：** 只检查模块顶层语句（`tree.body`），不会检出函数内部的注册调用。这防止了辅助模块被误识别。

#### 2.1.4 Schema 收集与 Dispatch

**`get_definitions(tools_to_include, quiet)`：**

1. 拍摄注册表快照（线程安全）
2. 对每个请求的工具名，查找 `ToolEntry`
3. 运行 `check_fn`（带结果缓存，同一函数在一次调用中只执行一次）
4. 对通过检查的工具，组装 OpenAI 格式的 `{"type": "function", "function": schema}` 定义
5. 确保 schema 始终包含 `"name"` 字段（用 entry.name 作为保证）

**`dispatch(name, args, **kwargs)`：**

1. 查找 `ToolEntry`
2. 对异步处理器，通过 `_run_async()` 桥接（`from model_tools import _run_async`）
3. 所有异常被捕获，返回 `{"error": "..."}` 格式的 JSON 字符串

**注意：** `dispatch` 本身不在线程锁内执行。锁只保护 `_tools` 字典的读写，dispatch 执行期间不需要持锁。

#### 2.1.5 线程安全性分析

| 操作 | 线程安全？ | 机制 |
|------|-----------|------|
| `register()` / `deregister()` | ✅ | `RLock` 保护 |
| `get_entry()` | ✅ | 持锁读取 |
| `get_definitions()` | ✅ | 快照 + 局部函数缓存 |
| `dispatch()` | ✅ | 读快照 + 无锁执行 |
| MCP 动态刷新（多线程） | ✅ | 全局 `_lock` 保护 |

`_snapshot_state()` 返回的是列表和字典的**浅拷贝**。`ToolEntry` 对象本身通过 `__slots__` 定义且不可变（属性不会被修改），所以浅拷贝是安全的。

**潜在风险：** 如果两个线程同时调用 `_snapshot_state()` 并各自修改返回的列表/字典（虽然当前代码不会这样做），不会互相影响。但 `ToolEntry` 对象是共享引用——如果 `handler` 或 `check_fn` 有可变状态，需要在 handler 内部自行保证线程安全。

#### 2.1.6 辅助函数

```python
def tool_error(message, **extra) -> str:
    """Return a JSON error string for tool handlers."""

def tool_result(data=None, **kwargs) -> str:
    """Return a JSON result string for tool handlers."""
```

这两个函数消除了数百处 `json.dumps({"error": msg}, ensure_ascii=False)` 的样板代码。

---

### 2.2 `toolsets.py` — 工具集定义（702 行）

#### 2.2.1 `_HERMES_CORE_TOOLS` 列表

这是所有平台共享的核心工具清单（37 个工具），覆盖 10 大类别：

| 类别 | 工具 |
|------|------|
| Web | `web_search`, `web_extract` |
| Terminal | `terminal`, `process` |
| File | `read_file`, `write_file`, `patch`, `search_files` |
| Vision | `vision_analyze`, `image_generate` |
| Skills | `skills_list`, `skill_view`, `skill_manage` |
| Browser | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `browser_vision`, `browser_console` |
| TTS | `text_to_speech` |
| Planning | `todo`, `memory`, `session_search` |
| Clarify | `clarify` |
| Code/Delegate | `execute_code`, `delegate_task` |
| Cron | `cronjob` |
| Messaging | `send_message`（check_fn 门控） |
| Home Assistant | `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_call_service`（check_fn 门控） |

每个 messenger 平台的 `hermes-*` 工具集都直接引用 `_HERMES_CORE_TOOLS`，避免逐一枚举导致遗漏。

#### 2.2.2 工具集启用/禁用逻辑

**`resolve_toolset(name, visited)`：**

递归解析工具集，支持组合（`includes`）。核心逻辑：

1. 特殊别名 `"all"` / `"*"` → 解析所有工具集
2. 环检测：`visited` 集合追踪已访问路径，diamond 依赖静默返回空列表
3. 合并直接工具 + 递归解析 includes 的工具

**`get_toolset(name)`：** 先查 `TOOLSETS` 静态字典，再查注册表（MCP 动态工具集），最后查别名映射。

#### 2.2.3 平台差异

| 平台 | 工具集名 | 与 CORE 差异 |
|------|---------|-------------|
| ACP (编辑器集成) | `hermes-acp` | 无 `text_to_speech`、`clarify`、`send_message` |
| API Server | `hermes-api-server` | 无 `clarify`、`send_message` |
| CLI/所有 Messenger | `hermes-cli`, `hermes-telegram` 等 | 完整 `_HERMES_CORE_TOOLS` |
| Gateway | `hermes-gateway` | 联合所有 messenger 工具集 |

`hermes-acp` 和 `hermes-api-server` 是手写清单而非引用 `_HERMES_CORE_TOOLS`，这意味着新增核心工具时需要同步更新这两个定义——这是一个**维护风险点**。

---

### 2.3 `model_tools.py` — 工具编排层（562 行）

#### 2.3.1 模块加载阶段

```python
discover_builtin_tools()          # 1. 发现并注册内置工具
discover_mcp_tools()             # 2. 发现 MCP 外部服务器工具
discover_plugins()                # 3. 发现用户/项目/pip 插件工具
```

三个发现阶段按顺序执行，每个阶段的失败被静默捕获（`logger.debug`）。

**向后兼容常量（模块加载后一次性构建）：**

```python
TOOL_TO_TOOLSET_MAP = registry.get_tool_to_toolset_map()
TOOLSET_REQUIREMENTS = registry.get_toolset_requirements()
```

这些在模块导入时构建，后续 MCP 动态刷新不会更新它们——这是一个**静态快照问题**。

#### 2.3.2 `_last_resolved_tool_names` 全局变量

```python
_last_resolved_tool_names: List[str] = []
```

**作用：** `get_tool_definitions()` 将最终过滤后的工具名列表存入此全局变量，供 `execute_code` 工具使用——它需要知道当前会话中有哪些工具可用，以缩小沙箱内可调用工具的范围。

**风险：**
- 进程全局变量，多线程/多会话并发时会竞争
- `delegate_tool` 的 `_run_single_child()` 会保存和恢复此全局变量，但这种 save/restore 模式在并发场景中仍然脆弱
- 在 gateway（多会话并发）中，不同会话可能相互覆盖此变量

#### 2.3.3 `handle_function_call()` — 主调度器

```python
def handle_function_call(function_name, function_args, task_id=None,
                         tool_call_id=None, session_id=None,
                         user_task=None, enabled_tools=None,
                         skip_pre_tool_call_hook=False) -> str:
```

**调度流程：**

```
入参 → coerce_tool_args(类型强转)
    → _AGENT_LOOP_TOOLS 拦截（todo/memory/session_search/delegate_task）
    → 插件 pre_tool_call 钩子（可能阻断）
    → read/search 连续读计数器通知
    → execute_code 特殊路径（传递 enabled_tools）
    → registry.dispatch(实际执行)
    → 插件 post_tool_call 钩子
    → 返回结果
```

**Agent 级别工具拦截：** `_AGENT_LOOP_TOOLS = {"todo", "memory", "session_search", "delegate_task"}` — 这四个工具的 schema 在注册表中注册，但 dispatch 返回一个 stub 错误 `"must be handled by the agent loop"`。实际执行在 `run_agent.py` 的主循环中进行，因为它们需要访问 agent 级别状态（`TodoStore`、`MemoryStore` 等）。

**参数类型强转 (`coerce_tool_args`)：** LLM 经常返回字符串类型的数字和布尔值（`"42"` 而非 `42`）。此函数对比工具的 JSON Schema 定义，自动进行 `str → int`、`str → float`、`str → bool` 的类型转换，支持 union type。

#### 2.3.4 Schema 后处理

**`execute_code` 动态 Schema：**

如果 `execute_code` 在可用工具列表中，调用 `build_execute_code_schema(sandbox_enabled)` 重建其 schema，只包含当前可用的沙箱工具。这防止模型看到 `"web_search is available in execute_code"` 后在不具备 web_search API key 时仍尝试调用。

**`browser_navigate` 描述裁剪：**

当 `web_search` / `web_extract` 不可用时，从 `browser_navigate` 的描述中移除 `"For simple information retrieval, prefer web_search or web_extract (faster, cheaper)."` 这句交叉引用。这遵循了 AGENTS.md 中的设计原则：**Schema 描述不能引用可能不存在的工具**。

#### 2.3.5 异步桥接

```python
_tool_loop = None           # 主线程持久事件循环
_worker_thread_local         # 工作线程本地事件循环
```

`_run_async(coro)` 处理三种场景：
1. **已有运行中的事件循环**（gateway/RL env）→ 启动一次性线程执行
2. **工作线程**（delegate_task 并行执行）→ 使用线程本地持久循环
3. **主线程**（CLI）→ 使用进程全局持久循环

这种设计避免了 `asyncio.run()` 每次创建并销毁循环导致的 `"Event loop is closed"` 错误。

---

### 2.4 `toolset_distributions.py` — 平台级分发（364 行）

#### 2.4.1 设计目的

为 RL 训练和批处理场景提供概率性工具集选择——每个工具集有一个被选中的百分比概率。

#### 2.4.2 预定义分发

| 分发名 | 用途 | 工具集概率 |
|--------|------|-----------|
| `default` | 全部可用 | web:100, vision:100, image_gen:100, terminal:100, file:100, moa:100, browser:100 |
| `image_gen` | 图像生成侧重 | image_gen:90, vision:90, web:55, terminal:45 |
| `research` | 研究侧重 | web:90, browser:70, vision:50, moa:40 |
| `science` | 科学研究 | web:94, terminal:94, file:94, vision:65 |
| `development` | 开发侧重 | terminal:80, file:80, moa:60 |
| `safe` | 无终端 | web:80, browser:70, vision:60, image_gen:60 |
| `browser_tasks` | 浏览器任务 | browser:97, terminal:15, vision:12 |
| `terminal_tasks` | 终端任务 | terminal:97, file:97, web:97, browser:75 |

#### 2.4.3 采样逻辑

`sample_toolsets_from_distribution()` 独立采样每个工具集（伯努利试验），保证至少一个工具集被选中（兜底选最高概率的那个）。

**与注册表的松耦合：** 工具集名通过 `validate_toolset()` 验证，该函数会回退到注册表查找。但分发定义中的概率百分比是硬编码的——不会根据注册表动态调整。

---

### 2.5 `tools/approval.py` — 危险命令检测（957 行）

#### 2.5.1 双层检测架构

```
用户命令
    │
    ├─── detect_dangerous_command() ─── 正则模式匹配（内置）
    │                                    37 条 DANGEROUS_PATTERNS
    │
    └─── tirith (外部) ──── 内容级安全扫描
                             (homograph URL, pipe-to-interpreter 等)
```

#### 2.5.2 `DANGEROUS_PATTERNS` — 37 条正则规则

规则按攻击面分类：

| 类别 | 示例规则 | 数量 |
|------|---------|------|
| 递归删除 | `rm -r`, `find -delete` | 4 |
| 权限提升 | `chmod 777`, `chown -R root` | 4 |
| 磁盘/块设备 | `mkfs`, `dd if=`, `> /dev/sd` | 3 |
| 数据库破坏 | `DROP TABLE`, `DELETE FROM` (无 WHERE), `TRUNCATE` | 3 |
| 系统配置覆盖 | `> /etc/`, `tee /etc/`, `sed -i /etc/` | 4 |
| 服务控制 | `systemctl stop/restart/disable` | 1 |
| 进程杀死 | `kill -9 -1`, `pkill -9` | 2 |
| Fork 炸弹 | `:(){ :|:& };:` | 1 |
| Shell 注入 | `bash -c`, `python -e`, `curl | sh` | 5 |
| 网关自毁 | `hermes gateway stop/restart/update` | 2 |
| 进程自杀 | `pkill hermes`, `kill $(pgrep hermes)` | 3 |
| Git 破坏性操作 | `git reset --hard`, `git push --force`, `git clean -f` | 4 |
| Heredoc 执行 | `python3 << 'EOF'` | 1 |
| chmod+x 即执行 | `chmod +x ... && ./` | 2 |

**命令规范化预处理（`_normalize_command_for_detection`）：**

1. 剥离 ANSI 转义序列
2. 移除 null 字节
3. Unicode NFKC 规范化（将全角字符转为半角，防止视觉欺骗）

#### 2.5.3 Approval 状态管理

**三级审批级别：**

| 级别 | 范围 | 存储 |
|------|------|------|
| `once` | 单次 | 不存储 |
| `session` | 会话内 | `_session_approved[session_key]` |
| `always` | 永久 | `config.yaml` 的 `command_allowlist` |

**会话隔离：** 使用 `contextvars.ContextVar` 实现 per-async-task 的会话键，解决了 gateway 多线程并发下的会话混淆问题。

**YOLO 模式：** `HERMES_YOLO_MODE` 环境变量（CLI 进程级）或 `_session_yolo`（per-session）可完全绕过审批。

**容器环境自动放行：** `docker`、`singularity`、`modal`、`daytona` 环境类型自动返回 `{approved: True}`。

#### 2.5.4 Gateway 阻塞式审批

```python
class _ApprovalEntry:
    event: threading.Event
    data: dict
    result: Optional[str]  # "once"|"session"|"always"|"deny"
```

**流程：**
1. Agent 线程提交 `_ApprovalEntry` 到 `session_key` 队列
2. 通过 `notify_cb` 通知用户（async → sync 桥接）
3. Agent 线程 `event.wait()` 阻塞，每 1 秒心跳一次 `touch_activity_if_due`
4. 用户通过 `/approve` 或 `/deny` 解析 `entry.event`
5. 超时（默认 5 分钟）→ 拒绝

**心跳设计亮点：** 防止网关的不活跃看门狗（`agent.gateway_timeout`, 默认 1800s）误杀正在等待用户审批的 Agent。

#### 2.5.5 Smart Approvals（智能审批）

基于辅助 LLM 的风险评估：

1. 读取 `approvals.mode` 配置（`manual` / `smart` / `off`）
2. `smart` 模式下，调用辅助 LLM 评估命令的实际风险
3. LLM 返回 `APPROVE`（安全）、`DENY`（危险）或 `ESCALATE`（不确定→退回人工审批）
4. 自动放行的命令仍记录 session 级审批，后续同类命令无需再次审批

**Prompt 安全设计：** LLM 被指示考虑命令的 **实际风险**而非模式匹配结果。例如 `python -c "print('hello')"` 被模式匹配标记为"script execution via -c flag"，但 LLM 应判断其为安全。

#### 2.5.6 `check_all_command_guards()` — 统一入口

合并 tirith 和 dangerous pattern 两层检测结果，生成单一审批请求：

- tirith `block` / `warn` → 需要审批（以前是硬阻断，现在改为可审批）
- 当 tirith 发现存在时，隐藏 `[a]lways` 选项（防止永久放行安全扫描发现）

---

### 2.6 `tools/path_security.py` — 路径安全（43 行）

极简模块，提供两个辅助函数：

| 函数 | 用途 |
|------|------|
| `validate_within_dir(path, root)` | 确保 `path` 解析后在 `root` 目录内（`resolve() + relative_to()` 方式） |
| `has_traversal_component(path_str)` | 快速检查路径字符串是否包含 `..` 组件 |

**被以下模块使用：** `skill_manager_tool`、`skills_tool`、`skills_hub`、`cronjob_tools`、`credential_files`。

**设计原则：** 先快速检查 `..` 组件（低开销），再用 `resolve()` + `relative_to()` 做完整解析（防 symlink 绕过）。

---

### 2.7 `tools/tirith_security.py` — 外部安全扫描（684 行）

#### 2.7.1 外部工具集成

Tirith 是一个 Rust 编写的命令行安全扫描器（[sheeki03/tirith](https://github.com/sheeki03/tirith)），通过子进程调用。

**退出码约定：**

| 退出码 | 含义 |
|--------|------|
| 0 | allow（安全） |
| 1 | block（危险） |
| 2 | warn（警告） |

#### 2.7.2 自动安装机制

```
PATH 查找 → $HERMES_HOME/bin/tirith → GitHub Releases 下载 → SHA-256 校验 → [cosign 签名验证] → 安装
```

**安装策略：**

1. 优先使用 PATH 或本地已有的 tirith
2. 用户显式配置路径 → 不会回退到自动下载
3. 首次需要时启动后台线程下载
4. 下载失败缓存 24 小时（磁盘标记文件）
5. `cosign_missing` 失败原因可自动恢复（cosign 上线后重试）

**安全验证：**

- 所有下载强制 SHA-256 校验
- cosign 签名验证（可选，cosign 不可用时降级到仅 SHA-256）
- tar 提取只取 `tirith` 二进制文件（拒绝含 `..` 的路径）

#### 2.7.3 Fail-Open/Fail-Closed 配置

```yaml
security:
  tirith_enabled: true
  tirith_path: "tirith"
  tirith_timeout: 5
  tirith_fail_open: true  # true=扫描失败时放行, false=扫描失败时阻断
```

环境变量覆盖：`TIRITH_ENABLED`、`TIRITH_BIN`、`TIRITH_TIMEOUT`、`TIRITH_FAIL_OPEN`。

---

### 2.8 `tools/budget_config.py` — 预算控制（52 行）

#### 2.8.1 三层结果大小控制

| 层 | 常量 | 默认值 | 说明 |
|----|------|--------|------|
| 单工具结果阈值 | `DEFAULT_RESULT_SIZE_CHARS` | 100,000 | 超过此大小触发持久化 |
| 单回合总预算 | `DEFAULT_TURN_BUDGET_CHARS` | 200,000 | 单个 assistant turn 所有工具结果总大小 |
| 预览片段 | `DEFAULT_PREVIEW_SIZE_CHARS` | 1,500 | 持久化后内联显示的字符数 |

#### 2.8.2 `BudgetConfig` 解析优先级

```
pinned → tool_overrides → registry per-tool → default
```

- **`PINNED_THRESHOLDS`**：`read_file → inf`（永不触发持久化，防止 read→persist→read 死循环）
- **`tool_overrides`**：用户可针对特定工具覆盖阈值
- **registry per-tool**：工具注册时的 `max_result_size_chars` 字段
- **default**：`DEFAULT_RESULT_SIZE_CHARS`

---

## 3. 工具生命周期流程图

```
┌─────────────────────────────────────────────────────────────────┐
│  1. BOOT: Tool Discovery & Registration                          │
│                                                                  │
│  model_tools.py (module load)                                   │
│      │                                                           │
│      ├─ discover_builtin_tools()                                │
│      │   ├─ AST scan tools/*.py for registry.register() calls  │
│      │   └─ importlib.import_module() → trigger register()    │
│      │                                                          │
│      ├─ discover_mcp_tools()  (external MCP servers)           │
│      │                                                          │
│      └─ discover_plugins()    (user/project/pip plugins)       │
│                                                                 │
│  Result: registry._tools populated, TOOL_TO_TOOLSET_MAP built  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  2. SESSION: Tool Definition Assembly                           │
│                                                                  │
│  get_tool_definitions(enabled_toolsets, disabled_toolsets)       │
│      │                                                           │
│      ├─ resolve_toolset() → expand includes, get tool names     │
│      │                                                          │
│      ├─ registry.get_definitions(tool_names)                   │
│      │   └─ check_fn filtering (API keys available?)            │
│      │                                                          │
│      ├─ Post-processing:                                        │
│      │   ├─ execute_code: rebuild schema with available tools   │
│      │   └─ browser_navigate: strip cross-references           │
│      │                                                          │
│      └─ _last_resolved_tool_names = [...] (global state)        │
│                                                                 │
│  Result: OpenAI-format tool definitions for API call            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  3. INVOCATION: Tool Call Dispatch                               │
│                                                                  │
│  handle_function_call(name, args, ...)                           │
│      │                                                           │
│      ├─ coerce_tool_args()        → fix LLM type mistakes      │
│      │                                                          │
│      ├─ _AGENT_LOOP_TOOLS check   → stub error for todo/      │
│      │                              memory/session_search/      │
│      │                              delegate_task               │
│      │                                                          │
│      ├─ Plugin pre_tool_call hook → may block                  │
│      │                                                          │
│      ├─ Read/search counter → reset consecutive read tracking  │
│      │                                                          │
│      ├─ registry.dispatch(name, args)                           │
│      │   └─ handler(args) or _run_async(handler(args))          │
│      │                                                          │
│      └─ Plugin post_tool_call hook                              │
│                                                                 │
│  Result: JSON string returned to agent loop                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  4. SECURITY: Command Approval Pipeline                          │
│                                                                  │
│  terminal_tool → check_all_command_guards(command, env_type)     │
│      │                                                           │
│      ├─ Container env? → auto-approve                           │
│      ├─ YOLO mode? → auto-approve                               │
│      ├─ approvals.mode=off? → auto-approve                      │
│      │                                                           │
│      ├─ tirith_security.check_command_security()                 │
│      │   └─ subprocess: tirith check --json --non-interactive  │
│      │                                                          │
│      ├─ approval.detect_dangerous_command()                      │
│      │   └─ 37 regex patterns + Unicode normalization           │
│      │                                                          │
│      ├─ approvals.mode=smart? → _smart_approve() via aux LLM  │
│      │                                                          │
│      ├─ Already approved? → auto-approve                       │
│      │                                                          │
│      └─ CLI: prompt_dangerous_approval()                        │
│         Gateway: blocking _ApprovalEntry queue                  │
│             └─ /approve, /deny → resolve entry.event            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 代码质量评估

### 4.1 问题与风险点

#### 4.1.1 高风险

| ID | 类别 | 问题 | 位置 |
|----|------|------|------|
| H1 | 并发安全 | `_last_resolved_tool_names` 是进程全局变量，多会话并发时存在竞争条件 | `model_tools.py:159` |
| H2 | 静态快照 | `TOOL_TO_TOOLSET_MAP` 和 `TOOLSET_REQUIREMENTS` 在模块加载时一次性构建，后续 MCP 动态刷新不会更新 | `model_tools.py:153-155` |
| H3 | 维护负担 | `hermes-acp` 和 `hermes-api-server` 手写工具清单而非引用 `_HERMES_CORE_TOOLS`，新增核心工具需同步更新 | `toolsets.py:229-276` |

#### 4.1.2 中风险

| ID | 类别 | 问题 | 位置 |
|----|------|------|------|
| M1 | 设计耦合 | `dispatch()` 通过 `from model_tools import _run_async` 导入反向依赖，违反注册表不应依赖编排层的原则 | `registry.py:304` |
| M2 | 隐式行为 | `check_fn` 只保存每工具集的第一个注册，如果同一工具集多个工具提供不同的 `check_fn`，只有第一个生效 | `registry.py:226-227` |
| M3 | 正则局限 | 37 条 DANGEROUS_PATTERNS 是静态正则，无法检测编码混淆（base64 编码的恶意命令、unicode 转义等） | `approval.py:76-139` |
| M4 | 竞态条件 | `_gateway_queues` 的锁粒度不一致：`register_gateway_notify` / `unregister_gateway_notify` 使用 `_lock`，但 `resolve_gateway_approval` 的 queue 操作也在 `_lock` 下，而 entry 清理在锁外 | `approval.py:877-882` |
| M5 | 超时硬编码 | Gateway 审批超时默认 300s，CLI 超时 60s，缺乏配置入口 | `approval.py:527-529, 847` |

#### 4.1.3 低风险

| ID | 类别 | 问题 | 位置 |
|----|------|------|------|
| L1 | 性能 | `get_definitions()` 对每个工具名执行一次 `check_fn()`，如果同一函数被多个工具引用则缓存命中，但 `check_results` 缓存是局部的（每次调用新建），跨调用不复用 | `registry.py:265-275` |
| L2 | 可读性 | `_PATTERN_KEY_ALIASES` 在模块级别构建，依赖 `DANGEROUS_PATTERNS` 常量的顺序——新增模式时容易遗漏 | `approval.py:148-152` |
| L3 | 类型安全 | `tool_result(data=None, **kwargs)` 接受 dict 或 kwargs 但不支持两者同时传入（会静默忽略 data），缺少运行时断言 | `registry.py:470-482` |
| L4 | 全局状态 | `_permanent_approved` 使用进程内 `set` 而非持久化，仅在模块导入时从 config 加载一次。新增的 `always` 审批在多进程部署中不共享 | `approval.py:209` |
| L5 | 类型标注 | `toolset_distributions.py` 的 `get_distribution` 返回类型标注为 `Dict[str, any]`，使用了小写 `any` 而非 `Any` | `toolset_distributions.py:223` |

### 4.2 设计亮点

| # | 方面 | 说明 |
|---|------|------|
| 1 | 自注册模式 | 工具文件只需在顶层调用 `registry.register()`，无需维护中央注册列表 |
| 2 | AST 扫描 | 避免导入辅助模块，只导入真正有注册调用的文件 |
| 3 | 快照架构 | `_snapshot_state()` 返回浅拷贝，读写分离，dispatch 无需持锁 |
| 4 | 命名冲突保护 | MCP 覆盖 MCP 允许，非 MCP 覆盖非 MCP 拒绝 |
| 5 | 命令规范化 | Unicode NFKC + ANSI 剥离，防止视觉欺骗绕过 |
| 6 | 心跳保活 | Gateway 审批阻塞时每秒发送心跳，防止看门狗误杀 |
| 7 | 智能审批 | 辅助 LLM 评估实际风险，减少误报干扰 |
| 8 | tirith 自动安装 | 后台下载 + SHA-256 + cosign 验证，用户零配置 |
| 9 | 失败标记持久化 | 24 小时磁盘标记避免反复网络重试，`cosign_missing` 可自动恢复 |
| 10 | 参数类型强转 | 自动修复 LLM 输出的字符串化数字/布尔值 |

---

## 5. 改进建议

### 5.1 架构级

| 优先级 | 建议 | 理由 |
|--------|------|------|
| P0 | **将 `_last_resolved_tool_names` 改为会话级状态** | 当前进程全局变量在并发场景下会导致 `execute_code` 的沙箱工具列表混乱。建议将其存入 `contextvars` 或随 `task_id` 走 |
| P0 | **移除 `TOOL_TO_TOOLSET_MAP` / `TOOLSET_REQUIREMENTS` 静态常量** | 改为从注册表动态查询。当前值在模块加载时固定，MCP 动态刷新后过时 |
| P1 | **消除 `dispatch()` 对 `model_tools._run_async` 的反向依赖** | 将 `_run_async` 提取为独立模块（如 `tools/async_utils.py`），或在注册表初始化时注入 async 桥接函数 |

### 5.2 功能级

| 优先级 | 建议 | 理由 |
|--------|------|------|
| P1 | **`hermes-acp` 和 `hermes-api-server` 工具集引用 `_HERMES_CORE_TOOLS` 减去排除列表** | 从手写清单改为 `_HERMES_CORE_TOOLS` + 排除列表，新增工具时不再需要同步更新两处 |
| P1 | **`check_fn` 改为 per-tool 而非 per-toolset** | 当前同一工具集中只有第一个工具的 `check_fn` 生效，后续工具的检查函数被静默忽略。可改为每个 `ToolEntry` 独立持有 `check_fn`，`get_definitions` 逐个检查 |
| P2 | **为 Gateway 审批超时增加 YAML 配置项** | 当前 CLI 60s 硬编码，Gateway 300s 硬编码在 `_get_approval_config().get("gateway_timeout", 300)` |
| P2 | **`_permanent_approved` 多进程同步** | 通过文件锁或 SQLite 共享永久审批状态，避免多进程部署下的不一致 |

### 5.3 安全级

| 优先级 | 建议 | 理由 |
|--------|------|------|
| P1 | **增加编码解码检测** | 当前正则模式无法检测 `echo base64_string | base64 -d | bash` 等编码混淆攻击 |
| P2 | **tirith 安装使用 HTTPS 证书固定** | 当前依赖 CA 信任链 + SHA-256 校验，可考虑增加证书固定防止 MITM |
| P2 | **路径安全增加 symlink 深度限制** | `validate_within_dir` 使用 `resolve()` 跟随 symlink，但未限制递归深度，理论上可被深层 symlink 链攻击 |

### 5.4 代码质量

| 优先级 | 建议 | 理由 |
|--------|------|------|
| P2 | **`tool_result()` 增加参数互斥断言** | 当同时传入 `data` 和 `kwargs` 时，`data` 被静默忽略，应至少记录 warning |
| P3 | **`_PATTERN_KEY_ALIASES` 使用函数注解而非模块级循环** | 提高可读性和可维护性 |
| P3 | **`toolset_distributions.py` 修复 `any` → `Any`** | 小写 `any` 是 Python 内置函数而非类型标注 |
| P3 | **为 `_gateway_queues` 操作统一锁粒度** | 当前 `resolve_gateway_approval` 的 entry 清理在 `_lock` 外执行，存在竞争窗口 |