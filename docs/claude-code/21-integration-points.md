---
title: "步骤 21：外部集成点分析"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/21-integration-points/
---


> 本文档梳理 Claude Code 与所有外部服务/系统的集成关系，涵盖协议、认证、重试策略、错误处理与速率限制。

---

## 1. 集成清单

| # | 服务 | 代码路径 | 协议 | 认证方式 | 数据流向 |
|---|------|----------|------|----------|----------|
| 1 | Anthropic API（第一方） | `src/services/api/client.ts` | HTTPS (REST) | API Key / OAuth Bearer Token | 双向（请求 + 流式响应） |
| 2 | AWS Bedrock | `src/services/api/client.ts` | HTTPS (REST, `@anthropic-ai/bedrock-sdk`) | AWS SigV4 / Bearer Token / Session Token | 双向 |
| 3 | Azure Foundry | `src/services/api/client.ts` | HTTPS (REST, `@anthropic-ai/foundry-sdk`) | API Key / Azure AD DefaultAzureCredential | 双向 |
| 4 | Google Vertex AI | `src/services/api/client.ts` | HTTPS (REST, `@anthropic-ai/vertex-sdk`) | Google Auth Library (ADC / Service Account) | 双向 |
| 5 | OAuth 提供方（Claude.ai / Console） | `src/services/oauth/` | HTTPS (REST) + localhost HTTP | OAuth 2.0 PKCE (Authorization Code Flow) | 入站（token 获取） |
| 6 | MCP 服务器 | `src/services/mcp/` | stdio / SSE / HTTP / WebSocket / SDK | 无 / 自定义 Headers / OAuth (CIMD) / XAA IdP | 双向 |
| 7 | LSP 服务器 | `src/services/lsp/` | stdio (JSON-RPC 2.0) | 无 | 双向 |
| 8 | GrowthBook（功能开关） | `src/services/analytics/growthbook.ts` | HTTPS (REST, remoteEval) | API Key (clientKey) + Auth Headers | 入站（拉取配置） |
| 9 | Datadog（日志遥测） | `src/services/analytics/datadog.ts` | HTTPS (POST) | Client Token (`DD-API-KEY`) | 出站（推送日志） |
| 10 | 第一方事件日志（OTLP） | `src/services/analytics/firstPartyEventLogger.ts` | HTTPS (OTLP HTTP) | API Key | 出站（推送事件） |
| 11 | Sentry（错误上报） | `src/components/SentryErrorBoundary.ts` | — | — | — |
| 12 | VS Code 集成 | `src/services/mcp/vscodeSdkMcp.ts` + `src/bridge/` | WebSocket / SSE / MCP (stdio/sse-ide/ws-ide) | IDE Auth Token / OAuth | 双向 |
| 13 | JetBrains 集成 | `src/utils/jetbrains.ts` + `src/entrypoints/init.ts` | MCP (stdio/sse-ide) | 本地插件发现 | 双向 |
| 14 | Chrome 集成 | `src/utils/claudeInChrome/` | stdio (MCP Server) + Native Messaging + WebSocket Bridge | OAuth Token (bridge) / Native Socket (local) | 双向 |
| 15 | Bridge / Remote Control | `src/bridge/` | WebSocket / SSE + HTTP POST (CCR v1/v2) | OAuth / Worker JWT | 双向 |
| 16 | MCP Proxy（Claude.ai 代管） | `src/services/mcp/claudeai.ts` | HTTPS (SSE) | OAuth Bearer Token | 双向 |

---

## 2. 传输对比表

| 传输机制 | 协议层 | 方向 | 连接模式 | 适用场景 | 心跳/保活 | 序列号 |
|----------|--------|------|----------|----------|-----------|--------|
| **HTTPS REST** | HTTP/1.1+ TLS | 请求-响应 | 短连接（keep-alive） | Anthropic API, OAuth, GrowthBook, Datadog, 1P Event | 无（SDK 管理） | x-client-request-id |
| **SSE (Server-Sent Events)** | HTTP 单向流 | 服务端→客户端 | 长连接 | Bridge v2 读取, MCP SSE | 自动重连 | Last-Event-ID / from_sequence_num |
| **WebSocket** | WS over TLS | 双向 | 长连接 | Bridge v1 (HybridTransport), Chrome Bridge, MCP WS | ping/pong | UUID echo-dedup (BoundedUUIDSet) |
| **stdio** | 进程管道 | 双向 | 子进程生命周期 | MCP stdio 服务器, LSP 服务器, Chrome MCP 子进程 | stdin EOF 检测 | JSON-RPC id |
| **HTTP Stream** (MCP) | HTTP POST + SSE | 双向 | 请求-流式响应 | MCP HTTP 传输 | 无 | JSON-RPC id |
| **In-Process** (内存) | queueMicrotask | 双向 | 同进程 | MCP SDK 服务器 (InProcessTransport) | 无 | JSON-RPC id |
| **SDK Control** | stdin/stdout JSON | 双向 | 父子进程 | SDK MCP 服务器 (SdkControlTransport) | 无 | request_id |
| **Native Messaging** | Chrome NMH Socket | 双向 | 扩展生命周期 | Chrome 集成 (非 bridge 模式) | socket 文件存在性 | 自定义 |
| **CCR v2** | SSE (读) + HTTP POST (写) | 双向 | 长连接 + 请求-响应 | Bridge v2 (env-less) | CCRClient 心跳 (20s 默认) | SSE seq + worker_epoch |

---

## 3. 每集成的认证流

### 3.1 Anthropic API（第一方）

**代码**: `src/services/api/client.ts` → `getAnthropicClient()`

```
认证决策树:

isClaudeAISubscriber()?
├── YES → OAuth Bearer Token
│   ├── accessToken 从 keychain/secureStorage 读取
│   ├── 过期前 5 分钟自动刷新 (checkAndRefreshOAuthTokenIfNeeded)
│   └── 401/403 时 handleOAuth401Error → 强制刷新
└── NO → API Key
    ├── ANTHROPIC_API_KEY 环境变量
    ├── ANTHROPIC_AUTH_TOKEN 环境变量
    ├── apiKeyHelper 外部命令 (configureApiKeyHeaders)
    └── 无 token → Authorization header 为空
```

**自定义 Headers 注入**:
- `ANTHROPIC_CUSTOM_HEADERS` 环境变量（换行分隔的 `Name: Value` 对）
- `x-app: cli` 固定值
- `X-Claude-Code-Session-Id` 会话追踪
- `x-client-request-id` (UUID) 用于超时关联
- `x-anthropic-additional-protection` 受 `CLAUDE_CODE_ADDITIONAL_PROTECTION` 控制

### 3.2 AWS Bedrock

**代码**: `src/services/api/client.ts` (L153-190)

```
认证决策树:

CLAUDE_CODE_USE_BEDROCK=1?
├── AWS_BEARER_TOKEN_BEDROCK 存在?
│   ├── YES → Bearer Token 认证 (skipAuth=true)
│   └── NO → AWS SigV4 认证
│       ├── refreshAndGetAwsCredentials() → 缓存的 accessKeyId + secretAccessKey + sessionToken
│       ├── 403 "security token invalid" → clearAwsCredentialsCache() + 重建客户端
│       └── CredentialsProviderError → clearAwsCredentialsCache() + 重建客户端
└── (不使用 Bedrock)
```

### 3.3 Azure Foundry

**代码**: `src/services/api/client.ts` (L191-220)

```
认证决策树:

CLAUDE_CODE_USE_FOUNDRY=1?
├── ANTHROPIC_FOUNDRY_API_KEY 存在?
│   ├── YES → API Key 认证 (SDK 自动读取)
│   └── NO → Azure AD 认证
│       ├── CLAUDE_CODE_SKIP_FOUNDRY_AUTH=1? → Mock token provider
│       └── DefaultAzureCredential → 自动发现 (env vars / CLI / managed identity)
└── (不使用 Foundry)
```

### 3.4 Google Vertex AI

**代码**: `src/services/api/client.ts` (L221-298)

```
认证决策树:

CLAUDE_CODE_USE_VERTEX=1?
├── CLAUDE_CODE_SKIP_VERTEX_AUTH=1? → Mock GoogleAuth
└── Google Auth Library
    ├── GOOGLE_APPLICATION_CREDENTIALS (服务账户 JSON)
    ├── GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT (项目 ID)
    ├── ANTHROPIC_VERTEX_PROJECT_ID (兜底 projectId)
    ├── refreshGcpCredentialsIfNeeded() → 主动刷新
    └── 401 / "Could not load default credentials" → clearGcpCredentialsCache() + 重建客户端
```

**区域选择优先级**:
1. 模型特定环境变量 (VERTEX_REGION_CLAUDE_3_5_HAIKU 等)
2. CLOUD_ML_REGION
3. 配置默认值
4. us-east5 (硬编码兜底)

### 3.5 OAuth 2.0 (Claude.ai / Console)

**代码**: `src/services/oauth/index.ts` → `OAuthService.startOAuthFlow()`

```
OAuth 2.0 Authorization Code Flow + PKCE:

1. 生成 PKCE 参数
   ├── codeVerifier = base64URL(randomBytes(32))  [crypto.ts]
   ├── codeChallenge = base64URL(SHA256(codeVerifier))
   └── state = base64URL(randomBytes(32))

2. 启动本地 HTTP 服务器
   └── AuthCodeListener → localhost:0/callback  [auth-code-listener.ts]

3. 打开浏览器授权页面
   ├── Console: https://platform.claude.com/oauth/authorize
   ├── Claude.ai: https://claude.com/cai/oauth/authorize (307 → claude.ai)
   └── 参数: client_id, response_type=code, redirect_uri, scope, code_challenge, state

4. 用户授权后回调
   ├── 自动: localhost:{port}/callback?code=AUTH_CODE&state=STATE
   └── 手动: 用户复制 code → 手动粘贴

5. Token 交换 (POST)
   ├── URL: https://platform.claude.com/v1/oauth/token
   ├── Body: grant_type=authorization_code, code, redirect_uri, client_id, code_verifier
   ├── 超时: 15s
   └── 响应: access_token, refresh_token, expires_in, scope

6. Token 刷新 (POST)
   ├── URL: 同上 TOKEN_URL
   ├── Body: grant_type=refresh_token, refresh_token, client_id, scope
   ├── 超时: 15s
   ├── 过期缓冲: 5 分钟 (isOAuthTokenExpired)
   └── 支持 scope 扩展 (ALLOWED_SCOPE_EXPANSIONS)

7. 存储
   ├── accessToken/refreshToken → keychain / secureStorage
   ├── accountUuid/email/orgUuid → globalConfig.oauthAccount
   └── subscriptionType/rateLimitTier → globalConfig
```

**OAuth Scopes**:
| Scope | 用途 |
|-------|------|
| `user:inference` | API 推理调用 (Claude.ai 订阅者) |
| `user:profile` | 读取用户档案 |
| `user:sessions:claude_code` | Claude Code 会话管理 |
| `user:mcp_servers` | MCP 代理服务器访问 |
| `user:file_upload` | 文件上传 |
| `org:create_api_key` | Console API Key 创建 |

### 3.6 MCP 服务器认证

**代码**: `src/services/mcp/auth.ts` + `src/services/mcp/types.ts`

```
MCP 认证矩阵:

传输类型           | 认证方式
-------------------|--------------------------
stdio              | 无 (本地进程信任)
sse                | 自定义 Headers + 可选 OAuth
http               | 自定义 Headers + 可选 OAuth
ws                 | 自定义 Headers (无 OAuth)
sse-ide            | IDE 内部信任
ws-ide             | IDE authToken (可选)
sdk                | In-process 信任
claudeai-proxy     | OAuth Bearer Token (Claude.ai 代管)

MCP OAuth 流 (RFC 标准扩展):
1. 发现: authServerMetadataUrl → GET /.well-known/oauth-authorization-server
2. 注册: Dynamic Client Registration (如支持) 或 CIMD (client_id_metadata_document)
3. 授权: 浏览器 PKCE 流 (类似 OAuth 主流程)
4. 存储: keychain / secureStorage (per-server)
5. 刷新: refreshAuthorization() 自动处理
6. XAA (Cross-App Access): 共享 IdP 连接 → 单点登录跨服务器

特殊处理:
- headersHelper: 外部命令动态获取 headers
- TooManyRequestsError (429): 自动退避
- InvalidGrantError: 清除 token + 重新授权
```

### 3.7 GrowthBook 认证

**代码**: `src/services/analytics/growthbook.ts`

```
认证流:
1. 信任建立 (checkHasTrustDialogAccepted / getSessionTrustAccepted / getIsNonInteractiveSession)
2. 获取 Auth Headers (getAuthHeaders → API Key / OAuth Bearer)
3. 注入 apiHostRequestHeaders (client 创建时一次性设置)
4. 信任变更 → resetGrowthBook() + 重建客户端 (apiHostRequestHeaders 不可更新)
5. 无认证 → 跳过 HTTP 初始化，依赖磁盘缓存

环境:
- clientKey: getGrowthBookClientKey() (SDK 密钥)
- apiHost: https://api.anthropic.com/ (可被 CLAUDE_CODE_GB_BASE_URL 覆盖)
- remoteEval: true (服务端预计算特性值)
```

### 3.8 Datadog 认证

**代码**: `src/services/analytics/datadog.ts`

```
认证: 硬编码 Client Token
├── DD-API-KEY: pubbbf48e6d78dae54bceaa4acf463299bf
├── 端点: https://http-intake.logs.us5.datadoghq.com/api/v2/logs
├── 仅限第一方用户 (getAPIProvider() === 'firstParty')
├── 仅 production 环境 (NODE_ENV === 'production')
└── 无速率限制 (客户端批量 + 定时刷新)
```

### 3.9 Bridge / Remote Control 认证

**代码**: `src/bridge/bridgeConfig.ts` + `src/bridge/codeSessionApi.ts`

```
认证流 (env-less / v2):
1. OAuth → POST /v1/code/sessions → session.id (cse_*)
2. OAuth → POST /v1/code/sessions/{id}/bridge → {worker_jwt, api_base_url, expires_in, worker_epoch}
3. Worker JWT → CCRClient + SSETransport 认证
4. JWT 过期 → createTokenRefreshScheduler → 周期性 POST /bridge (新 JWT + 新 epoch)
5. SSE 401 → 重建 transport (新 /bridge 调用，相同 seq-num)

认证流 (env-based / v1):
1. OAuth → Session-Ingress URL + Work Secret
2. Work Secret → decodeWorkSecret → session_id + ingress_token
3. ingress_token → HybridTransport WebSocket 认证

Auth Header 构建:
├── getAuthToken closure (per-instance, 多会话安全)
└── CLAUDE_CODE_SESSION_ACCESS_TOKEN (进程级, 单会话)

开发覆盖 (ant-only):
├── CLAUDE_BRIDGE_OAUTH_TOKEN
└── CLAUDE_BRIDGE_BASE_URL
```

### 3.10 Chrome 集成认证

**代码**: `src/utils/claudeInChrome/mcpServer.ts`

```
认证流:
1. Bridge 模式 (OAuth 用户):
   ├── bridgeConfig.url: wss://bridge.claudeusercontent.com (prod)
   │                   wss://bridge-staging.claudeusercontent.com (staging)
   │                   ws://localhost:8765 (local)
   ├── getUserId: getGlobalConfig().oauthAccount?.accountUuid
   └── getOAuthToken: getClaudeAIOAuthTokens()?.accessToken
2. Native Messaging 模式 (API Key / 3P 用户):
   ├── Unix Socket: /tmp/claude-mcp-browser-bridge-{user}/{pid}.sock
   └── Windows Named Pipe: \\.\pipe\claude-mcp-browser-bridge-{user}
3. 子进程 MCP Server:
   └── stdio (StdioServerTransport) 由 Chrome 扩展启动
```

### 3.11 VS Code 集成认证

**代码**: `src/services/mcp/vscodeSdkMcp.ts`

```
认证:
├── 传输: sse-ide / ws-ide (IDE 内部)
├── IDE Auth Token: 可选 (ws-ide config 的 authToken 字段)
├── 双向通知:
│   ├── file_updated → VS Code (Claude 编辑文件后通知)
│   ├── experiment_gates → VS Code (功能开关同步)
│   └── log_event ← VS Code (VS Code 事件转发到 Claude 分析)
└── Server 名: 'claude-vscode' (硬编码匹配)
```

### 3.12 JetBrains 集成认证

**代码**: `src/utils/jetbrains.ts`

```
认证: 本地插件发现 (无远程认证)
├── 扫描 JetBrains 插件目录 → 检测 'claude-code-jetbrains-plugin' 目录存在
├── macOS: ~/Library/Application Support/JetBrains/{IDE}/plugins/
├── Linux: ~/.config/JetBrains/ 或 ~/.local/share/JetBrains/
├── Windows: %APPDATA%\JetBrains\{IDE}\plugins\
└── 支持 IDE: PyCharm, IntelliJ, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider 等
```

---

## 4. 每集成的速率限制

### 4.1 Anthropic API 速率限制

**代码**: `src/services/api/withRetry.ts` + `src/services/claudeAiLimits.ts`

| 维度 | 限制 | 检测方式 | 处理策略 |
|------|------|----------|----------|
| 429 (Rate Limit) | 5 小时 / 7 天窗口 | `x-should-retry` header | Claude.ai 订阅者不重试 (Enterprise 例外) |
| 529 (Overloaded) | 连续 3 次后降级 | overloaded_error 消息 | 前台源重试，后台源直接放弃 |
| Overage 限制 | 超额用量关闭 | `anthropic-ratelimit-unified-overage-disabled-reason` | 永久禁用 fast mode |
| 窗口重置 | 5h / 7d | `anthropic-ratelimit-unified-reset` (Unix 时间戳) | 持久模式等待重置 |
| 早期预警 | 90% 用量 / 72% 时间 (5h) | 服务端 `surpassed-threshold` header | 显示警告消息 |

**重试策略详情** (`withRetry`):

| 参数 | 值 |
|------|---|
| 最大重试次数 | 10 (默认) / `CLAUDE_CODE_MAX_RETRIES` 环境变量覆盖 |
| 基础延迟 | 500ms |
| 退避策略 | 指数退避: `min(500 * 2^(attempt-1), 32000) + random*jitter(0~25%)` |
| Retry-After 遵从 | 秒级解析，覆盖指数退避 |
| Fast mode 短重试 | < 20s Retry-After → 保持 fast mode 重试 |
| Fast mode 长重试 | >= 20s → 进入 cooldown (10 分钟最低)，降级标准速度 |
| 持久模式 | 无限重试，最大退避 5 分钟，6 小时硬上限 |
| 心跳间隔 | 30s (持久模式期间保持 stdout 活跃) |
| 连接错误 | ECONNRESET / EPIPE → 禁用 keep-alive + 重建连接 |
| 认证错误 | 401 → handleOAuth401Error + 重建客户端 |
| Token 撤销 | 403 "OAuth token has been revoked" → 强制刷新 |

**529 重试白名单 (前台查询源)**:
- `repl_main_thread`, `sdk`, `agent:*`, `compact`, `hook_agent`, `verification_agent`, `side_question`, `auto_mode`, `bash_classifier`

**不可重试条件**:
- `x-should-retry: false` (5xx 除外，ant 用户)
- Mock rate limit 错误
- 非 API 错误 (无 status code)
- Claude.ai 订阅者遇到 429 (Enterprise 例外)

### 4.2 OAuth Token 交换速率限制

| 参数 | 值 |
|------|---|
| 请求超时 | 15s (硬编码) |
| Token 刷新频率 | 每次请求前检查，过期前 5 分钟刷新 |
| 并发刷新 | 锁机制 (lockfile + 进程级 Promise 去重) |
| 刷新失败处理 | 抛出原始错误 + 记录遥测事件 |

### 4.3 MCP 服务器速率限制

| 参数 | 值 |
|------|---|
| 连接重试 | `reconnectAttempt` + `maxReconnectAttempts` (可配置) |
| OAuth 429 | `TooManyRequestsError` → SDK 自动退避 |
| OAuth 失败 | `InvalidGrantError` → 清除 token + 重新授权流 |
| stdio 超时 | 无内置限制 (子进程生命周期管理) |

### 4.4 LSP 服务器速率限制

| 参数 | 值 |
|------|---|
| ContentModified 重试 | 最多 3 次，指数退避 (500ms, 1s, 2s) |
| 最大重启次数 | 3 (config.maxRestarts, 可配置) |
| 崩溃恢复上限 | config.maxRestarts (默认 3)，超过后拒绝启动 |
| 初始化超时 | config.startupTimeout (可配置) |
| 进程生命周期 | 子进程 stdin/stdout 管理 |

### 4.5 GrowthBook 速率限制

| 参数 | 值 |
|------|---|
| 初始化超时 | 5s (client.init timeout) |
| 刷新间隔 | 外部用户: 6 小时 / Ant 用户: 20 分钟 |
| 磁盘缓存 | `cachedGrowthBookFeatures` (全局配置文件) |
| 环境覆盖 | `CLAUDE_INTERNAL_FC_OVERRIDES` (ant-only, JSON) |
| 配置覆盖 | `/config` Gates 标签页 (ant-only) |

### 4.6 Datadog 速率限制

| 参数 | 值 |
|------|---|
| 批量大小 | 最大 100 条日志/批 |
| 刷新间隔 | 15s (默认) / `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` |
| 网络超时 | 5s |
| 允许事件 | 白名单 (`DATADOG_ALLOWED_EVENTS`，约 40 种事件类型) |
| 基数控制 | MCP 工具名 → "mcp"，模型名 → 规范名或 "other"，版本号截断 |
| 用户分桶 | SHA256 哈希 → 30 个桶 (隐私保护基数控制) |

### 4.7 Bridge / Remote Control 速率限制

| 参数 | 值 |
|------|---|
| CCR 心跳间隔 | 20s (默认) / 可配置 |
| JWT 刷新 | `createTokenRefreshScheduler` → 过期前周期性 POST /bridge |
| SSE 重连预算 | SSETransport 内置指数退避 |
| WebSocket 关闭码 | 4090 (epoch mismatch), 4091 (init failure), 4092 (reconnect exhaustion) |
| 写入批处理 | SerialBatchEventUploader (maxBatchSize=100) |
| Echo 去重 | BoundedUUIDSet (环形缓冲区) |

---

## 5. 错误处理汇总

### 5.1 Anthropic API 错误分类

| 错误类型 | HTTP 状态码 | 处理方式 |
|----------|-----------|----------|
| 认证失败 | 401 | 清除 API Key 缓存 + OAuth 刷新 + 重建客户端 |
| Token 撤销 | 403 (message contains "revoked") | 强制 OAuth 刷新 + 重建客户端 |
| 速率限制 | 429 | 订阅者不重试 (Enterprise 例外) / Retry-After 退避 |
| 过载 | 529 | 前台源重试 (最多 3 次) → 模型降级 |
| 上下文溢出 | 400 (message contains "exceed context limit") | 调整 max_tokens + 重试 |
| Fast Mode 拒绝 | 400 (message contains "not enabled") | 永久禁用 fast mode + 重试 |
| Overage 禁用 | 429 + `overage-disabled-reason` header | 永久禁用 fast mode |
| 连接错误 | ECONNRESET / EPIPE | 禁用 keep-alive + 重建连接 |
| SSL 错误 | 各种 SSL code | 格式化为用户友好消息 + `NODE_EXTRA_CA_CERTS` 建议 |
| 超时 | 408 / ETIMEDOUT | 重试 |
| 服务端错误 | 5xx | 重试 (x-should-retry 遵从) |
| HTML 响应 | CloudFlare 等代理 | 从 `<title>` 提取错误信息 |

### 5.2 OAuth 错误处理

| 场景 | 处理 |
|------|------|
| Token 交换失败 (非 200) | 401 → "Invalid authorization code"；其他 → 状态码消息 |
| Token 刷新失败 | 记录遥测 + 抛出错误 (调用方决定是否登出) |
| 州参数不匹配 | 400 + "Invalid state parameter" (CSRF 保护) |
| 授权码缺失 | 400 + "Authorization code not found" |
| SSL 证书错误 (企业代理) | `getSSLErrorHint()` → `NODE_EXTRA_CA_CERTS` 建议 |
| 自定义 OAuth URL 非白名单 | 抛出 "not an approved endpoint" (FedStart 白名单) |

### 5.3 MCP 错误处理

| 场景 | 处理 |
|------|------|
| 服务器连接失败 | 标记为 `failed` + 错误消息展示 |
| 需要 OAuth | 标记为 `needs-auth` + 触发授权流程 |
| 连接断开 | `pending` 状态 + 自动重连 (reconnectAttempt) |
| OAuth InvalidGrant | 清除 token → 重新授权 |
| OAuth TooManyRequests | 自动退避 |
| 工具执行错误 | 错误传播到用户界面 |
| 服务器禁用 | `disabled` 状态 + 不尝试连接 |

### 5.4 LSP 错误处理

| 场景 | 处理 |
|------|------|
| ContentModified (-32801) | 指数退避重试 (最多 3 次，500ms/1s/2s) |
| 服务器崩溃 | state → 'error' + crashRecoveryCount++ |
| 超过最大崩溃恢复 | 抛出错误 + 拒绝启动 |
| 初始化超时 | 清理子进程 + state → 'error' |
| 请求到不健康服务器 | 抛出 "server is {state}" 错误 |

### 5.5 Bridge 错误处理

| 场景 | 处理 |
|------|------|
| WebSocket 断开 | onClose 回调 → 重新轮询 / 重建 transport |
| Epoch 不匹配 (409) | 关闭 CCR + SSE → 触发 poll 循环重新分发 |
| SSE 重连耗尽 | onClose(4092) → 回退到 poll |
| JWT 过期 | createTokenRefreshScheduler → 主动 POST /bridge |
| Echo 消息 | BoundedUUIDSet 去重 |
| 未知控制请求子类型 | 回复 error + 记录日志 |

---

## 6. 配置环境变量汇总

| 环境变量 | 作用 | 集成 |
|----------|------|------|
| `ANTHROPIC_API_KEY` | 直接 API 密钥 | Anthropic API |
| `ANTHROPIC_AUTH_TOKEN` | Bearer Token (优先于 apiKeyHelper) | Anthropic API |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义 HTTP Headers (换行分隔) | Anthropic API |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 | Anthropic API + GrowthBook |
| `API_TIMEOUT_MS` | 请求超时 (默认 600s) | Anthropic API |
| `CLAUDE_CODE_MAX_RETRIES` | 最大重试次数 (默认 10) | Anthropic API |
| `CLAUDE_CODE_USE_BEDROCK` | 启用 Bedrock | AWS Bedrock |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock Bearer Token | AWS Bedrock |
| `CLAUDE_CODE_USE_FOUNDRY` | 启用 Foundry | Azure Foundry |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API Key | Azure Foundry |
| `CLAUDE_CODE_USE_VERTEX` | 启用 Vertex | Google Vertex AI |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID | Google Vertex AI |
| `CLOUD_ML_REGION` | Vertex 默认区域 | Google Vertex AI |
| `CLAUDE_CODE_OAUTH_CLIENT_ID` | 覆盖 OAuth Client ID | OAuth |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | FedStart OAuth URL (白名单) | OAuth |
| `CLAUDE_CODE_UNATTENDED_RETRY` | 持久重试模式 | Anthropic API |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 额外保护 Header | Anthropic API |
| `CLAUDE_CODE_GB_BASE_URL` | GrowthBook API Host | GrowthBook |
| `CLAUDE_INTERNAL_FC_OVERRIDES` | 功能开关覆盖 (ant-only) | GrowthBook |
| `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` | Datadog 刷新间隔 | Datadog |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | Bridge Token 覆盖 (ant-only) | Bridge |
| `CLAUDE_BRIDGE_BASE_URL` | Bridge URL 覆盖 (ant-only) | Bridge |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | Session Ingress Token | Bridge |
| `LOCAL_BRIDGE` | Chrome 本地 Bridge 模式 | Chrome |
| `CLAUDE_CHROME_PERMISSION_MODE` | Chrome 权限模式 | Chrome |
| `FALLBACK_FOR_ALL_PRIMARY_MODELS` | 529 时所有模型可降级 | Anthropic API |

---

## 7. 架构关系图

```
                         ┌─────────────────────────┐
                         │     Claude Code CLI       │
                         └──────────┬──────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
     ┌──────▼──────┐      ┌────────▼────────┐     ┌───────▼───────┐
     │  API Layer   │      │  Bridge Layer   │     │  MCP Layer   │
     │ (client.ts)  │      │  (bridge/)      │     │  (mcp/)      │
     └──────┬──────┘      └────────┬────────┘     └───────┬───────┘
            │                       │                       │
   ┌────────┼────────┐     ┌───────┼───────┐     ┌─────────┼─────────┐
   │        │        │     │       │       │     │         │         │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ │    ┌──▼──┐  │  ┌──▼──┐ │    ┌──▼──┐  ┌──▼──┐
│1st  │ │AWS  │ │GCP  │ │    │v1   │  │  │v2   │ │    │stdio│  │SSE  │
│Party│ │Bkrk │ │Vtx  │ │    │WS   │  │  │SSE+ │ │    │     │  │     │
│API  │ │     │ │     │ │    │     │  │  │CCR  │ │    │     │  │     │
└─────┘ └─────┘ └─────┘ │    └─────┘  │  └─────┘ │    └─────┘  └─────┘
                         │             │          │
                    ┌────▼────┐  ┌─────▼────┐  ┌──▼───────┐
                    │Session  │  │Code      │  │HTTP/WS   │
                    │Ingress  │  │Session   │  │SDK/IDE   │
                    │(OAuth)  │  │API (JWT) │  │          │
                    └─────────┘  └──────────┘  └──────────┘
                                                   │
                                          ┌───────┼───────┐
                                          │       │       │
                                     ┌────▼──┐ ┌─▼──┐ ┌─▼──────┐
                                     │VSCode │ │JB  │ │Chrome  │
                                     │MCP    │ │MCP │ │MCP     │
                                     └───────┘ └────┘ └────────┘

    ┌────────────────────────────────────────────────────┐
    │              遥测 & 分析层                          │
    │  ┌───────────┐  ┌──────────┐  ┌───────────────┐  │
    │  │ Datadog   │  │ 1P Event │  │ GrowthBook     │  │
    │  │ (Logs)    │  │ (OTLP)   │  │ (Feature Flags)│  │
    │  └───────────┘  └──────────┘  └───────────────┘  │
    └────────────────────────────────────────────────────┘

    ┌────────────────────────────────────────────────────┐
    │              LSP 层                                 │
    │  ┌──────────────────┐  ┌──────────────────────┐   │
    │  │ LSPServerManager │  │ LSPServerInstance     │   │
    │  │ (路由 + 生命周期)  │  │ (单服务器 + 重试)     │   │
    │  └──────────────────┘  └──────────────────────┘   │
    └────────────────────────────────────────────────────┘
```

---

## 8. Sentry 错误上报

**代码**: `src/components/SentryErrorBoundary.ts`

SentryErrorBoundary 是一个 React 错误边界组件，但当前实现极为简化：

- 仅捕获渲染阶段错误，将 `hasError` 设为 `true`
- 错误状态下渲染 `null`（不显示任何内容）
- **未集成 Sentry SDK** — 没有 `Sentry.captureException()` 调用
- 实际错误上报依赖 `logError()` → Datadog / 1P Event Logging 通道
- Sentry 相关的错误分类和上报逻辑分散在以下位置：
  - `src/services/teamMemorySync/secretScanner.ts` — secret 泄露检测
  - `src/components/messages/` — 工具调用错误展示

---

## 9. 关键安全考量

1. **OAuth Token 存储**: 使用 OS keychain / secureStorage (非明文文件)
2. **Worker JWT 不解码**: Bridge JWT 被视为不透明字符串，禁止客户端解码
3. **FedStart 白名单**: `CLAUDE_CODE_CUSTOM_OAUTH_URL` 仅允许特定域名
4. **自定义 OAuth Client ID**: 仅通过 `CLAUDE_CODE_OAUTH_CLIENT_ID` 覆盖 (Xcode 集成等)
5. **MCP OAuth**: 支持 CIMD (Client ID Metadata Document) 避免动态注册
6. **CSRF 保护**: OAuth state 参数验证
7. **PKCE**: 所有 OAuth 流程使用 S256 code_challenge_method
8. **SSL 错误处理**: 企业代理场景提供 `NODE_EXTRA_CA_CERTS` 建议
9. **信任门槛**: GrowthBook 认证需要 workspace trust 已建立
10. **Echo 去重**: Bridge WebSocket 使用 BoundedUUIDSet 防止消息回环