---
title: "Step 8: 核心工具实现（上）"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/08-core-tools-part1/
---

# Hermes-Agent 核心工具实现深度分析（第一批）

> 分析范围：`tools/terminal_tool.py`、`tools/file_tools.py` + `tools/file_operations.py`、`tools/web_tools.py`、`tools/browser_tool.py`、`tools/code_execution_tool.py`、`tools/delegate_tool.py`

---

## 1. 概述

| 工具 | 文件 | 行数 | 核心职责 |
|------|------|------|----------|
| 终端 | `terminal_tool.py` | 1,756 | 命令执行编排，6种环境后端分发 |
| 文件 | `file_tools.py` + `file_operations.py` | 799 + 1,216 | 文件读写搜索补丁，ShellFileOperations跨后端适配 |
| Web | `web_tools.py` | 2,101 | 多后端搜索/提取，LLM摘要压缩 |
| 浏览器 | `browser_tool.py` | 2,418 | 浏览器自动化（本地/云/CDP/反检测） |
| 代码执行 | `code_execution_tool.py` | 1,416 | Python沙箱执行，UDS和文件RPC双传输 |
| 子代理 | `delegate_tool.py` | 1,143 | 子代理创建/并行执行/深度限制 |

---

## 2. 终端工具 (`terminal_tool.py`)

### 2.1 核心逻辑

**环境创建与复用**：采用 `_active_environments` 全局字典 + `_env_lock` 线程锁 + `_creation_locks` per-task 锁的三层并发控制。每个 `task_id` 对应一个环境实例，首次使用时创建，后续复用，inactive 超过 `lifetime_seconds` 后由后台清理线程回收。

```
task_id → _active_environments[task_id] → Environment实例
                                 ↑
                    双重检查锁 (creation_lock + env_lock)
```

**后台进程管理**：`background=true` 通过 `process_registry.spawn_local/spawn_via_env` 创建进程，返回 `session_id`。配合 `notify_on_complete` 和 `watch_patterns` 实现完成通知和输出模式匹配通知。

**PTY 支持**：`pty=true` 参数为交互式 CLI 工具（如 Codex、Claude Code）提供伪终端。但 `_command_requires_pipe_stdin()` 会识别需要管道输入的命令（如 `gh auth login --with-token`）并自动禁用 PTY。

### 2.2 Sudo 处理

`_transform_sudo_command()` 是核心安全桥接：

1. 使用 `_rewrite_real_sudo_invocations()` 解析 shell token，仅替换真正的 `sudo` 命令词（跳过注释、引号内的文本）
2. 将 `sudo` 替换为 `sudo -S -p ''`
3. 将密码前置到 stdin 管道（`sudo_stdin`），使 `sudo -S` 从 stdin 读取密码
4. 交互模式下弹出 sudo 密码提示（`_prompt_for_sudo_password`），缓存于 `_cached_sudo_password`

### 2.3 环境后端分发

`_create_environment()` 根据 `TERMINAL_ENV` 环境变量分发到 6 种后端：

| 后端 | 类 | 特点 |
|------|-----|------|
| local | `LocalEnvironment` | 直接在宿主执行，最快 |
| docker | `DockerEnvironment` | 容器隔离，需 Docker |
| ssh | `SSHEnvironment` | 远程 SSH 执行 |
| modal | `ModalEnvironment` / `ManagedModalEnvironment` | Modal 云沙箱 |
| daytona | `DaytonaEnvironment` | Daytona 云开发环境 |
| singularity | `SingularityEnvironment` | Singularity 容器 |

每个后端在 `tools/environments/` 下有独立实现文件。

### 2.4 安全机制

- **危险命令审批**：`_check_all_guards()` 委托给 `tools/approval.py`（Tirith 规则引擎 + 危险命令模式匹配）
- **工作目录验证**：`_validate_workdir()` 使用白名单正则，只允许路径安全字符
- **前台超时上限**：`FOREGROUND_MAX_TIMEOUT = 600s`，超过则强制使用后台模式
- **退出码解读**：`_interpret_exit_code()` 为 grep/diff/curl/git 等常见命令的非零退出码提供人性化解读

### 2.5 代码质量评估

**优点**：
- 环境生命周期管理周全：创建锁、清理线程、atexit 清理、磁盘用量警告
- Sudo 处理考虑了 shell token 级别的精确性，避免误替换
- 配置解析健壮（`_parse_env_var` 带类型转换错误处理）

**风险点**：
- `_cached_sudo_password` 是进程级全局变量，明文存储 sudo 密码，直到进程退出才释放
- `_task_env_overrides` 是全局可变字典，无锁保护（注释称 "Thread-safe because each task_id is unique per rollout"，但这依赖外部保证）
- 清理线程中 `_cleanup_inactive_envs()` 在锁外调用 `env.cleanup()`，如果 cleanup 抛异常，只 log 不重试
- `_get_env_config()` 每次调用都会重新解析环境变量，在热路径上可能有性能开销

---

## 3. 文件工具 (`file_tools.py` + `file_operations.py`)

### 3.1 架构设计

采用 **抽象接口 + Shell 实现** 的分层架构：

```
file_tools.py (编排层)
  ├── read_file_tool()  ← 安全守卫、去重、字符限制
  ├── write_file_tool() ← 敏感路径检查、陈旧性警告
  ├── patch_tool()      ← replace/patch 双模式
  ├── search_tool()     ← ripgrep grep/find 搜索
  └── ShellFileOperations (适配层)
        └── env.execute() ← 最终通过终端后端执行
            (local/docker/ssh/modal/daytona)
```

`ShellFileOperations` 将所有文件操作转化为 shell 命令（`cat`、`sed`、`rg`、`find`等），使得任何有 `execute()` 方法的后端都能支持文件操作。

### 3.2 大文件处理策略

- **字符计数保护**：`_get_max_read_chars()` 从 config 读取上限（默认 100K 字符），超过则拒绝并提示使用 offset/limit
- **大文件提示**：超过 512KB 的文件会附加 `_hint` 建议定向读取
- **行截断**：单行超过 2000 字符自动截断（`MAX_LINE_LENGTH`）
- **分页**：`offset` + `limit` 参数支持精确范围读取

### 3.3 重复读取检测与防护

`_read_tracker` 是每个 task 的阅读追踪器：

- **去重**：`(resolved_path, offset, limit) → mtime` 映射，文件未修改时返回 "File unchanged" 短回复
- **循环检测**：连续 3 次相同读取加警告，4 次硬阻断
- **`notify_other_tool_call()`**：其他工具调用时重置连续计数器，避免误报
- **陈旧性警告**：`_check_file_staleness()` 检查写操作前文件是否被外部修改
- **上下文压缩后重置**：`reset_file_dedup()` 清空缓存，因压缩后模型丢失原文

### 3.4 安全机制

**写入保护**（`file_operations.py`）：
- `WRITE_DENIED_PATHS`：硬编码保护 `~/.ssh/authorized_keys`、`~/.env`、`/etc/passwd` 等
- `WRITE_DENIED_PREFIXES`：保护 `~/.ssh/`、`~/.aws/`、`~/.gnupg/` 等整个目录
- `HERMES_WRITE_SAFE_ROOT`：可选沙箱，限制所有写入到指定目录内

**读取保护**（`file_tools.py`）：
- `_BLOCKED_DEVICE_PATHS`：阻止 `/dev/zero`、`/dev/random` 等会挂起的设备文件
- `_is_blocked_device()`：还阻止 `/proc/self/fd/0-2` 等别名
- 二进制文件扩展名检查（`binary_extensions.py`）
- Hermes 内部路径保护（skills hub 缓存目录）

**敏感信息脱敏**：读取内容经过 `redact_sensitive_text()` 处理，搜索结果同样脱敏

### 3.5 Shell 命令安全

`ShellFileOperations._escape_shell_arg()` 使用单引号包裹 + 替换内部单引号的经典方案。路径扩展 `_expand_path()` 支持 `~` 和 `~user`，但对于 `~user` 格式会先验证用户名格式再让 shell 扩展，避免注入。

### 3.6 代码质量评估

**优点**：
- 抽象层设计优秀，`ShellFileOperations` 让所有后端统一支持文件操作
- 去重和循环检测机制精巧，有效节省 context tokens
- 陈旧性警告是独特的安全特性，防止代理基于过时内容编辑
- 文件未找到时的相似文件建议功能实用

**风险点**：
- `_get_file_ops()` 中环境创建逻辑与 `terminal_tool.py` 中的 `_create_environment()` 有大量重复（SSH配置、容器配置构建等），应抽取共享函数
- `ShellFileOperations` 依赖外部命令可用性（`rg`、`find`、`sed`等），在某些后端环境中可能不存在
- 写入通过 `cat >` 管道 stdin 实现，对于非常大的文件可能有管道缓冲区压力
- `_search_content()` 中 rg/grep 命令通过 `| head` 管道截断，但在 `output_mode=count` 和 `output_mode=content` 模式下的管道语义不一致

---

## 4. Web 工具 (`web_tools.py`)

### 4.1 多后端搜索

```
web_search_tool(query, limit)
  ├── backend == "parallel" → _parallel_search()  (Parallel SDK)
  ├── backend == "exa"      → _exa_search()       (Exa SDK)
  ├── backend == "tavily"   → _tavily_request()  (HTTP POST)
  └── backend == "firecrawl" → client.search()    (Firecrawl SDK)
```

后端自动选择优先级（`_get_backend()`）：
1. config.yaml 显式配置
2. Firecrawl（含 managed gateway）
3. Parallel
4. Tavily
5. Exa

### 4.2 内容提取与LLM摘要

`web_extract_tool()` 对提取内容执行智能压缩：

```
web_extract_tool(urls, format, use_llm_processing)
  ├── SSRF 检查 (is_safe_url)
  ├── 网站策略检查 (check_website_access)
  ├── Firecrawl/Parallel/Exa/Tavily 提取
  └── LLM 压缩处理:
       ├── < 5K chars: 不过处理
       ├── 5K-500K chars: 单次 LLM 摘要
       └── 500K-2M chars: 分块并行摘要 + 合成
       └── > 2M chars: 拒绝处理
```

分块处理流程 (`_process_large_content_chunked`)：
1. 将内容分成 ~100K 字符的块
2. 并行摘要每块（`asyncio.gather`）
3. 合成所有块摘要为最终摘要
4. 硬性输出上限 5000 字符

### 4.3 安全机制

- **SSRF 保护**：`is_safe_url()` 在前后端双重检查（前端搜索 URL、后端提取 URL），还检查 URL 解码后的形式
- **密钥泄露防护**：`_PREFIX_RE` 正则匹配 URL 中的 API key 模式（`sk-`、`sk_ant-` 等），阻止通过 URL 外泄密钥
- **网站策略**：`check_website_access()` 可配置黑名单
- **base64 图片清理**：`clean_base64_images()` 移除内容中的 data URI 图片，减少 token 消耗

### 4.4 代码质量评估

**优点**：
- 多后端透明切换，fallback 机制完善
- LLM 摘要压缩是大文件处理的优秀策略，分块+合成避免单次超大输入
- Firecrawl 配置灵活（直接 API vs managed gateway vs config 优先级）
- Tavily 结果归一化函数（`_normalize_tavily_search_results/document`）设计清晰

**风险点**：
- `_firecrawl_client` 和 `_parallel_client` 是模块级全局单例，配置热更新不生效（需重启）
- `process_content_with_llm()` 是 async 函数但 `web_search_tool()` 是 sync，可能导致事件循环冲突（取决于调用上下文）
- 每个客户端初始化（`_get_exa_client`、`_get_parallel_client`等）在首次调用时才创建，缺少连接健康检查
- `_resolve_web_extract_auxiliary()` 每次调用都解析配置，但 `extra_body` 只对 Nous 客户端有意义，对其他提供者是冗余参数

---

## 5. 浏览器工具 (`browser_tool.py`)

### 5.1 架构设计

```
browser_tool.py
  ├── 多后端支持
  │   ├── 本地 Chromium (agent-browser CLI)
  │   ├── Browserbase (云)
  │   ├── Browser Use (云)
  │   ├── Firecrawl (仅搜索)
  │   ├── CDP 直连 (BROWSER_CDP_URL)
  │   └── Camofox (本地反检测 REST API)
  │
  ├── 会话管理
  │   ├── _get_session_info() → 创建/复用会话
  │   ├── 云 fallback → 本地 Chromium
  │   └── 空闲超时清理 (BROWSER_SESSION_INACTIVITY_TIMEOUT)
  │
  └── 页面交互
      ├── navigate → 导航 + 自动快照
      ├── snapshot → 无障碍树文本表示
      ├── click/type → 元素交互 (@eN 引用)
      ├── scroll/press/back → 导航操作
      ├── vision → 截图 + 视觉AI分析
      ├── console → JS错误/日志 + 表达式求值
      └── get_images → 页面图片提取
```

### 5.2 Browserbase 集成

云后端提供者模式：
- `BrowserbaseProvider`：直接使用 BROWSERBASE_API_KEY
- `BrowserUseProvider`：直接使用 BROWSER_USE_API_KEY 或 managed Nous gateway
- `FirecrawlProvider`：仅搜索，无浏览器自动操作
- 自动 fallback：若云后端失败，回退到本地 Chromium

每个提供者通过 `CloudBrowserProvider` 基类接口实现 `create_session()` 和 `close_session()`。

### 5.3 会话与生命周期

- `_active_sessions`: `task_id → {session_name, bb_session_id, cdp_url, features}`
- 后台清理线程（30秒间隔）检查 `_session_last_activity`，超时关闭会话
- `atexit` 注册紧急清理，防止孤立会话
- 孤儿进程收割：`_reap_orphaned_browser_sessions()` 扫描 `/tmp/agent-browser-*` 目录，杀死无主 daemon

### 5.4 安全机制

- **SSRF 4 层防护**：
  1. URL 密钥检查（`_PREFIX_RE`）
  2. SSRF 检查（`_is_safe_url()`）— 本地后端跳过
  3. 网站策略检查（`check_website_access()`）
  4. 重定向后 SSRF 检查（导航后比对 `final_url`，命中则导航到 `about:blank`）
- **私有地址控制**：`_allow_private_urls()` 从 config 读取，默认禁止

### 5.5 快照内容提取

`_extract_relevant_content()` 使用 LLM 从大型快照中提取与任务相关的内容：
- 阈值：`SNAPSHOT_SUMMARIZE_THRESHOLD = 8000` 字符
- 有 `user_task` 时：提取与任务相关的交互元素和文本
- 无 `user_task` 时：保留所有交互元素和关键内容
- 自动截断（`_truncate_snapshot`）在行边界切割

### 5.6 代码质量评估

**优点**：
- `agent-browser` CLI 发现机制全面（PATH、Homebrew、node_modules、npx fallback），兼容性强
- macOS socket 路径处理（`_socket_safe_tmpdir` → `/tmp`）避免 AF_UNIX 104字节限制
- 截图自动清理（24小时）、录制自动清理（72小时）防止磁盘膨胀
- CDP URL 解析（`_resolve_cdp_override()`）支持 HTTP 发现端点自动获取 WebSocket URL

**风险点**：
- `_cloud_provider` 全局单例，运行时无法切换后端
- `_cached_command_timeout` 和 `_agent_browser_resolved` 缓存后不随配置更改，只在 `cleanup_all_browsers()` 时重置
- `_run_browser_command()` 使用临时文件（`stdout_path`/`stderr_path`）而非管道，避免 daemon 继承 fd 的挂起问题，但清理是 best-effort（可能留下临时文件）
- `browser_vision()` 截图转 base64 直接嵌入 LLM 调用，大截图可能导致 API 请求过大（虽有 `_resize_image_for_vision` 重试机制）

---

## 6. 代码执行 (`code_execution_tool.py`)

### 6.1 沙箱架构

双传输模式：

```
Local (UDS)                          Remote (File-based RPC)
┌──────────────────┐                ┌──────────────────┐
│ Parent Process    │                │ Parent Process    │
│  ┌────────────┐  │                │  ┌────────────┐  │
│  │ RPC Server │  │                │  │ RPC Poll   │  │
│  │ (UDS sock) │◄─┼──────────┐    │  │ Thread      │  │
│  └────────────┘  │          │    │  └──────┬─────┘  │
│                  │          │    │         │          │
│  ┌────────────┐  │          │    │  ┌──────▼─────┐  │
│  │ Child Proc │  │  Newline-delimited  │ env.execute() │
│  │ script.py  │──┼──JSON────┘    │  │ (in sandbox) │  │
│  │ hermes_    │  │               │  └────────────┘  │
│  │ tools.py   │  │               │                  │
│  └────────────┘  │               │  ┌────────────┐  │
│                  │               │  │ Remote Env  │  │
│  (subprocess)    │               │  │ (Docker/SSH) │  │
└──────────────────┘               │  └────────────┘  │
                                   └──────────────────┘
```

### 6.2 安全机制

**环境变量隔离**（本地模式）：
- `_SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH")`
- 子进程只继承：`PATH`、`HOME`、`USER`、`LANG` 等安全前缀的变量 + 技能声明的 `env_passthrough` 变量
- 明确移除 `HERMES_TIMEZONE`，传入 `TZ` 代替

**工具调用限制**：
- 白名单：`SANDBOX_ALLOWED_TOOLS = {web_search, web_extract, read_file, write_file, search_files, patch, terminal}`
- `terminal` 调用禁止 `background`、`pty`、`notify_on_complete`、`watch_patterns` 参数
- 最大 50 次工具调用（`DEFAULT_MAX_TOOL_CALLS`）
- 最大执行时间 300s（`DEFAULT_TIMEOUT`）

**输出限制**：
- stdout 上限 50KB（`MAX_STDOUT_BYTES`），超限采用 40% 头 + 60% 尾保留策略
- stderr 上限 10KB（`MAX_STDERR_BYTES`）
- ANSI 转义序列剥离（`strip_ansi`）
- 敏感信息脱敏（`redact_sensitive_text`）

### 6.3 RPC 通信

**UDS（本地）**：
- 服务端 `socket.AF_UNIX` + `socket.SOCK_STREAM`
- newline-delimited JSON 协议
- 单连接模型（`server_sock.listen(1)`）
- 5秒 accept 超时 + 300秒 read 超时

**文件 RPC（远程）**：
- 请求文件 `req_NNNNNN` + 响应文件 `res_NNNNNN`
- 原子写入：先写 `.tmp` 再 `rename`
- 自适应轮询：50ms 起步，1.2x 退避，最大 250ms
- 300秒超时

### 6.4 代码质量评估

**优点**：
- 双传输设计使所有终端后端都能支持代码执行，而不仅仅是本地模式
- 环境变量隔离策略完善，有效防止密钥泄露
- `_drain_head_tail()` 的 head+tail 策略比简单截断更智能，保留开头错误信息和结尾输出
- 子进程以 `os.setsid()` 创建进程组，超时时整个进程组被杀死

**风险点**：
- RPC 服务端是单连接 (`listen(1)`)，如果沙箱脚本尝试并发工具调用，只能串行处理
- `_rpc_server_loop()` 使用 `sys.stdout = devnull` 的方式抑制工具调用输出，如果工具调用抛异常，devnull fd 可能泄露（但 finally 块恢复）
- 文件 RPC 的轮询间隔在高速场景下可能成为瓶颈（50ms 最小间隔）
- `_ship_file_to_remote()` 使用 `echo base64 | base64 -d > file` 传输，对大文件（如 hermes_tools.py 模块）效率低，但对于短脚本可接受

---

## 7. 子代理委托 (`delegate_tool.py`)

### 7.1 子代理创建

`_build_child_agent()` 构建 AIAgent 实例，关键设计决策：

- **工具集限制**：`DELEGATE_BLOCKED_TOOLS = {delegate_task, clarify, memory, send_message, execute_code}` — 禁止递归委托、用户交互、记忆写入、跨平台消息、代码执行（子代理应逐步推理）
- **工具集继承**：子代理的工具集是请求工具集与父代理工具集的交集，不能获得父代理没有的工具
- **凭证池共享**：同 provider 的子代理共享父代理的 credential pool，实现限速自动轮换
- **深度限制**：`MAX_DEPTH = 2`（父→子→孙被拒绝）

### 7.2 并行执行

`delegate_task()` 支持两种模式：
1. **单任务**：直接在当前线程执行
2. **批量**：`ThreadPoolExecutor(max_workers=max_children)` 并行执行，默认最多 3 个并发子代理

批量执行中的进度管理：
- 每个子代理完成时打印 `✓/✗` 状态行
- `concurrent.futures.wait(FIRST_COMPLETED)` 轮询 + 中断检查
- 子代理完成前后的 tool trace 提取（匹配 `tool_call_id` 以正确配对并行调用）

### 7.3 全局状态保存/恢复

**关键机制**：`model_tools._last_resolved_tool_names` 是进程级全局变量，`AIAgent.__init__()` 调用 `get_tool_definitions()` 会覆盖它。

```python
# 保存父代理工具名
_parent_tool_names = list(_model_tools._last_resolved_tool_names)

# 构建所有子代理（会修改全局变量）
for i, t in enumerate(task_list):
    child = _build_child_agent(...)
    child._delegate_saved_tool_names = _parent_tool_names

# 恢复父代理工具名
_model_tools._last_resolved_tool_names = _parent_tool_names

# 子代理执行后，_run_single_child() 的 finally 块再次恢复
```

**三层保障**：
1. 构建子代理前保存 `_parent_tool_names`
2. 所有子代理构建完后 `finally` 中恢复
3. 每个子代理执行完后的 `finally` 中再次恢复

### 7.4 活动心跳

子代理执行期间，后台心跳线程定期调用 `parent_agent._touch_activity()`，防止网关不活跃超时误杀。心跳描述包含子代理当前工具名和迭代进度。

### 7.5 代码质量评估

**优点**：
- 深度限制和工具集限制有效防止递归和权限提升
- 凭证池共享是精巧的设计，支持跨代理限速轮换
- 心跳机制解决了网关超时误杀的实际问题
- 工具跟踪解析使用 `tool_call_id` 正确配对并行工具调用

**风险点**：
- `_last_resolved_tool_names` 全局状态的保存/恢复是多线程下的竞态条件风险（虽然 `_run_single_child` 的 finally 恢复了，但在并行子代理间可能有短暂的窗口期）
- `_load_config()` 在每次 `delegate_task()` 调用时都执行，可考虑缓存
- 子代理无法使用 `execute_code` 工具（被 `DELEGATE_BLOCKED_TOOLS` 阻止），对于需要批量数据处理的任务，子代理只能通过 `terminal` 间接执行脚本

---

## 8. 跨工具分析

### 8.1 共同架构模式

| 模式 | 实现 |
|------|------|
| **全局状态缓存** | `terminal_tool._active_environments`, `browser_tool._active_sessions`, `web_tools._firecrawl_client`, `code_execution_tool._cached_command_timeout` |
| **线程安全锁** | `terminal_tool._env_lock`, `terminal_tool._creation_locks_lock`, `browser_tool._cleanup_lock`, `file_tools._file_ops_lock`, `file_tools._read_tracker_lock` |
| **后台清理线程** | `terminal_tool._cleanup_thread_worker`, `browser_tool._browser_cleanup_thread_worker` |
| **atexit 清理** | `terminal_tool._atexit_cleanup()`, `browser_tool._emergency_cleanup_all_sessions()` |
| **环境变量配置** | 所有工具都从环境变量读取配置，有合理的默认值 |
| **敏感信息脱敏** | `agent.redact.redact_sensitive_text()` 在 terminal、file、code_execution、browser 中统一使用 |
| **任务隔离** | 所有工具接受 `task_id` 参数，实现会话级别的资源和状态隔离 |

### 8.2 共同风险

1. **全局单例膨胀**：每个工具模块都有自己的全局缓存（Firecrawl客户端、Parallel客户端、浏览器会话等），进程长期运行时内存可能持续增长
2. **配置热更新缺失**：大多数全局配置（后端选择、超时设置、命令路径）在首次使用后缓存，不随 config.yaml 变更自动更新
3. **错误处理不一致**：有些工具用 `tool_error()` 返回错误，有些用 `json.dumps({"error": ...})`，有些直接抛异常
4. **环境创建逻辑重复**：`terminal_tool.py`、`file_tools.py`、`code_execution_tool.py` 三处重复了几乎相同的环境创建逻辑（配置读取、SSH/容器配置构建、`_create_environment()` 调用）

### 8.3 改进建议

1. **提取共享环境创建函数**：将 `terminal_tool.py`/`file_tools.py`/`code_execution_tool.py` 中的环境创建逻辑合并为一个共享的 `get_or_create_environment(task_id)` 函数
2. **统一错误格式**：所有工具统一使用 `tool_error()` 函数返回错误，保持 JSON 输出格式一致
3. **配置缓存失效机制**：为全局缓存添加 TTL 或配置文件 watch，支持运行时配置热更新
4. **sudo 密码安全加强**：`_cached_sudo_password` 使用 keyring 存储，而非进程内存
5. **文件 RPC 效率优化**：远程沙箱的大文件传输应考虑使用分块上传而非 base64 编码
6. **浏览器会话管理改进**：将 `_active_sessions` 从简单字典升级为 LRU 或引用计数管理，支持显式会话优先级
7. **子代理全局状态安全**：将 `_last_resolved_tool_names` 改为线程局部变量或使用 `contextvars`，避免依赖保存/恢复模式