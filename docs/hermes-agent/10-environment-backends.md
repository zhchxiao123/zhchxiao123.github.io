---
title: "Step 10: 环境后端"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/10-environment-backends/
---

# 10 — 环境后端系统深度分析

## 1. 概述

Hermes-Agent 的环境后端系统负责在不同执行上下文中运行 shell 命令。核心设计原则是 **spawn-per-call**：每次 `execute()` 调用都会产生一个全新的 bash 进程，会话状态通过 **快照文件**（snapshot）跨调用持久化，工作目录通过 **标记机制**（CWD marker）追踪。

### 架构层次

```
┌──────────────────────────────────────────────────┐
│              terminal_tool.py                     │
│         _create_environment() 工厂函数            │
│         (根据 TERMINAL_ENV 配置选择后端)           │
└────────────┬─────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────┐
│            BaseEnvironment (ABC)                  │
│  execute() → _wrap_command() → _run_bash()       │
│  _wait_for_process() → _update_cwd()             │
│  init_session() / _before_execute() / cleanup()  │
└────────────┬─────────────────────────────────────┘
             │
   ┌─────────┼─────────┬───────────┬──────────┬──────────┬───────────┐
   │         │         │           │          │          │           │
   ▼         ▼         ▼           ▼          ▼          ▼           ▼
Local   Docker   Singularity   SSH      Modal     Managed     Daytona
                 (bind-mount)  (file     (SDK +    Modal       (SDK +
                                          sync)    file       file
                                                   sync)      sync)
```

### 关键设计模式

1. **Spawn-per-call 模型**：每次命令执行都启动新进程，而非复用长连接 shell
2. **会话快照**：初始化时捕获 login shell 环境（env vars、functions、aliases），后续命令执行前先 `source` 快照
3. **CWD 标记追踪**：命令末尾注入 `__HERMES_CWD_<session>__<path>__HERMES_CWD_<session>__` 标记，从输出中解析并剔除
4. **_ThreadedProcessHandle 适配器**：SDK 后端（Modal、Daytona）无真实子进程，通过线程包装暴露统一 `ProcessHandle` 接口
5. **FileSyncManager**：远程后端（SSH、Modal、Daytona）需在命令执行前同步本地文件到沙箱

---

## 2. 各后端对比表

| 特性 | Local | Docker | Singularity | SSH | Modal (Direct) | Managed Modal | Daytona |
|------|-------|--------|-------------|-----|-----------------|---------------|---------|
| **执行方式** | 本地 Popen | docker exec | apptainer exec | ssh bash | Modal SDK (async) | HTTP API (Gateway) | Daytona SDK |
| **进程模型** | Popen | Popen | Popen | Popen | _ThreadedProcessHandle | 自定义 poll 循环 | _ThreadedProcessHandle |
| **stdin 模式** | pipe | pipe | pipe | pipe | heredoc | payload | heredoc |
| **文件同步** | 不需要 | 不需要 (bind-mount) | 不需要 (bind-mount) | FileSyncManager | FileSyncManager | 不支持 | FileSyncManager |
| **CWD 追踪** | 文件读取 | 输出标记 | 输出标记 | 输出标记 | 输出标记 | 服务端管理 | 输出标记 |
| **持久文件系统** | N/A | bind-mount | overlay 目录 | 天然持久 | snapshot_filesystem | 服务端管理 | stop/resume |
| **安全隔离** | 无 | cap-drop ALL | --containall --no-home | SSH 认证 | 云沙箱 | 云沙箱 | 云沙箱 |
| **资源限制** | 无 | CPU/Memory/Disk | CPU/Memory | 无 | SDK 配置 | API 配置 | CPU/Memory/Disk |
| **连接复用** | N/A | 容器常驻 | 实例常驻 | ControlMaster | 沙箱常驻 | HTTP 连接 | 沙箱常驻 |
| **凭证透传** | env 过滤 | -e + bind-mount | --bind | SCP | Mount.from_local | ❌ 不支持 | SDK upload |
| **进程终止** | SIGTERM 进程组 | docker stop | instance stop | SSH close | sandbox.terminate | POST /terminate | sandbox.stop |

---

## 3. 关键流程分析

### 3.1 BaseEnvironment.execute() 完整流程

```
execute(command, cwd, timeout, stdin_data)
  │
  ├─ _before_execute()          ← 文件同步钩子（SSH/Modal/Daytona override）
  │
  ├─ _prepare_command()         ← sudo 密码注入
  │
  ├─ stdin 合并与 heredoc 嵌入
  │
  ├─ _wrap_command()            ← 生成完整 bash 脚本
  │    ├─ source snapshot       （如果 _snapshot_ready）
  │    ├─ cd <cwd>
  │    ├─ eval '<escaped_cmd>'
  │    ├─ export -p > snapshot  （环境重导出）
  │    ├─ pwd > cwd_file        （本地 CWD 文件写入）
  │    └─ printf CWD marker     （远程 CWD 标记输出）
  │
  ├─ _run_bash(wrapped)         ← 子类实现
  │
  ├─ _wait_for_process()        ← 轮询 + 活动回调 + 中断检测
  │
  └─ _update_cwd()              ← 本地读文件 / 远程解析标记
```

### 3.2 会话快照机制 (init_session)

快照是一个 shell 脚本，包含：
- `export -p` 导出的所有环境变量
- `declare -f | grep -vE '^_[^_]'` 过滤的函数定义（排除私有函数）
- `alias -p` 别名定义
- `shopt -s expand_aliases` 和 `set +e` / `set +u` 安全设置

快照文件路径模板：`{temp_dir}/hermes-snap-{session_id}.sh`

**关键设计决策**：
- 每次命令执行后重导出环境变量（`export -p > snapshot`），实现 last-writer-wins 语义
- 对并发调用是安全的：多个命令同时重导出快照时，最后一个写入者获胜
- 快照失败时回退到 `bash -l` 登录 shell 模式

### 3.3 文件同步策略 (FileSyncManager)

```
FileSyncManager
  │
  ├─ sync(force=False)          ← 每次 _before_execute() 调用
  │    ├─ 频率限制：5秒间隔（除非 force=True 或 HERMES_FORCE_FILE_SYNC=1）
  │    ├─ 检测变更：mtime+size 对比
  │    ├─ 上传变更文件（优先 bulk_upload，回退单文件 upload）
  │    ├─ 删除远端已移除文件
  │    └─ 事务性：全部成功才提交状态，失败回滚
  │
  └─ sync_back()                ← cleanup() 时拉取远端变更
       ├─ 下载远程 .hermes/ 为 tar 归档
       ├─ 解压到暂存目录
       ├─ SHA-256 对比差异文件
       ├─ 仅应用有变更的文件（last-write-wins 冲突策略）
       ├─ SIGINT 保护（延迟信号直到完成）
       ├─ 文件锁（fcntl.LOCK_EX）防止并发网关冲突
       └─ 最多 3 次重试，指数退避（2s, 4s, 8s）
```

**各后端文件同步实现**：

| 后端 | 上传方式 | 下载方式 |
|------|---------|---------|
| SSH | 单文件 SCP / bulk: tar→SSH pipe | SSH+tar |
| Modal (Direct) | 单文件 base64 pipe / bulk: tar.gz→base64→stdin | sandbox.exec(stdout.read) |
| Daytona | 单文件 SDK upload / bulk: multipart POST | tar→SDK download |

**不同步的后端**：
- **Local**：直接访问本地文件系统
- **Docker**：bind-mount 挂载 host 目录
- **Singularity**：bind-mount 挂载 host 目录

### 3.4 后台进程管理 (ProcessRegistry)

ProcessRegistry 是一个线程安全的内存注册表，管理通过 `terminal(background=true)` 启动的后台进程。

**核心架构**：

```
ProcessRegistry (singleton)
  │
  ├─ spawn_local()                ← 本地 Popen / PTY 模式
  │    ├─ subprocess.Popen 模式：标准管道
  │    └─ ptyprocess 模式：交互式 CLI 工具
  │
  ├─ spawn_via_env()              ← 沙箱后端模式
  │    ├─ nohup 命令在沙箱内后台运行
  │    ├─ 输出重定向到沙箱内日志文件
  │    └─ _env_poller_loop 线程轮询日志
  │
  ├─ _reader_loop / _pty_reader_loop  ← 本地输出收集
  │
  └─ 进程生命周期：
       ├─ poll()      ← 状态查询
       ├─ wait()      ← 阻塞等待
       ├─ kill()      ← 终止进程（PTY/Popen/远程 kill）
       ├─ write_stdin() / submit_stdin()  ← 标准输入交互
       └─ close_stdin()  ← 关闭输入流
```

**关键特性**：

1. **输出缓冲**：200KB 滚动窗口，避免内存溢出
2. **Watch 模式**：输出模式匹配 + 通知，带速率限制（8次/10秒窗口），持续过载超45秒自动禁用
3. **PTY 支持**：通过 ptyprocess 支持 Codex/Claude Code 等交互式 CLI
4. **崩溃恢复**：JSON checkpoint 文件，重启后探活恢复 detached 进程
5. **完成通知**：`completion_queue` 队列，CLI/gateway 通过 `notify_on_complete` 配置
6. **会话关联**：`task_id` 和 `session_key` 用于网关重置保护和按任务隔离

**进程完成通知机制（Gateway Watcher）**：

```python
# 当后台进程退出时，_move_to_finished() 检查 notify_on_complete
# 将通知放入 completion_queue
# Gateway 的 watcher 循环消费此队列，触发新的 agent turn

completion_queue.put({
    "type": "completion",
    "session_id": ...,
    "command": ...,
    "exit_code": ...,
    "output": ...,   # 最后 2000 字符
})

# Watch 模式匹配通知：
completion_queue.put({
    "type": "watch_match",
    "pattern": ...,
    "output": ...,
    "suppressed": ...,  # 被速率限制丢弃的匹配数
})
```

### 3.5 Docker 后端安全硬化

Docker 后端实施了严格的安全策略：

```python
_SECURITY_ARGS = [
    "--cap-drop", "ALL",           # 移除所有 Linux capabilities
    "--cap-add", "DAC_OVERRIDE",    # 仅保留：root 写入 bind-mount 目录
    "--cap-add", "CHOWN",           # 包管理器需要 chown
    "--cap-add", "FOWNER",          # 包管理器需要 fowner
    "--security-opt", "no-new-privileges",  # 禁止提权
    "--pids-limit", "256",          # 限制进程数
    "--tmpfs", "/tmp:rw,nosuid,size=512m",   # /tmp 大小限制
    "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
]
```

### 3.6 Modal 环境双模式

Modal 有两种实现模式：

1. **Direct Modal** (`modal.py`)：直接使用 Modal Python SDK，通过 `_AsyncWorker` 事件循环在后台线程运行异步操作
2. **Managed Modal** (`managed_modal.py`)：通过 HTTP API 与工具网关交互，抽象了沙箱生命周期

**Managed Modal 特殊之处**：
- 完全覆盖了 `BaseEnvironment.execute()`——不由基类管理快照、CWD 追踪，而是依赖服务端
- 使用 `_stdin_mode = "payload"` 通过 JSON payload 传递 stdin
- 不支持凭证透传（`_guard_unsupported_credential_passthrough()`）
- 通过轮询模式 `poll_interval=0.25s` 等待命令完成

### 3.7 Singularity/Apptainer 的 SIF 缓存

`_get_or_build_sif()` 将 Docker 引用镜像预编译为 SIF 格式：
- 使用线程锁防止并发构建
- 存储在 `APPTAINER_CACHEDIR` 或 `_get_scratch_dir()`
- 构建失败时回退到 `docker://` URL（更慢但可靠）

---

## 4. 代码质量评估

### 4.1 优点

1. **统一的抽象接口**：`BaseEnvironment` 的 `execute()` → `_run_bash()` 分层设计清晰，新后端只需实现 `_run_bash()` 和 `cleanup()`

2. **健壮的事务性文件同步**：`FileSyncManager.sync()` 的 rollback-on-failure 设计避免了部分同步造成的远程状态不一致

3. **完善的安全模型**：Docker 后端的最小权限原则（cap-drop ALL + 精细 cap-add）是业界最佳实践

4. **进程管理的完备性**：ProcessRegistry 覆盖了本地/远程、pipe/PTY、崩溃恢复等多种场景，watch 模式的速率限制和过载保护设计周到

5. **Profile 隔离**：环境变量过滤（`_HERMES_PROVIDER_ENV_BLOCKLIST` + `_HERMES_FORCE_` 前缀重写）确保敏感凭证不会泄漏到沙箱

6. **CWD 标记的健壮性**：UUID 后缀的会话标记避免多会话冲突，`rfind` 解析策略处理输出中出现意外标记的情况

### 4.2 问题与改进建议

#### P1 — 高优先级

**1. `_ThreadedProcessHandle` 标准输出管线在快速命令时丢失数据**

`_ThreadedProcessHandle` 在 `exec_fn` 完成后才写入管道，但 `_wait_for_process()` 的 drain 线程依赖于实时流。如果 SDK 调用在极短时间内完成，drain 线程可能在 `write_fd` 关闭前就已退出，导致输出为空。

**建议**：在 `_ThreadedProcessHandle` 中添加一个 `_output_ready` 事件，让 `_wait_for_process` 的 drain 线程等待该事件后再开始读取，或在 `exec_fn` 完成后显式 `flush`。

**2. Modal Direct 的 `_AsyncWorker` 线程泄漏风险**

`_AsyncWorker` 在 `__init__` 中启动（第221行），但如果后续初始化失败（如第261行的异常），`_worker.stop()` 在 `finally` 中调用。然而 `_AsyncWorker.stop()` 先停止事件循环再 `join()`，如果事件循环本身有问题，`join(timeout=10)` 超时后线程仍在运行。

**建议**：将 `_AsyncWorker` 改为 context manager（`__enter__`/`__exit__`），确保异常路径中资源被正确清理。

**3. Daytona 的 `_lock` 粒度过粗**

`_before_execute()` 持有的 `_lock` 与 `cleanup()` 共享，在并发 `execute()` 调用时成为瓶颈。更关键的是 `_daytona_bulk_upload` 调用可能耗时较长，在此期间所有 `execute()` 都被阻塞。

**建议**：将 `_ensure_sandbox_ready()` 和 `_sync_manager.sync()` 的锁分离，文件同步不需要与命令执行串行化。

#### P2 — 中优先级

**4. 环境变量过滤构建时机不当**

`_HERMES_PROVIDER_ENV_BLOCKLIST = _build_provider_env_blocklist()` 在模块级执行（第107行），需要导入 `hermes_cli.auth` 和 `hermes_cli.config`。这些模块可能不可用（测试环境、CLI 未安装时），但代码用 `try/except ImportError` 处理了。然而这意味着测试环境中 blocklist 可能为空，允许敏感变量泄漏。

**建议**：将 blocklist 构建推迟到首次使用时（lazy initialization），或在测试 fixture 中显式设置 blocklist。

**5. Docker `_storage_opt_supported()` 的全局缓存竞态**

`_storage_opt_ok` 是模块级全局变量（第166行），在多次调用之间缓存结果。如果 Docker 配置发生变化（如升级存储驱动），缓存不会失效。

**建议**：添加一个 TTL 或显式刷新机制，或将其改为实例级缓存而非模块级。

**6. SSH `_ssh_bulk_upload` 的 symlink staging 可能失败**

第166-170行创建临时目录并用 symlink 映射文件路径。如果源文件路径包含特殊字符或超过路径长度限制，symlink 可能失败。

**建议**：添加错误处理和回退逻辑（单文件 SCP）。

**7. ProcessRegistry 的 `spawn_via_env` 日志轮询效率**

第529行的 2 秒轮询间隔是硬编码的，对短命令引入明显的延迟感知问题。

**建议**：使用指数退避（0.5s → 1s → 2s）或基于命令特征的自适应间隔。

#### P3 — 低优先级 / 代码风格

**8. 类型标注不一致**

- `base.py` 中 `ProcessHandle` 是 `Protocol` 类，但内部使用 `Any` 类型
- `_ThreadedProcessHandle` 没有在 `__init__` 参数中标注 `_ThreadedProcessHandle` 的 `cancel_fn` 类型
- Docker `_docker_executable` 使用 `Optional[str]` 但其他模块使用 `str | None`

**建议**：统一使用 `X | None` 语法（项目已使用 Python 3.10+ 语法），用 `Protocol` 定义替代 `Any`。

**9. 重复的快照存储逻辑**

Modal (`modal.py`) 和 Singularity (`singularity.py`) 都有独立的 `_load_snapshots` / `_save_snapshots` 函数，路径不同但逻辑完全相同。

**建议**：提取到 `base.py` 的 `JsonSnapshotStore` 类，参数化存储路径。

**10. `managed_modal.py` 的超时常量来自环境变量但命名不一致**

第39-41行的超时常量使用 `_request_timeout_env()` helper，但 `_client_timeout_grace_seconds` 是类属性硬编码。这可能导致不一致的行为——运维人员修改环境变量调整了连接/读取超时，但 grace period 不跟随变化。

**建议**：统一配置所有超时参数的来源。

**11. ProcessRegistry 的 `_is_host_pid_alive` 不可靠**

`os.kill(pid, 0)` 只能检查进程是否存在，不能检查它是否是同一个进程。PID 被复用后，`recover_from_checkpoint()` 可能错误地恢复一个不相关的进程。

**建议**：在 checkpoint 中额外存储 PID + start_time（从 `/proc/[pid]/stat` 读取），恢复时做双重校验。

---

## 5. 架构级改进建议

### 5.1 统一 SDK 后端的异步执行模型

当前 Modal Direct 和 Daytona 都使用 `_ThreadedProcessHandle` 在后台线程运行阻塞 SDK 调用，而 Managed Modal 使用完全不同的轮询模式。建议：

1. 将 `_ThreadedProcessHandle` 升级为支持流式输出的版本（添加 `_output_available` 事件）
2. 让 Managed Modal 也使用 `_ThreadedProcessHandle`（将 HTTP 轮询包装进 `exec_fn`）
3. 这样所有后端都通过 `_wait_for_process()` 统一处理输出、中断和超时

### 5.2 文件同步抽象化

当前 SSH、Modal、Daytona 各自实现 `upload_fn`、`delete_fn`、`bulk_upload_fn`、`bulk_download_fn` 四个回调。建议：

1. 定义 `FileSyncTransport` Protocol 接口
2. 各后端只需实现该 Protocol
3. `FileSyncManager` 构造时接收 transport 对象而非四个独立函数

### 5.3 ProcessRegistry 与 Environment 解耦

当前 `spawn_via_env()` 直接调用 `env.execute()` 执行后台命令，将 ProcessRegistry 与 BaseEnvironment 紧密耦合。建议：

1. 在 BaseEnvironment 上添加 `spawn_background()` 方法
2. 各后端自行实现最优的后台执行策略（如 Docker 的 `docker exec -d`）
3. ProcessRegistry 只管理状态，不直接操作环境对象

### 5.4 会话快照的原子性保障

当前 `export -p > snapshot` 在并发场景下可能导致快照文件内容不完整（一个命令正在写入时另一个开始读取）。建议：

1. 写入临时文件后 `mv` 重命名（原子操作）
2. 或使用 `flock` 序列化写入

---

## 6. 关键指标汇总

| 指标 | 值 |
|------|-----|
| BaseEnvironment 核心行数 | ~600 行 |
| 最大后端文件（Docker） | ~578 行 |
| 最小后端文件（Local） | ~314 行 |
| FileSyncManager 行数 | ~393 行 |
| ProcessRegistry 行数 | ~1184 行 |
| 总环境后端代码量 | ~3,800 行 |
| 同步策略后端数 | 3 (SSH, Modal, Daytona) |
| 绑定挂载后端数 | 2 (Docker, Singularity) |
| 本地执行后端数 | 1 (Local) |