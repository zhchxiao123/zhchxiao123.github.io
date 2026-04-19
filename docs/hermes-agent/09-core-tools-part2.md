---
title: "Step 9: 核心工具实现（下）"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/09-core-tools-part2/
---

# Hermes-Agent 核心工具实现分析（第二批）

## 概述

第二批核心工具涵盖了 MCP 协议客户端、跨平台消息、记忆/待办/澄清基础设施、语音合成与交互、智能家居、定时任务、多代理协作以及技能管理系统。这些工具构成了 Hermes-Agent 的"外延层"——将核心 Agent 能力扩展到外部协议、平台和设备。

| 文件 | 行数 | 职责 |
|------|------|------|
| `mcp_tool.py` | 2,599 | MCP 协议客户端（stdio/HTTP 连接、工具发现、OAuth、Sampling） |
| `mcp_oauth.py` | 526 | MCP OAuth 2.1 PKCE 认证流程 |
| `mcp_oauth_manager.py` | 413 | 全局 OAuth Provider 管理器（去重、磁盘监控） |
| `send_message_tool.py` | 1,304 | 跨13+平台消息发送（Telegram/Discord/Slack/微信等） |
| `memory_tool.py` | 584 | 持久化记忆（MEMORY.md/USER.md） |
| `todo_tool.py` | 277 | 会话内任务列表 |
| `clarify_tool.py` | 141 | 交互式用户澄清 |
| `tts_tool.py` | 1,334 | TTS 语音合成（7种引擎） |
| `voice_mode.py` | 1,017 | 语音模式（录音/播放/STT） |
| `image_generation_tool.py` | 837 | 图像生成（FAL.ai 多模型） |
| `homeassistant_tool.py` | 513 | 智能家居 REST API 控制 |
| `cronjob_tools.py` | 510 | 定时任务管理 |
| `mixture_of_agents_tool.py` | 539 | 多代理混合（MoA）推理增强 |
| `skill_manager_tool.py` | 789 | Agent 创建/编辑技能 |
| `skills_tool.py` | 1,420 | 技能列表/查看/搜索 |
| `skills_hub.py` | 3,053 | 技能 Hub（GitHub/社区源、安装、安全扫描） |
| **合计** | **~13,900** | |

---

## 1. MCP 工具 (`mcp_tool.py` — 2,599行 + OAuth 939行)

### 1.1 核心架构

`mcp_tool.py` 是项目中最复杂的工具文件，原因在于它需要同时处理：

1. **双传输协议**：stdio（子进程）和 HTTP/StreamableHTTP（远程服务器）
2. **异步生命周期管理**：每个服务器在后台 `asyncio.Task` 中长驻运行
3. **OAuth 2.1 PKCE 认证**：完整的浏览器授权流程
4. **Sampling 协议**：MCP 服务器反向调用 Agent 的 LLM
5. **动态工具发现**：`notifications/tools/list_changed` 实时更新
6. **熔断器和重连**：指数退避、初始连接重试、Auth 恢复

#### 关键设计决策

**后台事件循环架构**：

```python
_mcp_loop: Optional[asyncio.AbstractEventLoop] = None  # 全局后台事件循环
_mcp_thread: Optional[threading.Thread] = None           # 守护线程
```

所有 MCP 异步操作都在这个专用循环上执行，Agent 主线程通过 `run_coroutine_threadsafe()` 桥接。`_run_on_mcp_loop()` 实现了可中断的轮询等待（每 100ms 检查 `is_interrupted()`），避免用户中断时无限阻塞。

**`MCPServerTask` 类**（`mcp_tool.py:774`）：
- `__slots__` 优化内存占用
- `_ready`/`_shutdown_event`/`_reconnect_event` 三个 `asyncio.Event` 控制生命周期
- `run()` 方法包含完整的重连循环：初始连接失败重试 3 次，运行中断开后指数退避重试 5 次

**熔断器机制**（`mcp_tool.py:1248-1254`）：

```python
_server_error_counts: Dict[str, int] = {}
_CIRCUIT_BREAKER_THRESHOLD = 3
```

连续 3 次失败后短路返回"不可达"消息，防止 Agent 在 90 次迭代预算中反复重试已崩溃的 MCP 工具（问题 #10447）。

### 1.2 安全机制

**凭证脱敏**（`mcp_tool.py:175-187`）：

```python
_CREDENTIAL_PATTERN = re.compile(
    r"(?:"
    r"ghp_[A-Za-z0-9_]{1,255}"       # GitHub PAT
    r"|sk-[A-Za-z0-9_]{1,255}"       # OpenAI key
    r"|Bearer\s+\S+"                  # Bearer token
    r"|token=[^\s&,;\"']{1,255}"    # token=...
    r"|key=[^\s&,;\"']{1,255}"      # key=...
    ...
)
```

所有返回给 LLM 的错误消息都经过 `_sanitize_error()` 处理，防止泄露密钥。

**子进程环境隔离**（`mcp_tool.py:194-210`）：`_build_safe_env()` 仅传递 `PATH`、`HOME` 等 7 个安全环境变量 + `XDG_*` 变量给 stdio 子进程，其余全部剥离。

**MCP 工具描述注入扫描**（`mcp_tool.py:229-271`）：10 种模式检测恶意服务器注入的 prompt override 尝试，仅警告不阻断（避免假阳性）。

**OSV 恶意软件检查**（`mcp_tool.py:946-949`）：stdio 服务器启动前调用 `osv_check.check_package_for_malware()` 扫描 npm 包名。

### 1.3 OAuth 处理

OAuth 系统分布在三个文件中：

| 文件 | 职责 |
|------|------|
| `mcp_oauth.py` (526行) | `HermesTokenStorage`（磁盘持久化）、回调服务器、`build_oauth_auth()` 入口 |
| `mcp_oauth_manager.py` (413行) | `MCPOAuthManager` 单例管理器：Provider 缓存、401 去重、磁盘 mtime 检测 |
| `mcp_tool.py` (集成部分) | `_is_auth_error()`、`_handle_auth_error_and_retry()`、重连信号 |

**认证流程**：
1. 非交互环境抛出 `OAuthNonInteractiveError`
2. 交互环境启动临时 localhost HTTP 服务器捕获 OAuth 回调
3. Token 持久化到 `HERMES_HOME/mcp-tokens/<server>/` 目录
4. 401 时触发 `handle_401()` → 刷新 Token → 设置 `_reconnect_event` → 重建 Session

**`MCPOAuthManager` 关键设计**：
- `_ProviderEntry.pending_401` 字典实现"惊群"去重——同一 access_token 的并发 401 只触发一次恢复
- `last_mtime_ns` 跟踪磁盘 Token 文件的 mtime，检测外部进程刷新
- `HermesMCPOAuthProvider` 子类在每次 auth flow 前检查 mtime 变化

### 1.4 Sampling（服务器请求 LLM）

`SamplingHandler`（`mcp_tool.py:403-767`）使 MCP 服务器能反向调用 Agent 的 LLM：

- 滑动窗口速率限制（`max_rpm`，默认 10/min）
- 模型白名单（`allowed_models`）
- Tool loop 治理（`max_tool_rounds`，默认 5 轮）
- 异步执行：LLM 调用通过 `asyncio.to_thread()` 在线程池中运行，不阻塞事件循环
- 审计日志：采样请求/响应的详细日志

### 1.5 动态工具发现

当 MCP SDK 支持 `message_handler` 时，注册 `_make_message_handler()` 回调。收到 `ToolListChangedNotification` 时：

1. 获取 `_refresh_lock` 防止并发刷新
2. 从服务器重新 `list_tools()`
3. 注销旧工具名
4. 注册新工具
5. 计算差集并记录日志

---

## 2. 消息工具 (`send_message_tool.py` — 1,304行)

### 2.1 跨平台消息发送架构

**支持平台**：Telegram、Discord、Slack、WhatsApp、Signal、Matrix、飞书、企业微信、微信、钉钉、BlueBubbles、QQ Bot、Mattermost、Home Assistant、Email、SMS——共 16 个平台。

**核心路由**：

```
send_message_tool(args) → _handle_send(args)
    → _parse_target_ref()    # 解析 target 格式
    → resolve_channel_name() # 人性化频道名 → ID
    → _send_to_platform()    # 异步分发
        → _send_telegram()   # Telegram 专用路径
        → _send_discord()    # Discord 专用路径
        → _send_slack()      # 各平台独立实现
        → ...
```

**Target 格式**：`platform[:chat_id[:thread_id]]`，例如：
- `telegram` → home channel
- `telegram:-1001234567890:17585` → 特定话题
- `discord:#bot-home` → 人性化频道名（通过 `channel_directory` 解析）

### 2.2 长消息分片

`BasePlatformAdapter.truncate_message()` 复用 Gateway 的分片逻辑：
- 保留代码块边界
- 添加 part 指示器（`[1/3]`、`[2/3]`）
- Telegram 使用 UTF-16 编码长度计算（`utf16_len`）

### 2.3 媒体附件

图片/视频/音频文件通过 `BasePlatformAdapter.extract_media()` 从消息文本中提取路径，然后：
- **Telegram**：使用 Bot API 的 `send_photo`/`send_video`/`send_voice`
- **Discord**：使用 Discord 文件上传
- **Matrix**：通过 adapter 原生上传
- **微信**：原生 one-shot 发送

其他平台发出警告："MEDIA attachments were omitted"。

### 2.4 Cron 去重

`_maybe_skip_cron_duplicate_send()` 检测发送目标是否与 Cron 自动投递目标相同，若是则跳过重复发送。

### 2.5 安全

`_sanitize_error_text()` 使用 `redact_sensitive_text()` + URL 查询参数脱敏 + 通用赋值脱敏（`access_token=***`）三重处理。

---

## 3. 记忆工具 (`memory_tool.py` — 584行)

### 3.1 双存储设计

| 存储 | 文件 | 用途 | 字符限制 |
|------|------|------|----------|
| `memory` | `MEMORY.md` | Agent 的个人笔记（环境事实、项目约定、工具癖好） | 2,200 |
| `user` | `USER.md` | 用户画像（偏好、沟通风格、工作习惯） | 1,375 |

### 3.2 快照冻结机制

```python
def load_from_disk(self):
    self.memory_entries = self._read_file(...)
    self._system_prompt_snapshot = {
        "memory": self._render_block("memory", self.memory_entries),
        "user": self._render_block("user", self.user_entries),
    }
```

`_system_prompt_snapshot` 在会话加载时冻结，此后写入只更新磁盘和内存条目，**不改变系统提示**。这保证了 Anthropic prompt caching 的前缀稳定性。

### 3.3 安全扫描

`_scan_memory_content()` 检查 12 种威胁模式，分为三类：

1. **Prompt 注入**：`ignore previous instructions`、`you are now a`、`system prompt override`
2. **数据渗出**：`curl/wget $KEY`、`cat .env`
3. **隐字符**：零宽空格、方向控制符等 Unicode 隐形字符

### 3.4 文件锁与原子写入

- `_file_lock()` 跨平台（`fcntl`/`msvcrt`）文件锁防止并发写入竞争
- `_write_file()` 使用 `tempfile.mkstemp()` + `os.replace()` 实现原子写入，避免读写竞争

---

## 4. 待办工具 (`todo_tool.py` — 277行)

### 4.1 设计特点

- **纯内存**：不持久化，随会话消失
- **Agent 级拦截**：不在 `handle_function_call()` 中调度，而是 `run_agent.py` 直接拦截（类似 `memory_tool`）
- **上下文压缩保护**：`format_for_injection()` 只注入 `pending` 和 `in_progress` 状态的任务，已完成任务不注入（防止 Agent 在压缩后重做已完成的工作）

### 4.2 操作模式

- `merge=false`：整体替换（默认，用于重新规划）
- `merge=true`：增量更新（按 ID 合并，新 ID 追加）

### 4.3 去重

`_dedupe_by_id()` 保留相同 ID 的最后一条，处理 LLM 可能产生的重复 ID。

---

## 5. 澄清工具 (`clarify_tool.py` — 141行)

最简洁的工具之一——委托模式：工具本身只做校验和格式化，实际的 UI 交互通过 `callback` 参数注入。CLI 使用 `prompt_toolkit` 的可导航选项，Gateway 使用编号列表文本。

关键限制：`MAX_CHOICES = 4`（外加自动追加的 "Other" 选项）。

---

## 6. TTS 工具 (`tts_tool.py` — 1,334行)

### 6.1 引擎架构

采用策略模式的 TTS 引擎选择：

| 引擎 | API Key | 特点 |
|------|---------|------|
| Edge TTS | 免费 | 默认，微软神经网络语音 |
| ElevenLabs | `ELEVENLABS_API_KEY` | 高品质，流式 |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini-tts` |
| MiniMax | `MINIMAX_API_KEY` | 语音克隆，中文优化 |
| Mistral | `MISTRAL_API_KEY` | Voxtral，原生 Opus |
| Google Gemini | `GEMINI_API_KEY` | 30 种预设音色 |
| NeuTTS | 免费 | 本地 TTS，需安装 `neutts_cli` |

### 6.2 输出格式

- **Telegram** → Opus (.ogg)，需 ffmpeg 转码
- **其他平台** → MP3 (.mp3)

### 6.3 配置

从 `~/.hermes/config.yaml` 的 `tts:` 段加载配置，支持逐引擎定制（voice、model、speed 等）。

---

## 7. 语音模式 (`voice_mode.py` — 1,017行)

### 7.1 架构

```
VoiceMode (cli.py 集成)
    ├── AudioRecorder (sounddevice) — 桌面录音
    ├── TermuxAudioRecorder          — Android Termux 录音
    ├── detect_audio_environment()    — 环境检测
    ├── play_beep()                   — 提示音
    └── speak_response()             — TTS + 播放
```

### 7.2 环境检测

`detect_audio_environment()` 系统性检测：
- SSH 会话 → 阻断
- Docker/Podman → 阻断
- WSL → 仅在无 `PULSE_SERVER` 时阻断
- sounddevice 库缺失 → 阻断（除非 Termux 可用）
- Termux → 检测 `termux-microphone-record` + Termux:API App

### 7.3 静音自动停止

`AudioRecorder` 使用 RMS 阈值（默认 200，int16 范围 0-32767）检测静音，支持：
- 语音开始前的呼吸期（`_speech_start_time`）
- 说话中的短暂停顿（`dip` 检测，避免句间停顿触发停止）
- 音量突发（`spike`）重新激活

### 7.4 播放

- 桌面：`sounddevice.play()` + numpy 解码
- Termux：`termux-media-player`
- 其他：系统播放器（`afplay`/`aplay`/`mpv`/`ffplay`）

---

## 8. 图像生成 (`image_generation_tool.py` — 837行)

### 8.1 FAL.ai 多模型目录

`FAL_MODELS` 字典声明了每模型的元数据：

```python
FAL_MODELS = {
    "fal-ai/flux-2/klein/9b": {
        "display": "FLUX 2 Klein 9B",
        "size_style": "image_size_preset",  # 预设尺寸族
        "supports": {"prompt", "image_size", ...},  # 白名单过滤
        "upscale": False,
    },
    ...
}
```

关键设计：
- `size_style` 区分三种尺寸规格族（preset/arbitrary/gpt_literal）
- `supports` 白名单过滤——不支持的参数在提交前被移除
- `upscale` 控制是否链式调用 Clarity Upscaler

### 8.2 工具流程

```
generate_image_tool(args)
    → _resolve_provider()      # FAL / OpenAI / Gemini
    → _generate_with_fal()    # 主路径
    → _build_fal_payload()    # 参数转换
    → fal_client.submit()     # 异步提交
    → 等待结果 → 保存到 cache/gallery
```

---

## 9. 智能家居 (`homeassistant_tool.py` — 513行)

四个工具：`ha_list_entities`、`ha_get_state`、`ha_list_services`、`ha_call_service`。

安全措施：
- **域名黑名单**：`_BLOCKED_DOMAINS` 禁止 `shell_command`、`command_line`、`python_script`、`pyscript`、`hassio`、`rest_command`
- **服务名正则**：`_SERVICE_NAME_RE` 只允许 `[a-z][a-z0-9_]*`，防止 URL 路径遍历
- **实体 ID 正则**：`_ENTITY_ID_RE` 限制格式

---

## 10. 定时任务 (`cronjob_tools.py` — 510行)

- 单一压缩式工具 `cron_manage`（action: create/list/pause/resume/remove/trigger/update）
- Prompt 安全扫描：`_scan_cron_prompt()` 检测注入模式和隐字符
- 来源追踪：`_origin_from_env()` 从环境变量捕获创建者的平台/频道
- 兼容性包装器保留直接 Python 调用接口

---

## 11. 多代理混合 (`mixture_of_agents_tool.py` — 539行)

基于论文 "Mixture-of-Agents Enhances Large Language Model Capabilities" (arXiv:2406.04692v1)：

1. 4 个参考模型并行生成初始响应
2. 聚合模型（默认 `claude-opus-4.6`）合成最终答案
3. `MIN_SUCCESSFUL_REFERENCES = 1`（容错——至少 1 个参考模型成功即可继续）

通过 `agent.auxiliary_client.call_llm` 统一 LLM 调用入口。

---

## 12. 技能系统 (`skill_manager_tool.py` + `skills_tool.py` + `skills_hub.py` — 5,262行)

### 12.1 三模块分工

| 模块 | 职责 |
|------|------|
| `skills_tool.py` (1,420行) | 列表/查看/搜索——读取 SKILL.md 和支持文件 |
| `skill_manager_tool.py` (789行) | 创建/编辑/删除——Agent 主导的技能管理 |
| `skills_hub.py` (3,053行) | Hub 源适配器、下载、安装、安全扫描 |

### 12.2 技能目录结构

```
~/.hermes/skills/
├── my-skill/
│   ├── SKILL.md           # 主文件（YAML frontmatter + Markdown）
│   ├── references/
│   ├── templates/
│   ├── scripts/
│   └── assets/
└── .hub/                  # Hub 状态
    ├── lock.json          # 安装来源追踪
    ├── quarantine/        # 隔离区
    ├── audit.log          # 审计日志
    ├── taps.json          # 添加的额外源
    └── index-cache/       # 远程索引缓存 (1小时 TTL)
```

### 12.3 渐进式披露

遵循 Anthropic 推荐的分层加载：
1. **Tier 1**（元数据）：`skills_list` 返回 name + description（≤1,086 chars）
2. **Tier 2**（完整指令）：`skill_view` 加载 SKILL.md 全文
3. **Tier 3**（链接文件）：`skill_view("name", "references/api.md")` 按需加载

### 12.4 Skills Hub (`skills_hub.py`)

**源适配器架构**：

```
SkillSource (ABC)
    ├── GitHubSource          # GitHub Contents API
    ├── OptionalSkillSource  # 仓库内置可选技能
    └── (未来: ClawHub, Claude Marketplace...)
```

**GitHubAuth**（三优先级认证）：
1. 环境变量 `GITHUB_TOKEN`/`GH_TOKEN`（PAT）
2. `gh auth token` 子进程（gh CLI）
3. GitHub App JWT + Installation Token（App 认证）

**安装流程**：
1. 源适配器 → `SkillBundle`（文件字典）
2. 写入隔离目录 → `skills_guard.scan_skill()` 安全扫描
3. 通过 → 移动到 `~/.hermes/skills/`
4. 不通过 → 移动到隔离区 + 审计日志

**安全扫描** (`skills_guard.py`，928行):
- 路径遍历检测
- 命令注入检测（shell 命令、危险导入）
- 网络渗出检测（curl/wget + 环境变量）
- Prompt 注入检测
- 隐字符检测
- 可信源白名单（`TRUSTED_REPOS`）

**HubLockFile**：`lock.json` 追踪每个技能的来源、版本、安装时间，支持升级检查和来源验证。

---

## 代码质量评估

### 优势

1. **安全优先设计**：MCP 凭证脱敏、子进程环境隔离、Prompt 注入扫描、OSV 恶意软件检查、Skills Guard 安全扫描——每个外部交互点都有防御层
2. **优雅的异步/同步桥接**：`mcp_tool.py` 的 `_run_on_mcp_loop()` 是线程安全的异步调度器，支持中断检测
3. **Profile 感知**：所有路径使用 `get_hermes_home()` 而非硬编码 `~/.hermes`
4. **渐进式降级**：MCP SDK 缺失时为 no-op，语音库缺失时有友好提示，Platform adapter 缺失时优雅失败
5. **原子写入**：`memory_tool.py` 的 `_write_file()` 使用 temp+rename 保证读写一致性
6. **MCP 代码结构清晰**：`MCPServerTask` 封装了完整的连接生命周期，`SamplingHandler` 独立类管理反向 LLM 调用

### 问题与改进建议

#### 高优先级

1. **`mcp_tool.py` 过度膨胀（2,599行）**：
   - `SamplingHandler`（~370行）、`_make_*_handler()` 工厂函数（~230行）、配置加载/工具注册（~400行）可以提取为独立模块
   - 建议拆分：`mcp_client.py`（核心连接）、`mcp_sampling.py`（Sampling）、`mcp_discovery.py`（发现/注册）

2. **`send_message_tool.py` 的平台分发过长**：
   - `_send_to_platform()` 中的 16 分支 if-elif 链（行 493-520）应使用策略映射或插件注册
   - 各平台的 `_send_*()` 函数（Telegram 250+ 行、Discord 100+ 行等）应提取为 `gateway/platforms/` 下的独立模块

3. **`skills_hub.py` 过大（3,053行）**：
   - `GitHubSource` 的搜索/缓存逻辑（~800行）应拆为 `skills_hub_github.py`
   - `HubLockFile` 可独立为 `skills_hub_lock.py`
   - 安装/隔离流程可提取为 `skills_hub_installer.py`

#### 中优先级

4. **`tts_tool.py` 引擎实现模式重复**：7个 `_generate_*()` 函数模式几乎一致（获取配置 → 调API → 写文件），可以用策略类或工厂函数消除重复

5. **`voice_mode.py` 的 `AudioRecorder._stop_threshold` 逻辑**：静音检测的状态机（`_has_spoken`、`_speech_start`、`_dip_start`）复杂且缺乏测试覆盖，建议提取为独立的状态机类

6. **`mcp_oauth.py` + `mcp_oauth_manager.py` 可合并**：526 + 413 = 939 行两文件紧密耦合，`HermesMCPOAuthProvider` 子类定义在 manager 中但依赖 oauth 中的类——合并可减少导入混乱

7. **`memory_tool.py` 的正则威胁模式**：12条正则规则没有单元测试覆盖边界情况（如 `cat .env` 配合 `cat .environment` 的假阳性），建议增加针对性测试

#### 低优先级

8. **`mixture_of_agents_tool.py`**：硬编码了模型列表（`REFERENCE_MODELS`），应从 `models_dev.py` 或配置读取

9. **`homeassistant_tool.py`**：`_BLOCKED_DOMAINS` 和 `_SERVICE_NAME_RE` 应在文档中说明安全理由（当前代码注释简略）

10. **`clarify_tool.py` 的 `MAX_CHOICES = 4`**：硬编码限制，应可配置或至少在 schema 中声明为常量

---

## 总结

第二批核心工具展现了 Hermes-Agent 作为"万能 Agent 框架"的野心——通过 MCP 协议接入外部工具生态，通过 13+ 消息平台触达用户，通过语音/图像/智能家居扩展交互维度。安全设计贯穿始终（凭证脱敏、环境隔离、Prompt 注入扫描、OSV 检查、Skills Guard）。

主要架构优势在于：
- MCP 的后台事件循环 + 线程安全桥接设计非常成熟
- Memory 的快照冻结保证了 prompt caching 的稳定性
- Memory 的原子写入解决了并发安全性

主要技术债在于：
- `mcp_tool.py`（2,599行）、`skills_hub.py`（3,053行）、`send_message_tool.py`（1,304行）三个巨型文件需要拆分
- TTS 引擎实现缺乏抽象层
- 语音静音检测的状态机缺乏独立测试