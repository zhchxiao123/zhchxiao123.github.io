---
title: "Step 4: 模型适配层"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/04-model-adapters/
---

# 04 - 模型适配层深度分析

## 概述

Hermes Agent 的模型适配层位于 `agent/` 目录，负责将 Hermes 统一的 OpenAI 风格内部消息格式翻译为各个 LLM Provider 的原生 API 协议，并将响应归一化回 OpenAI `ChatCompletion` 形状以供 `run_agent.py` 消费。同时，该层还管理凭证池、辅助客户端路由、智能模型选择、限流守卫和模型元数据索引。

### 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        run_agent.py (Agent Loop)                  │
│                 统一消费 OpenAI ChatCompletion 形状                │
└──────────────┬───────────────────────────────────┬───────────────┘
               │                                   │
        ┌──────▼──────┐                    ┌────────▼────────┐
        │  主模型调用   │                    │  辅助任务调用     │
        │ (Anthropic/  │                    │ (压缩/摘要/视觉  │
        │  Bedrock/    │                    │  /搜索/技能)     │
        │  Gemini/     │                    └────────┬────────┘
        │  OpenAI SDK) │                             │
        └──────┬──────┘                    ┌──────────▼──────────┐
               │                           │ auxiliary_client.py  │
   ┌───────────▼───────────────┐          │ provider 路由 + 链式 │
   │                           │          │ fallback + call_llm() │
   │  ┌─────────────────────┐  │          └──────────┬──────────┘
   │  │ anthropic_adapter.py│  │                     │
   │  │ bedrock_adapter.py  │  │          ┌──────────▼──────────┐
   │  │ gemini_cloudcode_   │  │          │ credential_pool.py    │
   │  │   adapter.py        │  │          │ 凭证轮转 + OAuth 刷新  │
   │  └─────────────────────┘  │          └──────────┬──────────┘
   │                           │                     │
   └───────────────────────────┘          ┌──────────▼──────────┐
                                        │ smart_model_routing.py│
                                        │ 简单消息→便宜模型     │
                                        └──────────┬──────────┘
                                                   │
                              ┌─────────────────────▼───────────────────┐
                              │                                       │
                    ┌─────────▼────────┐                   ┌─────────▼────────┐
                    │rate_limit_tracker│                   │ nous_rate_guard   │
                    │ 通用限流头解析    │                   │ Nous 专属文件锁    │
                    └─────────────────┘                   └──────────────────┘
                              
                    ┌─────────────────┐                   ┌──────────────────┐
                    │ model_metadata  │                   │   models_dev.py   │
                    │ context_length  │◄──────────────────│  models.dev 注册表 │
                    │ 探测 + 缓存     │                   │  集成 (离线优先)   │
                    └─────────────────┘                   └──────────────────┘
```

---

## 各模块职责详解

### 1. `anthropic_adapter.py` (1,520 行) — Anthropic 适配器

**职责**：将 OpenAI 风格消息/工具/响应翻译为 Anthropic Messages API 格式，并管理 Anthropic 全套认证链路。

**核心功能层**：

| 层 | 功能 | 行数估算 |
|---|---|---|
| 认证 (1-700) | OAuth PKCE 流、Claude Code 凭证读写/刷新、API Key / OAuth / 第三方 Bearer 三路检测 | ~700 |
| 消息转换 (825-1263) | `convert_messages_to_anthropic()` — 系统/用户/助手/工具消息转换、思考块签名管理、角色交替合并、孤立块清理 | ~440 |
| 请求构建 (1266-1451) | `build_anthropic_kwargs()` — thinking/adaptive 配置、采样参数禁用、OAuth mcp_ 前缀、fast mode | ~185 |
| 响应归一化 (1454-1520) | `normalize_anthropic_response()` — text/thinking/tool_use 块提取、stop_reason 映射 | ~66 |

**认证优先级**（`resolve_anthropic_token()`）：
1. `ANTHROPIC_TOKEN` env（Hermes 管理的 OAuth/setup token）
2. `CLAUDE_CODE_OAUTH_TOKEN` env
3. `~/.claude/.credentials.json` Claude Code 凭证文件（支持 refresh）
4. `ANTHROPIC_API_KEY` env（普通 API Key）

**关键设计**：
- **思考块签名管理**：第三方端点（MiniMax 等）无法验证 Anthropic 专属签名 → 全量剥离；直连 Anthropic 仅保留最后一轮助手消息的签名块
- **自适应思考 (Adaptive Thinking)**：4.6+ 模型使用 `type: "adaptive"` + `output_config.effort`；4.7+ 禁止 `temperature/top_p/top_k`；`xhigh` effort 仅 4.7+ 支持
- **OAuth Claude Code 兼容**：自动加 `mcp_` 前缀 + `You are Claude Code` 系统 prompt + 产品名替换

**风险点**：
- `resolve_anthropic_token()` 有 4 层 fallback + Claude Code 凭证刷新，任何一层失败都静默降级，排查困难
- `_write_claude_code_credentials()` 直接操作 `~/.claude/.credentials.json`（非 Hermes 管理的文件），多人 profile 可能冲突
- `convert_messages_to_anthropic()` 过于复杂（~440 行），含 3 遍清理循环（孤立 tool_use → 孤立 tool_result → 角色交替合并），任何新增消息类型都需在此添加处理逻辑

---

### 2. `bedrock_adapter.py` (1,098 行) — AWS Bedrock 适配器

**职责**：通过 AWS Bedrock Converse API 与所有 Bedrock 可用模型交互，绕过 OpenAI 兼容端点，获得完整 Claude 特性（prompt caching、thinking budgets、adaptive thinking）。

**核心功能层**：

| 层 | 功能 |
|---|---|
| 认证 (42-193) | boto3 凭证链检测、区域解析 |
| 消息转换 (251-451) | `convert_messages_to_converse()` / `convert_tools_to_converse()` |
| 响应归一化 (457-698) | `normalize_converse_response()` / `stream_converse_with_callbacks()` |
| 模型发现 (827-988) | `discover_bedrock_models()` — foundation models + inference profiles，1h TTL 缓存 |
| 错误分类 (993-1045) | `classify_bedrock_error()` — context_overflow / rate_limit / overloaded |
| Context 长度表 (1054-1098) | `BEDROCK_CONTEXT_LENGTHS` 静态映射 + 子串匹配查找 |

**关键设计**：
- **双通道路由**：`is_anthropic_bedrock_model()` 判断模型 ID → Claude 模型走 AnthropicBedrock SDK（全特性），非 Claude 走 Converse API
- **流式回调**：`stream_converse_with_callbacks()` 支持 `on_text_delta` / `on_tool_start` / `on_reasoning_delta` / `on_interrupt_check` 四个回调
- **工具拒绝列表**：DeepSeek R1、Stability、embedding 模型不支持 tool_use → 自动剥离工具定义

**风险点**：
- `discover_bedrock_models()` 使用模块级 dict 缓存，在 AWS credential 轮换场景下可能返回过期数据
- `normalize_converse_response()` 用 `SimpleNamespace` 模拟 OpenAI SDK 对象，缺少类型安全保护

---

### 3. `gemini_cloudcode_adapter.py` (764 行) — Gemini CloudCode 适配器

**职责**：将 Hermes 的 OpenAI 风格请求翻译为 Google Cloud Code Assist API 的 `{project, model, user_prompt_id, request}` 封装格式，通过 OAuth PKCE 认证访问 `cloudcode-pa.googleapis.com`。

**核心组件**：

| 组件 | 功能 |
|---|---|
| `GeminiCloudCodeClient` | OpenAI SDK 兼容外观类（`.chat.completions.create()` 接口） |
| `build_gemini_request()` | OpenAI messages → Gemini contents + systemInstruction + toolConfig |
| `_translate_gemini_response()` | Gemini candidates → OpenAI choices |
| `_iter_sse_events()` | SSE 流式解析 |
| `_translate_stream_event()` | 实时流 delta 转换 |

**关键设计**：
- `thoughtSignature: "skip_thought_signature_validator"` 哨兵值，避免 Code Assist 拒绝非自身发起的 functionCall
- 所有请求包裹 `wrap_code_assist_request()` — project + model + user_prompt_id 信封
- OAuth 令牌通过 `agent.google_oauth` 模块获取，project context 懒初始化并缓存
- 流式支持通过 httpx SSE 实现，返回 `_GeminiStreamChunk`（`SimpleNamespace` 子类）模拟 OpenAI `ChatCompletionChunk`

**风险点**：
- Code Assist API 是逆向工程的 undocumented 接口，随时可能变化
- `GeminiCloudCodeClient` 硬编码 900s 超时，对于长时间推理可能不够
- 缺少重试/错误恢复机制——HTTP 错误直接抛出 `CodeAssistError`

---

### 4. `auxiliary_client.py` (2,716 行) — 辅助 LLM 客户端路由

**为何达 2,716 行？** 因为它是整个辅助 LLM 调用的**全能路由中心**，包含：

1. **10+ 条 Provider 解析链**（`_try_openrouter`, `_try_nous`, `_try_codex`, `_try_custom_endpoint`, `_resolve_api_key_provider`, `_try_anthropic` 等），每条都有凭证查找 + base_url 解析 + 特殊处理
2. **3 个 API 格式适配器**（`CodexAuxiliaryClient`、`AnthropicAuxiliaryClient`、普通 OpenAI），含同步 + 异步版本（6 个类）
3. **支付故障自动降级**（`_try_payment_fallback()`）
4. **视觉任务专用路由**（`resolve_vision_provider_client()`）
5. **集中式 LLM 调用 API**（`call_llm()` / `async_call_llm()`）
6. **客户端缓存系统**（`_client_cache` + loop 一致性检测 + FD 泄漏防护）

| 功能区 | 核心函数/类 | 行数估算 |
|---|---|---|
| Codex Responses→Chat 适配器 | `CodexAuxiliaryClient` / `_CodexCompletionsAdapter` | ~210 |
| Anthropic 适配器 | `AnthropicAuxiliaryClient` / `_AnthropicCompletionsAdapter` | ~115 |
| Provider 解析链（10+ 条） | `_try_*` / `_resolve_auto()` | ~250 |
| Central Provider Router | `resolve_provider_client()` | ~390 |
| Public API | `get_text_auxiliary_client()` / `call_llm()` | ~400 |
| 客户端缓存 | `_get_cached_client()` / `shutdown_cached_clients()` | ~200 |
| 视觉路由 | `resolve_vision_provider_client()` | ~100 |
| 支付降级 | `_try_payment_fallback()` / `_is_payment_error()` | ~100 |

**自动检测优先级（文本任务）**：
1. 用户主 Provider（非聚合器如 OpenRouter/Nous）→ 直接使用
2. OpenRouter → Nous Portal → 自定义端点 → Codex OAuth → API-key 提供商 → Anthropic
3. 支付/连接错误 → 自动跳过失败 Provider 尝试下一个

**风险点**：
- `resolve_provider_client()` 超过 390 行，包含 8 种 provider 分支 + 嵌套条件，圈复杂度极高
- `_resolve_auto()` 全局修改 `auxiliary_is_nous` 状态变量，非线程安全
- `call_llm()` 在 ~270 行的 try/except 中处理所有 Provider 的所有错误类型，错误信息可能被吞掉
- 文件承担了太多职责——凭证解析、API 格式适配、客户端生命周期管理、路由决策、缓存——应考虑拆分

**拆分建议**：
- `auxiliary_providers.py` — Provider 解析链 + `resolve_provider_client()`
- `auxiliary_adapters.py` — `CodexAuxiliaryClient` + `AnthropicAuxiliaryClient` + 适配器类
- `auxiliary_cache.py` — 客户端缓存 + 生命周期管理
- `auxiliary_client.py` — 保留公共 API (`call_llm()`, `get_text_auxiliary_client()` 等) + 配置解析

---

### 5. `credential_pool.py` (1,418 行) — 凭证池管理

**职责**：为同一 Provider 管理多凭证的轮转选择、OAuth 令牌刷新、耗尽标记与冷恢复。

**核心数据模型**：

```python
@dataclass
class PooledCredential:
    provider: str
    id: str
    label: str
    auth_type: str       # "oauth" | "api_key"
    priority: int        # 排序优先级
    source: str           # "manual" | "device_code" | "claude_code" | "hermes_pkce" | "env:*"
    access_token: str
    refresh_token: Optional[str]
    # ... 耗尽状态跟踪字段
    # ... OAuth 元数据字段（agent_key, client_id, scope 等）
```

**选择策略**：

| 策略 | 行为 |
|---|---|
| `fill_first` | 按优先级排序，选第一个可用 |
| `round_robin` | 轮转，每次选中后降低其优先级 |
| `random` | 随机选择 |
| `least_used` | 选 `request_count` 最小的 |

**关键机制**：
- **耗尽标记 + 冷却**：429 → 1h 冷却；402/信用耗尽也标记；含 `reset_at` 时间戳的误差优先使用
- **OAuth 刷新**：Anthropic 使用 `refresh_anthropic_oauth_pure()`；Codex 使用 `refresh_codex_oauth_pure()`；Nous 使用 `refresh_nous_oauth_from_state()`
- **跨进程同步**：Anthropic 的 Claude Code 凭证和 Codex 的 `~/.codex/auth.json` 在刷新后会写回外部文件，多 profile/多进程场景下通过文件变化检测避免 `refresh_token_reused` 错误
- **自动播种**：`_seed_from_singletons()` 在 `load_pool()` 时自动从 auth.json / env vars / Claude Code 凭证文件发现并插入凭证
- **软租约**：`acquire_lease()` / `release_lease()` 用于 gateway 并发请求分配

**风险点**：
- `_refresh_entry()` 超过 190 行，含 3 种 Provider 的刷新逻辑 + 双重重试 + 文件同步，极难测试完整路径
- `_seed_from_singletons()` 对 `is_provider_explicitly_configured("anthropic")` 的依赖意味着如果用户只用辅助通道而未显式配置 anthropic，凭证池不会自动播种 Claude Code 令牌（设计如此，但可能令人困惑）
- `CredentialPool` 不是线程安全的——`_lock` 保护 `select()` / `mark_exhausted_and_rotate()` 但不保护 `_refresh_entry()` 中的文件 I/O

---

### 6. `smart_model_routing.py` (195 行) — 智能模型路由

**职责**：对于"简单"用户消息，自动路由到更便宜的模型以节省成本。

**决策逻辑**（`choose_cheap_model_route()`）：

输入消息必须**同时**满足以下全部条件才路由到便宜模型：
1. `routing_config.enabled == true`
2. 长度 ≤ `max_simple_chars`（默认 160）
3. 词数 ≤ `max_simple_words`（默认 28）
4. 行数 ≤ 2（无多行内容）
5. 无代码块（`\` 或 ` ``` `）
6. 无 URL
7. 不含复杂关键词（debug, implement, refactor, traceback, test, cron, docker 等 32 个）

**风险点**：
- 关键词黑名单是硬编码英文，不覆盖其他语言
- 没有学习/自适应机制——不会根据实际结果调整路由决策
- 路由决策与 `resolve_runtime_provider` 耦合——如果运行时解析失败，静默回退到主模型，但不会记录原因

---

### 7. `model_metadata.py` (1,116 行) — 模型元数据

**职责**：解析和缓存 LLM 模型的上下文窗口大小、最大输出 token 数等信息。

**Context Length 解析优先级**（`get_model_context_length()`）：

| 优先级 | 来源 | 缓存 |
|---|---|---|
| 0 | `config.yaml` 显式配置 | — |
| 1 | 持久化磁盘缓存 `~/.hermes/context_length_cache.yaml` | YAML |
| 2 | 自定义端点 `/models` API | 内存 5min |
| 3 | 本地服务器查询（Ollama / LM Studio） | 磁盘 |
| 4 | Anthropic `/v1/models` API | 无 |
| 5 | Bedrock 静态表 | — |
| 6 | Nous → OpenRouter 后缀匹配 | 内存 1h |
| 7 | models.dev Registry | 内存 1h |
| 8 | 硬编码 `DEFAULT_CONTEXT_LENGTHS` | — |
| 9 | 默认 128K | — |

**辅助功能**：
- `detect_local_server_type()` — 探测本地服务器类型（Ollama / LM Studio / vLLM / llama.cpp）
- `query_ollama_num_ctx()` — 查询 Ollama 模型的运行时上下文长度
- `parse_context_limit_from_error()` — 从 API 错误信息中提取上下文限制
- `estimate_tokens_rough()` — 基于 4 字符/token 的粗略估计

**硬编码表**（`DEFAULT_CONTEXT_LENGTHS`）：约 55 个条目，覆盖 Claude / GPT / Gemini / DeepSeek / Llama / Qwen / xAI Grok / MiniMax 等主要模型家族。使用子串匹配（最长键优先），因此需要按长度降序排列。

**风险点**：
- 硬编码表需要持续维护——新模型发布后如果不更新，用户会得到 128K 默认值
- `fetch_model_metadata()` 使用同步 `requests.get()`，在异步上下文中可能阻塞
- `query_ollama_num_ctx()` 的 3s 超时在高负载 Ollama 上可能不够
- `_query_local_context_length()` 嵌套了多层 try/except 静默吞错，调试困难

---

### 8. `models_dev.py` (586 行) — models.dev 注册表集成

**职责**：从 `https://models.dev/api.json` 获取全量模型注册表（4,000+ 模型 / 109+ 提供商），提供模型能力查询。

**数据流**：

```
network fetch ──► 内存缓存 (1h TTL) ──► 磁盘缓存 (~/.hermes/models_dev_cache.json)
                    │
                    ▼
            ProviderInfo / ModelInfo dataclasses
```

**提供的查询接口**：

| 函数 | 用途 |
|---|---|
| `lookup_models_dev_context()` | 查某个 Provider+模型的上下文长度 |
| `get_model_capabilities()` | 查模型的完整能力元数据（reasoning, tools, vision 等） |
| `get_provider_info()` | 查 Provider 信息（名称、API URL、env vars） |
| `list_agentic_models()` | 列出某 Provider 支持工具调用的模型 |

**Provider ID 映射**（`PROVIDER_TO_MODELS_DEV`）：将 Hermes 的 Provider 名（如 `"kimi-coding"`）映射到 models.dev 的 Provider ID（如 `"kimi-for-coding"`）。

**风险点**：
- 磁盘缓存使用 `atomic_json_write()` 但内存缓存没有过期清理机制，长期运行进程可能使用过期数据
- `fetch_models_dev()` 也是同步的，在 gateway 异步上下文中可能阻塞
- `_NOISE_PATTERNS` 用正则过滤模型列表，但规则相对主观

---

### 9. `nous_rate_guard.py` (182 行) — Nous 限流守卫

**职责**：跨会话的 Nous Portal 限流状态共享，防止 429 重试放大。

**机制**：
- `record_nous_rate_limit()` — 解析 `x-ratelimit-reset-requests-1h` / `retry-after` 头写入 `~/.hermes/rate_limits/nous.json`
- `nous_rate_limit_remaining()` — 读取文件，返回剩余秒数；过期时自动删除
- `clear_nous_rate_limit()` — 成功请求后清除状态

**风险点**：
- 文件 I/O 无锁——并发会话可能竞争写入（但 `os.replace()` 原子操作缓解了此问题）
- 默认冷却时间 300s 可能过长或过短，取决于 Nous 的实际限流窗口

---

### 10. `rate_limit_tracker.py` (246 行) — 通用限流追踪器

**职责**：从 Provider 响应头中提取 12 个 `x-ratelimit-*` 标准化头部，提供格式化显示。

**数据模型**：

```
RateLimitState
├── requests_min:  RateLimitBucket  (RPM)
├── requests_hour: RateLimitBucket  (RPH)
├── tokens_min:    RateLimitBucket  (TPM)
└── tokens_hour:   RateLimitBucket  (TPH)

RateLimitBucket
├── limit: int
├── remaining: int
├── reset_seconds: float
└── captured_at: float
```

**输出格式**：
- `format_rate_limit_display()` — 多行终端显示（进度条 + 百分比）
- `format_rate_limit_compact()` — 单行紧凑格式用于 gateway 消息

---

## 适配器接口模式

所有适配器遵循相同的**翻译模式**：

```
OpenAI 格式 (内部) ──► [适配器] ──► Provider 原生格式 ──► API 调用 ──► 原生响应 ──► [适配器] ──► OpenAI 格式 (内部)
```

具体翻译对照：

| 概念 | OpenAI 内部格式 | Anthropic | Bedrock Converse | Gemini CloudCode |
|---|---|---|---|---|
| 系统消息 | `{"role": "system"}` | 独立 `system` 参数 | 独立 `system` 列表 | `systemInstruction` 字段 |
| 工具定义 | `{"function": {"name", "parameters"}}` | `{"name", "input_schema"}` | `{"toolSpec": {"name", "inputSchema"}}` | `{"functionDeclarations": [...]}` |
| 工具调用 | `tool_calls[].function` | `tool_use` content block | `toolUse` content block | `functionCall` part |
| 工具结果 | `{"role": "tool"}` | `tool_result` content block (user role) | `toolResult` content block (user role) | `functionResponse` part (user role) |
| 思考/推理 | `reasoning` / `reasoning_content` | `thinking` / `redacted_thinking` blocks | `reasoningContent` delta | `thought: true` part |
| 停止原因 | `stop` / `tool_calls` / `length` | `end_turn` / `tool_use` / `max_tokens` | `end_turn` / `tool_use` / `max_tokens` | `STOP` / `MAX_TOKENS` / `SAFETY` |

**统一接口特征**：
- 所有适配器的输出都是 `SimpleNamespace` 对象，模拟 OpenAI SDK 的 `.choices[0].message` 结构
- 异步适配器通过 `asyncio.to_thread()` 包装同步调用
- 流式响应通过 SSE 或 SDK 流式接口消费后归一化为完整响应

---

## 代码质量评估

### 问题

1. **`anthropic_adapter.py` — 职责过多**：认证（OAuth PKCE、Claude Code 凭证管理）、消息转换、请求构建、响应归一化全部在一个文件。认证逻辑可独立为 `anthropic_auth.py`。

2. **`auxiliary_client.py` — 上帝文件**：2700+ 行承担凭证解析、API 格式适配、客户端缓存、路由决策、支付降级、视觉路由等 6+ 职责。圈复杂度极高——仅 `resolve_provider_client()` 就有 30+ 分支。

3. **SimpleNamespace 类型不安全**：所有适配器的返回值都用 `SimpleNamespace` 模拟 OpenAI SDK 类型。缺少 pydantic/dataclass 验证，任何字段拼写错误都只在运行时暴露。

4. **`credential_pool.py` `_refresh_entry()` 过长**：超过 190 行，含 3 种 Provider 的刷新逻辑 + 文件同步 + 双重重试。应拆分为 Provider-specific 刷新策略类。

5. **全局可变状态**：
   - `auxiliary_is_nous` 全局变量在 `_resolve_auto()` 中被设置
   - `_model_metadata_cache` / `_models_dev_cache` 等模块级 dict 无过期清理
   - `_bedrock_runtime_client_cache` / `_bedrock_control_client_cache` 无大小限制

### 风险点

1. **OAuth 令牌跨进程冲突**：Anthropic 和 Codex 的 refresh token 是单次使用的。多个 Hermes profile 或 Claude Code CLI 同时刷新时，先刷新者使后者的 token 失效。当前通过文件同步检测缓解，但不是原子操作。

2. **辅助客户端静默降级链**：`_resolve_auto()` 顺次尝试 5+ Provider，任何一个的异常都被 `except Exception: pass` 吞掉。用户可能不知道辅助任务实际跑在了哪个 Provider 上。

3. **`convert_messages_to_anthropic()` 的单向性**：只处理 OpenAI → Anthropic 方向，且包含多遍清理。如果消息格式有新类型（如 `input_audio`），需在此处手动添加处理。

4. **Bedrock 客户端缓存无失效**：`_bedrock_runtime_client_cache` 按区域缓存 boto3 客户端，但 AWS credential 轮换后旧客户端的 session token 可能失效。

5. **模型元数据硬编码陈旧**：`DEFAULT_CONTEXT_LENGTHS` 和 `_ANTHROPIC_OUTPUT_LIMITS` 需要随新模型发布手动更新。Claude Opus 4.7 的 1M context 已添加，但未来版本易遗漏。

---

## 改进建议

### 短期（低风险）

1. **拆分 `auxiliary_client.py`**：将 Provider 解析链（`_try_*` 函数 + `resolve_provider_client()`）提取为 `auxiliary_providers.py`；Codex/Anthropic 适配器类提取为 `auxiliary_adapters.py`；客户端缓存提取为 `auxiliary_cache.py`。

2. **拆分 `anthropic_adapter.py` 认证逻辑**：将 `resolve_anthropic_token()`、`run_hermes_oauth_login_pure()`、`_write_claude_code_credentials()` 等 OAuth/PKCE 函数提取为 `anthropic_auth.py`，让适配器文件聚焦于消息格式翻译。

3. **为 `credential_pool.py` 的刷新逻辑引入策略模式**：

   ```python
   class RefreshStrategy(ABC):
       @abstractmethod
       def refresh(self, entry: PooledCredential) -> Optional[PooledCredential]: ...
   
   class AnthropicRefreshStrategy(RefreshStrategy): ...
   class CodexRefreshStrategy(RefreshStrategy): ...
   class NousRefreshStrategy(RefreshStrategy): ...
   ```

### 中期（中等风险）

4. **引入响应类型 dataclass**：为所有适配器定义统一的响应类型 `LLMResponse`，替代 `SimpleNamespace`：

   ```python
   @dataclass
   class LLMResponse:
       choices: List[LLMChoice]
       usage: LLMUsage
       model: str
       finish_reason: str
   ```

5. **统一模型元数据更新机制**：在 CI 中定期从 models.dev 和 Anthropic API 拉取最新模型列表，自动更新 `DEFAULT_CONTEXT_LENGTHS` 和 `_ANTHROPIC_OUTPUT_LIMITS`。

6. **辅助客户端添加结构化日志**：在 `_resolve_auto()` 的每次 fallback 时记录 provider 名 + 失败原因，而非仅 `logger.debug`。

### 长期（架构级）

7. **适配器注册表模式**：将 `anthropic_adapter.py`、`bedrock_adapter.py`、`gemini_cloudcode_adapter.py` 注册到统一适配器注册表，每个适配器实现标准接口：

   ```python
   class LLMAdapter(ABC):
       @abstractmethod
       def translate_request(self, messages, tools, **kwargs) -> dict: ...
       
       @abstractmethod
       def translate_response(self, response) -> LLMResponse: ...
       
       @abstractmethod
       def detect_context_overflow(self, error) -> bool: ...
   ```

8. **消息格式版本化**：当前所有消息都假设 OpenAI 格式为内部标准。随着 Gemini CloudCode 等非 OpenAI Provider 增多，考虑引入 `InternalMessage` 协议类型，使格式转换显式化且可测试。

9. **`credential_pool.py` 线程安全加固**：将 `_lock` 从 `threading.Lock` 升级为 `threading.RLock`，或将文件 I/O 操作移出锁保护区，或使用 `asyncio.Lock` 在 gateway 异步上下文中使用。