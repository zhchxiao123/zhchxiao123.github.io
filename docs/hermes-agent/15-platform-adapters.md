---
title: "Step 15: 平台适配器"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/15-platform-adapters/
---

# 平台适配器深度分析

## 1. 概述

Hermes Gateway 通过平台适配器模式连接 17+ 个即时通讯平台。每个适配器继承自 `BasePlatformAdapter`，实现平台特定的连接、认证、消息收发和媒体处理逻辑。适配器代码总量约 31,000 行，其中 `base.py`（2,164 行）提供共享基础设施，其余文件各自实现平台特定逻辑。

**适配器文件清单：**

| 文件 | 行数 | 平台 |
|------|------|------|
| `base.py` | 2,164 | 基类与共享工具 |
| `feishu.py` | 4,131 | 飞书 |
| `discord.py` | 3,191 | Discord |
| `telegram.py` | 2,914 | Telegram |
| `api_server.py` | 2,436 | HTTP API Server |
| `matrix.py` | 2,216 | Matrix |
| `qqbot.py` | 1,960 | QQ 官方 Bot |
| `weixin.py` | 1,829 | 微信公众号 |
| `slack.py` | 1,695 | Slack |
| `wecom.py` | 1,430 | 企业微信（Bot 模式） |
| `whatsapp.py` | 989 | WhatsApp (Baileys 桥接) |
| `bluebubbles.py` | 918 | BlueBubbles (iMessage) |
| `signal.py` | 825 | Signal |
| `mattermost.py` | 740 | Mattermost |
| `webhook.py` | 672 | Webhook 通用 |
| `email.py` | 625 | Email (IMAP+SMTP) |
| `homeassistant.py` | 449 | Home Assistant |
| `wecom_callback.py` | 401 | 企业微信（回调模式） |
| `sms.py` | 373 | SMS (Twilio) |
| `telegram_network.py` | — | Telegram 网络辅助 |
| `wecom_crypto.py` | — | 企业微信加解密 |
| `helpers.py` | — | 共享辅助函数 |

---

## 2. BasePlatformAdapter 核心接口

### 2.1 抽象方法（子类必须实现）

```python
class BasePlatformAdapter(ABC):
    @abstractmethod
    async def connect(self) -> bool: ...
    
    @abstractmethod
    async def disconnect(self) -> None: ...
    
    @abstractmethod
    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult: ...
    
    @abstractmethod
    def truncate_message(self, text, limit, len_fn=len) -> list[str]: ...
```

### 2.2 可选覆盖方法

```python
    async def edit_message(self, chat_id, message_id, content) -> SendResult:
        # 默认不支持，返回 SendResult(success=False)

    async def send_typing(self, chat_id, metadata=None) -> None:
        # 默认空操作

    async def stop_typing(self, chat_id) -> None:
        # 默认空操作

    async def send_image(self, chat_id, image_url, caption=None, ...) -> SendResult:
        # 默认：将 URL 作为文本消息发送

    async def send_animation(self, chat_id, animation_url, ...) -> SendResult:
        # 默认：委托给 send_image

    async def send_voice(self, chat_id, audio_path, ...) -> SendResult:
        # 默认：委托给 send_document

    async def send_video(self, chat_id, video_url, ...) -> SendResult:
        # 默认：委托给 send_image

    async def send_document(self, chat_id, file_path, ...) -> SendResult:
        # 默认：委托给 send

    async def send_image_file(self, chat_id, file_path, ...) -> SendResult:
        # 默认：委托给 send_image

    async def handle_message(self, event: MessageEvent) -> None:
        # 默认：委托给 self._message_handler
```

### 2.3 关键共享能力

| 能力 | 描述 |
|------|------|
| 媒体缓存 | `cache_image_from_bytes/url`, `cache_audio_from_bytes/url`, `cache_document_from_bytes/url` |
| SSRF 防护 | `is_safe_url()`, `_ssrf_redirect_guard()` |
| 代理支持 | `resolve_proxy_url()`, `proxy_kwargs_for_bot()`, `proxy_kwargs_for_aiohttp()` |
| UTF-16 感知截断 | `utf16_len()`, `_prefix_within_utf16_limit()` |
| 消息合并 | `merge_pending_message_event()` — 照片突发/媒体合并 |
| 消息提取 | `extract_images()` — 从 Markdown/HTML 提取图片 URL |
| 格式化 | `_merge_caption()` — 多图标题合并 |
| 作用域锁 | `acquire_scoped_lock()` — 防止多 profile 复用同一凭证 |
| 错误处理 | `fatal_error_*` 属性 + `_handle_adapter_fatal_error()` 回调 |
| 后台任务管理 | `_background_tasks` 集合 + 清理逻辑 |
| 交付后回调 | `_post_delivery_callbacks` — 延迟到主响应后的回调 |
| 打字暂停 | `_typing_paused` 集合 — 审批等待期间暂停打字指示器 |
| 渠道提示 | `resolve_channel_prompt()` — 每 channel 临时系统提示 |

### 2.4 MessageEvent 数据结构

```python
@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT
    source: SessionSource = None
    raw_message: Any = None
    message_id: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None
    auto_skill: Optional[str | list[str]] = None
    channel_prompt: Optional[str] = None
    internal: bool = False
    timestamp: datetime = field(default_factory=datetime.now)
```

`MessageType` 枚举：`TEXT`, `LOCATION`, `PHOTO`, `VIDEO`, `AUDIO`, `VOICE`, `DOCUMENT`, `STICKER`, `COMMAND`

### 2.5 SendResult 数据结构

```python
@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
```

`retryable=True` 会触发 GatewayRunner 的自动重试逻辑。

---

## 3. 主要适配器核心差异

### 3.1 Telegram (`telegram.py` — 2,914 行)

| 特性 | 实现 |
|------|------|
| **SDK** | `python-telegram-bot` (v20+) |
| **认证** | Bot Token (`TELEGRAM_BOT_TOKEN`) |
| **MAX_MESSAGE_LENGTH** | 4,096（UTF-16 感知） |
| **消息编辑** | ✅ 支持（流式编辑模式） |
| **媒体下载** | 通过 Bot API `getFile` + HTTP 下载 |
| **STT** | 语音消息自动转文字 (OpenAI Whisper) |
| **Vision** | 图片通过 vision 工具描述 |
| **特殊功能** | 回调按钮（审批/模型选择）、消息回复模式 (`reply_to_mode`)、DM Topic 绑定技能、贴纸缓存描述 |
| **格式** | MarkdownV2 转义 |
| **网络** | `TelegramFallbackTransport` — 自动检测回退 IP |
| **作用域锁** | `acquire_scoped_lock("telegram", bot_token)` |

**关键行为：**
- `reply_to_mode`：`"first"` (仅首条回复引用原消息) / `"all"` / `"off"`
- 照片突发合并：多张照片合并为单条消息，避免重复触发 Agent
- 文本突发合并：短时间内的多条文本消息合并为一条（通过 `merge_text=True`）
- 群组权限控制：`allowed_users` / `allowed_groups` 白名单
- 消息去重：`_recent_message_ids` 集合防重复处理
- Telegram 反应（emoji reactions）支持

### 3.2 Discord (`discord.py` — 3,191 行)

| 特性 | 实现 |
|------|------|
| **SDK** | `discord.py` |
| **认证** | Bot Token (`DISCORD_BOT_TOKEN`) |
| **MAX_MESSAGE_LENGTH** | 2,000 |
| **消息编辑** | ✅ 支持 |
| **特殊功能** | Guild 管理、Channel 技能绑定 (`channel_skill_bindings`)、Channel 临时提示 (`channel_prompts`)、审批按钮、线程持久化、Opus 语音编码 |
| **格式** | Discord Markdown (有限) |
| **群组隔离** | 每个 Guild/Channel 可独立配置 |

**关键行为：**
- 自动同步 Slash 命令到 Discord
- `Intents` 管理：按需请求 `members` intent
- 频道发现：枚举所有 text channels 供 `send_message` 工具使用
- 系统消息过滤：忽略 join/leave 等系统事件
- 免费回复模式：`free_response_channels` 中的频道无需 @mention 即可响应

### 3.3 Slack (`slack.py` — 1,695 行)

| 特性 | 实现 |
|------|------|
| **SDK** | `slack_bolt` (aiohttp adapter) |
| **认证** | Bot Token + App Token (Socket Mode) |
| **MAX_MESSAGE_LENGTH** | 39,000 (API 限制 40K) |
| **消息编辑** | ✅ 支持 |
| **特殊功能** | 审批按钮、@mention 检测、线程回复 |
| **格式** | Slack mrkdwn |

### 3.4 飞书 (`feishu.py` — 4,131 行)

| 特性 | 实现 |
|------|------|
| **SDK** | 自实现 HTTP 长轮询 + WebSocket 双模式 |
| **认证** | App ID + App Secret (OAuth2) |
| **MAX_MESSAGE_LENGTH** | 8,000 |
| **消息编辑** | ✅ 支持 (patch API) |
| **特殊功能** | 审批按钮（交互卡片）、富文本消息、群组 onboarding、消息卡片、多租户 tenant key |
| **格式** | 飞书富文本 JSON |
| **配置复杂度** | `FeishuAdapterSettings` 类管理大量配置参数 |

**飞书适配器为什么最复杂（4,131 行）：**
- 双连接模式：长轮询 OR WebSocket
- 交互卡片系统：按钮回调需要 URL 验签、challenge 响应
- 租户密钥管理
- 消息内容需要飞书特有的富文本 JSON 格式
- 群组 onboarding 流程
- 审批按钮使用飞书交互卡片而非简单消息

### 3.5 微信 (`weixin.py` — 1,829 行) + 企微 (`wecom.py` — 1,430 行)

**微信（公众号）特点：**
- 基于 XML 的消息格式（微信服务器推送）
- 需要在 `extra` 中配置 `account_id` + `token`
- 5 秒响应超时（微信服务器等待），长回复需要异步发送
- 不支持消息编辑
- 多行消息使用 `_split_multiline_messages` 拆分发送
- `weixin_network` 模块处理微信服务器验证

**企微（Bot 模式）特点：**
- Webhook Bot 模式，不需要公网服务器
- 支持 Markdown 消息格式
- 回调模式 (`wecom_callback.py`) 需要 corp_id + apps 配置
- `wecom_crypto.py` 实现企微消息加解密（AES-CBC）

### 3.6 QQ Bot (`qqbot.py` — 1,960 行)

| 特性 | 实现 |
|------|------|
| **认证** | App ID + Client Secret (OAuth2) |
| **MAX_MESSAGE_LENGTH** | 4,000 |
| **连接** | WebSocket + HTTP 双模式 |
| **特殊功能** | Markdown 消息、频道/群消息区分、JWT token 管理 |
| **格式** | QQ Markdown 或纯文本 |

### 3.7 Matrix (`matrix.py` — 2,216 行)

| 特性 | 实现 |
|------|------|
| **SDK** | `matrix-nio` |
| **认证** | Access Token + 非加密或 E2EE |
| **MAX_MESSAGE_LENGTH** | 4,000 |
| **特殊功能** | 阅读回执、房间发现、mention 检测 |
| **加密** | 可选端到端加密 |

### 3.8 API Server (`api_server.py` — 2,436 行)

| 特性 | 实现 |
|------|------|
| **框架** | FastAPI + Uvicorn（或纯 HTTP） |
| **认证** | Bearer token / 无认证 |
| **特点** | SSE 流式响应、Cron 管理、会话搜索、Webhook 动态路由 |
| **SSRF 防护** | `is_network_accessible()` 绑定地址检查 |

**API Server 独特功能：**
- `POST /chat`：同步对话
- `GET /chat/stream`：SSE 流式输出
- `POST /chat/cancel`：取消运行中的请求
- `/cron/*`：创建/删除/列出定时任务
- `/sessions/search`：FTS5 全文搜索
- `/webhook/*`：动态 Webhook 路由注册

### 3.9 较小适配器

| 适配器 | 认证方式 | 消息编辑 | 特殊特点 |
|--------|----------|----------|----------|
| **WhatsApp** | Baileys 桥接 | ✅ (桥接支持) | 需要 WhatsApp 桥接进程 |
| **Signal** | signal-cli REST API | ❌ | 无编辑支持，每条消息永久 |
| **BlueBubbles** | 本地服务器 + 密码 | ❌ | iMessage 桥接 |
| **Mattermost** | Bot Token | ✅ | 类似 Slack |
| **Email** | IMAP + SMTP | ❌ | 批量/轮询模式 |
| **SMS** | Twilio API | ❌ | 纯文本，160 字符限制 |
| **Home Assistant** | Long-lived token | ❌ | WebSocket 事件监听 |
| **Webhook** | 自定义密钥 | ❌ | 通用 HTTP 接入 |

---

## 4. 适配器共性模式

### 4.1 可抽象到基类的模式

以下模式在几乎所有适配器中重复出现，适合抽取到 `BasePlatformAdapter`：

1. **消息截断 (`truncate_message`)**
   - 每个适配器都实现了自己的截断逻辑，但核心模式相同：按长度分割 + 保持 Markdown 代码块完整性
   - 当前 `truncate_message` 在 base.py 已有默认实现（1,200+ 行），部分适配器仍自行实现

2. **STT 语音转文字**
   - Telegram、Discord、Slack 等都下载音频 → 调用 Whisper API → 注入文本
   - 可提取为 `async def transcribe_audio(self, audio_path) -> str` 基类方法

3. **Vision 图片描述**
   - 所有媒体适配器都：下载图片 → 缓存本地 → 构造描述文本
   - 可提取为 `async def describe_image(self, image_path, caption) -> str`

4. **消息格式化**
   - 每个适配器都有 `_format_response()` 或类似方法，将 Agent 输出转换为平台格式
   - Markdown → 平台格式（HTML/MarkdownV2/mrkdwn/飞书 JSON）的逻辑高度重复

5. **打字指示器**
   - 大多数适配器实现 `send_typing()` + 后台循环，模式完全一致

6. **审批按钮 (approval buttons)**
   - Telegram、Discord、Slack、飞书都有 `send_exec_approval()` 和 `send_model_picker()`
   - 按钮格式不同但逻辑相同：构建 InlineKeyboard → 发送 → 等待回调

7. **连接/断开生命周期间**
   - `connect()` 中获取锁 → 连接 → 释放锁的模式在多个适配器中重复

### 4.2 平台差异对照表

| 特性 | Telegram | Discord | Slack | 飞书 | 微信 | Matrix |
|------|----------|---------|-------|------|------|--------|
| 消息编辑 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 流式编辑 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 内联按钮 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 图片原生发送 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 语音原生发送 | ✅ | ✅ (Opus) | ✅ | ✅ | ❌ | ✅ |
| 视频原生发送 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 文档原生发送 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 群组权限控制 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 线程/话题支持 | ✅ (Topics) | ✅ (Threads) | ✅ (Threads) | ✅ | ❌ | ✅ |
| 贴纸支持 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 反应/Emoji | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| E2EE | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 5. 代码质量评估

### 5.1 优势

1. **一致的接口设计：** 所有适配器遵循 `connect() → send() → disconnect()` 生命周期，`SendResult` 统一返回格式
2. **优雅降级：** 不支持的功能（`edit_message`、`send_voice` 等）有合理的默认 fallback
3. **安全考量充分：** SSRF 防护（`is_safe_url`）、代理支持、作用域锁、路径遍历防护
4. **并发意识：** `contextvars` 替代 `os.environ`、asyncio task 管理、后台任务清理
5. **重试与容错：** `retryable` 标记、自适应 Flood 控制、平台断连后台重连
6. **飞书适配器：** 4,131 行虽然庞大，但结构清晰，双连接模式（长轮询/WebSocket）设计合理

### 5.2 问题

1. **适配器体量过大：** 飞书 (4,131 行)、Discord (3,191 行)、Telegram (2,914 行) 包含过多平台特定逻辑，缺少子模块拆分
2. **重复代码严重：**
   - 格式化函数在每个适配器中都有变体（`_format_response`, `_escape_mdv2`, `_format_slack_mrkdwn` 等）
   - STT/Vision 预处理逻辑在 Telegram、Discord、Slack 等中近乎重复
   - `send_exec_approval()` 在 6+ 个适配器中几乎完全相同
3. **测试覆盖不均：** 核心适配器（Telegram、Discord）测试较好，但飞书、微信、Matrix 等适配器缺乏单元测试
4. **`base.py` 混杂了过多无关功能：** 图片/音频/文档缓存、SSRF 防护、代理配置等应独立为工具模块
5. **缺少适配器注册/发现机制：** 适配器通过 `run.py` 中的 `if platform == Platform.XXX` 硬编码连接
6. **错误处理不一致：** 部分适配器用 `logger.error` + 返回空结果，部分直接 raise，部分设置 `fatal_error_*`

### 5.3 测试覆盖情况

**测试目录 `tests/gateway/` 有 120+ 个测试文件，覆盖：**

- ✅ 会话管理（`test_session.py`, `test_session_*.py`）
- ✅ 核心适配器功能（Telegram、Discord、Slack、飞书、微信、企微、Signal、Matrix、QQ 等多个 `test_*` 文件）
- ✅ 流式消费器（`test_stream_consumer.py`）
- ✅ 配置加载（`test_config.py`）
- ✅ 重启机制（`test_restart_*.py`）
- ✅ Hook 系统（`test_hooks.py`）
- ✅ 消息去重（`test_message_deduplicator.py`）
- ✅ 渠道发现（`test_channel_directory.py`）
- ✅ 媒体缓存/重试（`test_media_download_retry.py`, `test_document_cache.py`）
- ✅ 配对授权（`test_pairing.py`）
- ✅ PII 脱敏（`test_pii_redaction.py`）
- ✅ API Server（`test_api_server.py` 及子测试）
- ⚠️ 缺少：各适配器的端到端集成测试、并发压力测试

---

## 6. 改进建议

### 6.1 短期（低风险）

1. **提取公共功能到基类或 Mixin：**
   ```python
   # 新增基类方法
   class BasePlatformAdapter(ABC):
       async def transcribe_audio(self, audio_path) -> str: ...
       async def describe_media(self, media_path, media_type, caption) -> str: ...
       def format_approval_buttons(self, command, session_key) -> dict: ...
   ```

2. **适配器注册表替代硬编码 if-elif：**
   ```python
   # gateway/adapter_registry.py
   ADAPTER_MAP = {
       Platform.TELEGRAM: ("gateway.platforms.telegram", "TelegramAdapter"),
       Platform.DISCORD: ("gateway.platforms.discord", "DiscordAdapter"),
       # ...
   }
   ```

3. **将 base.py 中的缓存/SSRF/代理工具提取到 `gateway/media_cache.py`、`gateway/ssrf.py` 等**

### 6.2 中期（中等风险）

4. **适配器子模块拆分：** 大型适配器（飞书、Discord、Telegram）应拆为子包：
   ```
   gateway/platforms/telegram/
   ├── __init__.py      # TelegramAdapter 主类
   ├── formatting.py    # MarkdownV2 格式化
   ├── handlers.py      # 事件处理器
   ├── media.py         # 媒体下载/上传
   └── buttons.py       # 审批按钮/模型选择器
   ```

5. **格式化管道标准化：** 定义 `ContentFormatter` 协议，每个平台只需实现 HTML/Markdown 到平台格式的转换：
   ```python
   class ContentFormatter(Protocol):
       def format_text(self, text: str) -> str: ...
       def format_code_block(self, code: str, lang: str) -> str: ...
       def format_link(self, text: str, url: str) -> str: ...
   ```

6. **审批系统抽取：** `send_exec_approval()` 和 `send_model_picker()` 的结构在多个适配器中几乎完全相同（构建按钮 → 发送 → 等待回调 → 解析结果），可抽取为基类方法 + 平台特定按钮构建器

### 6.3 长期（架构级）

7. **适配器接口版本化：** 当前 `BasePlatformAdapter` 的子类直接依赖大量内部属性（`_pending_messages`, `_auto_tts_disabled_chats` 等），应定义明确的适配器协议（Protocol）而非继承

8. **统一媒体管道：** 所有媒体的下载 → 缓存 → 预处理 → 描述注入 流程应标准化为管道组件：
   ```
   MediaPipeline:
     DownloadStep → CacheStep → TranscribeStep(Voice)
                                → DescribeStep(Image/Video)  
                                → ExtractStep(Document)
     → InjectStep (prepend to text)
   ```

9. **适配器热加载：** 当前所有适配器在启动时全部导入（`from gateway.platforms.telegram import ...`），可改为按需加载以减少启动时间和内存占用

10. **集成测试矩阵：** 建立 CI 矩阵，对每个适配器运行模拟集成测试（mock 平台 API），确保 `send()` → `edit_message()` → 流式消费器 → 截断 的完整路径被覆盖