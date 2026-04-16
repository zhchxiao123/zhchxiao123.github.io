---
title: "Step 11: Bridge 与 IDE 通信系统"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/11-bridge-system/
---


## 概述

Bridge 系统是 Claude Code 与外部客户端（claude.ai 网页端、IDE 插件、Agent SDK）之间的实时通信桥梁。它使得远程用户可以在 claude.ai 上发起会话，由本地运行的 Claude Code CLI 执行工作。系统支持两种拓扑模式：**Standalone Bridge**（独立进程，通过 `claude remote-control` 启动）和 **REPL Bridge**（嵌入式，通过 `/remote-control` REPL 命令或 Agent SDK 守护进程启用）。

---

## 1. 架构总览

### 1.1 两种拓扑模式

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Bridge 双拓扑架构                                │
│                                                                      │
│  ┌──────────────────────┐      ┌──────────────────────────────────┐  │
│  │  Standalone Bridge    │      │  REPL Bridge                    │  │
│  │  (bridgeMain.ts)      │      │  (replBridge.ts)                │  │
│  │                      │      │                                  │  │
│  │  ┌──────────────┐    │      │  ┌────────────────────────────┐  │  │
│  │  │ poll loop    │    │      │  │ env-based (initBridgeCore) │  │  │
│  │  │ pollForWork  │    │      │  │   register → poll → ack    │  │  │
│  │  │ ↓            │    │      │  │   → WebSocket/SSE          │  │  │
│  │  │ sessionRunner│    │      │  └────────────────────────────┘  │  │
│  │  │  spawn child │    │      │  ┌────────────────────────────┐  │  │
│  │  │  Claude Code│    │      │  │ env-less (remoteBridgeCore)│  │  │
│  │  │  process    │    │      │  │   createCodeSession        │  │  │
│  │  │  per work   │    │      │  │   → POST /bridge → JWT     │  │  │
│  │  │  item       │    │      │  │   → SSETransport+CCRClient │  │  │
│  │  └──────────────┘    │      │  └────────────────────────────┘  │  │
│  │                      │      │                                  │  │
│  │  当前进程 ≠ worker    │      │  当前进程 IS worker              │  │
│  └──────────────────────┘      └──────────────────────────────────┘  │
│                                                                      │
│  共享层: bridgeApi.ts / types.ts / jwtUtils.ts / bridgeMessaging.ts │
│          workSecret.ts / replBridgeTransport.ts / trustedDevice.ts  │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 端到端数据流

```
┌─────────┐     ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  IDE /  │     │  claude.ai   │     │  Session-Ingress │     │  Claude Code │
│  Web    │────▶│  / CCR v2    │────▶│  / CCR Worker    │────▶│  CLI (本地)  │
│  Client │     │  Backend     │     │  Endpoints       │     │  (Bridge)    │
└─────────┘     └──────────────┘     └──────────────────┘     └──────────────┘
     │                  │                      │                      │
     │  用户输入 prompt  │                      │                      │
     │─────────────────▶│  dispatch work item  │                      │
     │                  │─────────────────────▶│                      │
     │                  │                      │  pollForWork / SSE   │
     │                  │                      │◀─────────────────────│
     │                  │                      │  ack + connect       │
     │                  │                      │◀─────────────────────│
     │                  │                      │                      │
     │                  │                      │  WebSocket/SSE 双向   │
     │                  │                      │◀───────────────────▶│
     │                  │                      │  (消息流 + 控制信令)  │
     │                  │                      │                      │
     │  展示结果        │                      │                      │
     │◀─────────────────│                      │                      │
```

### 1.3 关键文件一览

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/bridge/bridgeMain.ts` | 2,999 | Standalone Bridge 主循环：poll → spawn → manage → teardown |
| `src/bridge/replBridge.ts` | 2,406 | REPL Bridge env-based 路径：register → createSession → poll → WS |
| `src/bridge/remoteBridgeCore.ts` | 1,008 | REPL Bridge env-less 路径：直接 /code/sessions + /bridge + SSE+CCR |
| `src/bridge/bridgeApi.ts` | 539 | HTTP API 客户端：register/poll/ack/stop/heartbeat/deregister |
| `src/bridge/types.ts` | 262 | 类型定义：WorkResponse, BridgeConfig, SessionHandle 等 |
| `src/bridge/jwtUtils.ts` | 256 | JWT 解码 + 主动 Token 刷新调度器 |
| `src/bridge/sessionRunner.ts` | 550 | 子进程管理：spawn Claude Code child、NDJSON 解析、activity 追踪 |
| `src/bridge/bridgeMessaging.ts` | 462 | 消息路由：ingress 解析、echo 去重、控制请求处理 |
| `src/bridge/replBridgeTransport.ts` | 371 | 传输层抽象：v1 HybridTransport / v2 SSE+CCRClient 适配器 |
| `src/bridge/workSecret.ts` | 128 | Work Secret 解码、SDK URL 构建、Worker 注册 |
| `src/bridge/trustedDevice.ts` | 211 | 可信设备令牌：enrollment + keychain 持久化 |
| `src/bridge/codeSessionApi.ts` | 169 | CCR v2 Code Session API：createCodeSession + fetchRemoteCredentials |
| `src/bridge/envLessBridgeConfig.ts` | 166 | Env-less Bridge 配置（GrowthBook 驱动） |

---

## 2. 消息协议

### 2.1 入站消息（Server → Bridge Worker）

从 Session-Ingress 或 CCR v2 SSE 端点接收的消息类型：

| 消息类型 | `type` 字段 | 用途 | 处理位置 |
|----------|-------------|------|----------|
| 用户消息 | `"user"` | 远程用户发送的 prompt | `bridgeMessaging.ts:191` |
| 控制请求 | `"control_request"` | 服务端发起的控制指令 | `bridgeMessaging.ts:152` |
| 控制响应 | `"control_response"` | 权限决策回复 | `bridgeMessaging.ts:144` |
| 其他 SDK 消息 | `"assistant"`, `"result"` 等 | 回声消息（echo），被过滤 | `bridgeMessaging.ts:160` |

控制请求子类型（`control_request.request.subtype`）：

| subtype | 用途 | 响应 |
|---------|------|------|
| `"initialize"` | 会话初始化握手 | 返回 `{commands, output_style, models, account, pid}` |
| `"can_use_tool"` | 权限检查（远程审批） | 转发给 REPL 的交互式处理器 |
| `"interrupt"` | 中断当前 turn | 调用 `onInterrupt()` |
| `"set_model"` | 切换模型 | 调用 `onSetModel()` |
| `"set_max_thinking_tokens"` | 调整思考预算 | 调用 `onSetMaxThinkingTokens()` |
| `"set_permission_mode"` | 切换权限模式 | 调用 `onSetPermissionMode()` 并返回判决 |

来源: `bridgeMessaging.ts:243-391`

### 2.2 出站消息（Bridge Worker → Server）

通过 WebSocket（v1）或 CCRClient POST（v2）发送的消息类型：

| 消息类型 | 用途 | 发送方式 |
|----------|------|----------|
| `SDKMessage` (user/assistant) | 对话内容 | `transport.writeBatch()` |
| `control_request` | 向服务端请求权限审批 | `transport.write()` |
| `control_response` | 响应服务端的控制请求 | `transport.write()` |
| `control_cancel_request` | 本地已解决权限，取消服务端等待 | `transport.write()` + `reportState('running')` |
| `result` (SDKResultSuccess) | 会话完成通知（用于归档） | `transport.write()` |

来源: `remoteBridgeCore.ts:813-881`, `replBridge.ts:70-81`

### 2.3 消息过滤与去重

```
入站消息
   │
   ▼
┌──────────────────────────┐
│  normalizeControlMessageKeys │  ← 兼容旧格式字段名
│  (controlMessageCompat.ts)  │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  isSDKControlResponse?   │──── 是 ──▶ onPermissionResponse
└──────────┬───────────────┘
           │ 否
           ▼
┌──────────────────────────┐
│  isSDKControlRequest?    │──── 是 ──▶ handleServerControlRequest
└──────────┬───────────────┘
           │ 否
           ▼
┌──────────────────────────┐
│  isSDKMessage?           │──── 否 ──▶ 丢弃
└──────────┬───────────────┘
           │ 是
           ▼
┌──────────────────────────┐
│  recentPostedUUIDs 去重?  │──── 是 ──▶ 忽略回声
└──────────┬───────────────┘
           │ 否
           ▼
┌──────────────────────────┐
│  recentInboundUUIDs 去重? │──── 是 ──▶ 忽略重复投递
└──────────┬───────────────┘
           │ 否
           ▼
┌──────────────────────────┐
│  type === 'user'?        │──── 是 ──▶ onInboundMessage → 注入 REPL
│                          │──── 否 ──▶ 丢弃 (仅转发 user 类型)
└──────────────────────────┘
```

来源: `bridgeMessaging.ts:132-208`

出站消息也经过过滤：`isEligibleBridgeMessage()` 仅允许 `user`、`assistant` 和 `system.subtype === 'local_command'` 消息通过。虚拟消息（`isVirtual`）被排除。

来源: `bridgeMessaging.ts:77-88`

---

## 3. 会话生命周期

### 3.1 完整生命周期

```
                     ┌─────────────────────────────────────────────────┐
                     │                                                 │
  create ──▶ register ──▶ attach ──▶ interact ──▶ detach ──▶ destroy  │
  (会话    (环境     (连接     (双向      (传输      (归档 +    │
   创建)    注册)    传输层)   消息流)    断开)     清理)      │
                     │                                                 │
                     └─────────────────────────────────────────────────┘
```

### 3.2 Standalone Bridge 生命周期 (bridgeMain.ts)

```
1. REGISTER
   POST /v1/environments/bridge
   → {environment_id, environment_secret}
   (bridgeApi.ts:142-197, types.ts:81-115)

2. POLL LOOP
   while (!aborted):
     GET /v1/environments/{id}/work/poll
     → WorkResponse | null
     (bridgeApi.ts:199-247, bridgeMain.ts:600-800)

3. ACKNOWLEDGE
   POST /v1/environments/{id}/work/{workId}/ack
   (bridgeApi.ts:249-271, bridgeMain.ts:~830)

4. SPAWN CHILD
   spawn(execPath, ['--print', '--sdk-url', ..., '--session-id', sessionId])
   env: CLAUDE_CODE_SESSION_ACCESS_TOKEN, CLAUDE_CODE_ENVIRONMENT_KIND=bridge
   (sessionRunner.ts:248-340, bridgeMain.ts:~850)

5. INTERACT
   child stdin  ← control_response / update_environment_variables
   child stdout → NDJSON (assistant/text/tool_use/result)
   child stderr → 错误捕获
   (sessionRunner.ts:335-446)

6. HEARTBEAT
   POST /v1/environments/{id}/work/{workId}/heartbeat
   → {lease_extended, state}
   (bridgeApi.ts:387-417, bridgeMain.ts:202-270)

7. SESSION DONE
   onSessionDone: stopWork + archiveSession + worktree cleanup
   (bridgeMain.ts:442-591)

8. DEREGISTER
   DELETE /v1/environments/bridge/{id}
   (bridgeApi.ts:301-323)
```

### 3.3 REPL Bridge 生命周期 — Env-based (replBridge.ts)

```
1. REGISTER ENVIRONMENT
   api.registerBridgeEnvironment(bridgeConfig)
   → {environment_id, environment_secret}
   (replBridge.ts:318-367)

2. CREATE SESSION
   createSession({environmentId, title, gitRepoUrl, branch})
   → sessionId
   (replBridge.ts:457-477)

3. POLL FOR WORK
   api.pollForWork(environmentId, environmentSecret)
   → WorkResponse | null
   (replBridge.ts:529-537)

4. ON WORK RECEIVED
   decodeWorkSecret → extract JWT + api_base_url
   buildSdkUrl / buildCCRv2SdkUrl
   createV1ReplTransport / createV2ReplTransport
   (replBridge.ts:~900-1100)

5. CONNECT TRANSPORT
   transport.connect()
   → onConnect: flush initial history → drainFlushGate → onStateChange('connected')
   (replBridgeTransport.ts:336-368)

6. BIDIRECTIONAL MESSAGE FLOW
   writeMessages() → filter → dedup → transport.writeBatch()
   setOnData() → handleIngressMessage() → onInboundMessage
   (bridgeMessaging.ts:132-208, replBridge.ts:~1100-1300)

7. RECONNECT (on transport close / env lost)
   Strategy 1: tryReconnectInPlace (same env + session)
   Strategy 2: fresh session (new env + new session)
   (replBridge.ts:605-836)

8. TEARDOWN
   archiveSession → transport.close → deregisterEnvironment
   (replBridge.ts:~1300-1500)
```

### 3.4 REPL Bridge 生命周期 — Env-less / v2 (remoteBridgeCore.ts)

Env-less 路径跳过了 Environments API 层，直接与 /code/sessions 和 /bridge 端点交互：

```
1. CREATE CODE SESSION
   POST /v1/code/sessions {title, bridge: {}}
   → session.id (cse_*)
   (codeSessionApi.ts:26-80, remoteBridgeCore.ts:166-186)

2. FETCH BRIDGE CREDENTIALS
   POST /v1/code/sessions/{id}/bridge
   → {worker_jwt, expires_in, api_base_url, worker_epoch}
   (codeSessionApi.ts:93-168, remoteBridgeCore.ts:188-214)

3. BUILD V2 TRANSPORT
   createV2ReplTransport({sessionUrl, ingressToken: worker_jwt, epoch})
   → SSETransport (reads) + CCRClient (writes)
   (replBridgeTransport.ts:119-370, remoteBridgeCore.ts:216-252)

4. CONNECT
   SSE stream → /v1/code/sessions/{id}/worker/events/stream
   CCRClient → PUT /worker (register), POST /worker/events, PUT /worker/state
   (replBridgeTransport.ts:190-232, 336-368)

5. PROACTIVE TOKEN REFRESH
   createTokenRefreshScheduler: expires_in - 5min → fetchRemoteCredentials → rebuildTransport
   (jwtUtils.ts:72-256, remoteBridgeCore.ts:311-377)

6. 401 RECOVERY
   SSE onClose(401) → recoverFromAuthFailure → OAuth refresh → fresh /bridge → rebuildTransport
   (remoteBridgeCore.ts:529-590)

7. TEARDOWN
   archiveSession → transport.close
   (remoteBridgeCore.ts:664-746)
```

---

## 4. 传输层详解

### 4.1 四种传输协议

```
┌──────────────────────────────────────────────────────────────────────┐
│                        传输层选择矩阵                                │
│                                                                      │
│                    │  读通道 (Server→Worker)  │  写通道 (Worker→Server) │
│  ─────────────────┼────────────────────────┼──────────────────────── │
│  v1 Hybrid        │  WebSocket (ws/wss)     │  HTTP POST             │
│  (HybridTransport)│  Session-Ingress WS     │  Session-Ingress POST  │
│                   │  /v1/session_ingress/   │  /v1/session_ingress/  │
│  ─────────────────┼────────────────────────┼──────────────────────── │
│  v2 SSE + CCR     │  SSE (Server-Sent      │  HTTP POST             │
│  (SSETransport    │  Events)               │  CCR /worker/*         │
│   + CCRClient)    │  /worker/events/stream  │  /worker/events,       │
│                   │                        │  /worker/state,         │
│                   │                        │  /worker/heartbeat     │
│  ─────────────────┼────────────────────────┼──────────────────────── │
│  stdio (spawn)    │  child.stdout (NDJSON) │  child.stdin           │
│  (sessionRunner)  │  解析 activity +       │  control_response      │
│                   │  control_request       │  update_env_vars        │
│  ─────────────────┼────────────────────────┼──────────────────────── │
│  HTTP polling     │  GET /work/poll        │  POST /work/ack        │
│  (bridgeApi)      │  (长轮询，10s timeout)  │  POST /heartbeat       │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 传输层选择逻辑

**Standalone Bridge** 中，子进程的传输协议由 work secret 中的 `use_code_sessions` 字段决定：

```
work.secret → decodeWorkSecret()
  │
  ├─ use_code_sessions = true (或 CLAUDE_BRIDGE_USE_CCR_V2=1)
  │   → buildCCRv2SdkUrl() → createV2ReplTransport()
  │   → 子进程设置: CLAUDE_CODE_USE_CCR_V2=1, CLAUDE_CODE_WORKER_EPOCH
  │
  └─ use_code_sessions = false / undefined
      → buildSdkUrl() → 子进程使用 HybridTransport (v1)
```

来源: `workSecret.ts:41-87`, `sessionRunner.ts:306-323`

**REPL Bridge** 中，env-based 路径在 `onWorkReceived` 回调中做相同判断；env-less 路径始终使用 v2（SSE+CCR）。

### 4.3 ReplBridgeTransport 抽象

`ReplBridgeTransport` 统一了 v1 和 v2 的接口，使 `replBridge.ts` 不必关心底层差异：

```typescript
type ReplBridgeTransport = {
  write(message): Promise<void>           // 单条消息
  writeBatch(messages): Promise<void>     // 批量消息
  close(): void                           // 关闭连接
  connect(): void                         // 建立连接
  setOnData(callback): void               // 入站数据回调
  setOnClose(callback): void              // 连接关闭回调
  setOnConnect(callback): void             // 连接建立回调
  getLastSequenceNum(): number            // SSE 序列号（v1 返回 0）
  reportState(state: SessionState): void  // PUT /worker/state（v2 only）
  reportMetadata(metadata): void          // PUT /worker/external_metadata
  reportDelivery(eventId, status): void   // POST /worker/events/{id}/delivery
  flush(): Promise<void>                  // 排空写队列
}
```

来源: `replBridgeTransport.ts:23-70`

v1 适配器 (`createV1ReplTransport`) 是 HybridTransport 的透传包装；v2 适配器 (`createV2ReplTransport`) 组合 SSETransport（读）和 CCRClient（写 + 心跳 + 状态上报）。

---

## 5. 权限委托模型

### 5.1 架构

```
┌──────────┐      ┌──────────┐      ┌───────────┐      ┌──────────────┐
│  IDE /   │      │  Server  │      │  Bridge   │      │  Claude Code │
│  Web     │      │  (CCR)   │      │  Worker   │      │  CLI Core    │
└────┬─────┘      └────┬─────┘      └─────┬─────┘      └──────┬───────┘
     │                 │                  │                    │
     │  用户点击        │                  │                    │
     │  "Approve"     │                  │                    │
     │───────────────▶│                  │                    │
     │                │  control_response │                    │
     │                │  {behavior:allow} │                    │
     │                │─────────────────▶│                    │
     │                │                  │  转发权限决策        │
     │                │                  │  到子进程/REPL       │
     │                │                  │───────────────────▶│
     │                │                  │                    │
     │                │                  │  control_request   │
     │                │                  │◀───────────────────│
     │                │                  │  (子进程/REPL 请求  │
     │                │                  │   工具权限)         │
     │                │                  │                    │
     │  显示权限提示    │                  │                    │
     │◀───────────────│                  │                    │
     │                │                  │                    │
```

### 5.2 权限请求/响应流程

1. **Claude Code 子进程** 在需要执行受限工具时，通过 stdout 发送 `control_request`（`subtype: 'can_use_tool'`）
2. **Bridge** 解析 NDJSON，检测到 `control_request`（`sessionRunner.ts:417-429`）
3. **Bridge** 通过 transport 转发 `control_request` 到服务端
4. **服务端** 在 IDE/Web 端显示权限提示
5. **用户** 在远程端批准/拒绝
6. **服务端** 发送 `control_response`（`subtype: 'success'`, `response: {behavior: 'allow'}`）
7. **Bridge** 通过 `handleIngressMessage` 接收，调用 `onPermissionResponse`
8. **REPL Bridge** 转发到 REPL 的交互式处理器，工具执行继续

来源: `sessionRunner.ts:33-43`, `bridgeMessaging.ts:144-148`

### 5.3 权限模式的远程切换

服务端可发送 `set_permission_mode` 控制请求。Bridge 调用 `onSetPermissionMode` 回调获取判决：

- `ok: true` → 模式切换成功，返回 `control_response {subtype: 'success'}`
- `ok: false, error: string` → 切换被拒绝，返回 `control_response {subtype: 'error', error}`
- 未注册回调（daemon 上下文）→ 返回错误（避免虚假成功）

来源: `bridgeMessaging.ts:328-359`

### 5.4 Outbound-only 模式

当 `outboundOnly=true` 时，Bridge 仅转发消息到服务端，不接受入站控制：

- 所有可变 `control_request`（`interrupt`、`set_model` 等）返回错误
- `initialize` 仍返回成功（否则服务端会杀死连接）
- 用于 CCR Mirror 模式和 SDK `/bridge` 子路径

来源: `bridgeMessaging.ts:268-283`

---

## 6. 安全机制

### 6.1 认证层级

```
┌─────────────────────────────────────────────────────────────────────┐
│                      安全认证层级                                    │
│                                                                      │
│  Layer 1: OAuth Access Token                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  用于: 环境注册、会话创建、stopWork、deregister、archive       │   │
│  │  来源: /login → keychain 存储                                │   │
│  │  刷新: onAuth401 → handleOAuth401Error → force refresh       │   │
│  │  头部: Authorization: Bearer {oauth_token}                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Layer 2: Session Ingress Token (JWT)                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  用于: poll、ack、heartbeat (env-based)                       │   │
│  │  用于: SSE 读、CCR 写 (v2 /code/sessions)                   │   │
│  │  来源: WorkSecret.session_ingress_token 或 /bridge response  │   │
│  │  格式: sk-ant-si-{base64url-header.payload.signature}        │   │
│  │  有效期: ~4-6 小时 (由 expires_in 指定)                      │   │
│  │  刷新: createTokenRefreshScheduler (过期前 5min)             │   │
│  │  头部: Authorization: Bearer {jwt}                           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Layer 3: Trusted Device Token                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  用于: 注册 Bridge Worker (CCR v2 elevated sessions)         │   │
│  │  来源: POST /auth/trusted_devices → keychain 存储            │   │
│  │  Gate: tengu_sessions_elevated_auth_enforcement              │   │
│  │  头部: X-Trusted-Device-Token: {device_token}                │   │
│  │  有效期: 90 天滚动过期                                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Layer 4: Environment Secret                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  用于: pollForWork 认证 (代替 OAuth，减少 DB 查询)           │   │
│  │  来源: registerBridgeEnvironment 响应                        │   │
│  │  头部: Authorization: Bearer {environment_secret}            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 JWT 主动刷新调度器

`createTokenRefreshScheduler` 是 Bridge 长时间运行的关键机制：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `refreshBufferMs` | 300,000 (5min) | 过期前多久触发刷新 |
| `FALLBACK_REFRESH_INTERVAL_MS` | 1,800,000 (30min) | 刷新后跟进间隔 |
| `MAX_REFRESH_FAILURES` | 3 | 连续失败上限 |
| `REFRESH_RETRY_DELAY_MS` | 60,000 | 获取 token 失败后重试延迟 |

刷新策略：
1. 从 JWT 的 `exp` claim 或服务端 `expires_in` 计算刷新时间
2. 到期前 5 分钟触发 `onRefresh(sessionId, oauthToken)`
3. **Standalone Bridge**: v1 直接写入子进程 stdin（`update_environment_variables`）；v2 调用 `reconnectSession` 触发服务端重新分发
4. **REPL Bridge (env-less)**: 重新调用 `/bridge` 获取新的 `worker_jwt` + `worker_epoch`，然后 `rebuildTransport`
5. 代数计数器（`generations` Map）防止过期异步刷新覆盖新调度

来源: `jwtUtils.ts:72-256`

### 6.3 Work Secret 解码

Work Secret 是服务端在下发工作任务时附带的安全凭据，Base64URL 编码的 JSON：

```typescript
type WorkSecret = {
  version: number                        // 必须为 1
  session_ingress_token: string           // JWT，用于 session 认证
  api_base_url: string                   // Session-Ingress API 基础 URL
  sources: Array<{                       // 代码源信息
    type: string
    git_info?: { type, repo, ref?, token? }
  }>
  auth: Array<{ type, token }>           // 认证凭据
  claude_code_args?: Record<string, string>  // CLI 额外参数
  mcp_config?: unknown                   // MCP 服务器配置
  environment_variables?: Record<string, string>  // 环境变量
  use_code_sessions?: boolean            // v2 传输选择器
}
```

解码流程：`Buffer.from(secret, 'base64url')` → JSON parse → 校验 `version === 1` + `session_ingress_token` 非空 + `api_base_url` 存在

来源: `workSecret.ts:6-32`, `types.ts:33-51`

### 6.4 Trusted Device Token

Bridge 会话在 CCR v2 中具有 `SecurityTier=ELEVATED`。注册 Worker 时需要可信设备令牌：

- **注册**: `POST /auth/trusted_devices` (登录后 10 分钟内有效)
- **存储**: 系统密钥链 (macOS Keychain / Linux secret-storage)
- **读取**: `getSecureStorage().read()?.trustedDeviceToken` (带缓存)
- **发送**: `X-Trusted-Device-Token` HTTP 头
- **Gate**: `tengu_sessions_elevated_auth_enforcement` (CLI 端) + 服务端 enforcement flag
- **环境变量覆盖**: `CLAUDE_TRUSTED_DEVICE_TOKEN` (测试/企业部署用)

来源: `trustedDevice.ts:1-211`

### 6.5 路径遍历防护

所有服务端返回的 ID 在插入 URL 路径前经过校验：

```typescript
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}
```

应用于: `environmentId`, `workId`, `sessionId`

来源: `bridgeApi.ts:40-53`

### 6.6 错误状态码映射

| HTTP 状态码 | BridgeFatalError 类型 | 处理 |
|-------------|----------------------|------|
| 401 | 认证失败 | 尝试 OAuth 刷新 → 重试一次 |
| 403 | 权限拒绝 | 检查是否过期类型 (`environment_expired`) |
| 404 | 未找到 | Remote Control 可能不可用 |
| 410 | 资源过期 | 提示重启 `claude remote-control` |
| 429 | 限流 | 抛出普通 Error (可重试) |
| 5xx | 服务端错误 | 不在 BridgeFatalError 中，可重试 |

来源: `bridgeApi.ts:454-500`

---

## 7. 连接恢复与容错

### 7.1 Standalone Bridge 轮询恢复

```
                    ┌──────────────────────┐
                    │  pollForWork 循环     │
                    └──────────┬───────────┘
                               │
                 ┌─────────────┼─────────────┐
                 │ 成功         │ 失败         │
                 ▼              ▼              │
            ┌─────────┐   ┌────────────┐     │
            │ 有 work  │   │ 连接错误?  │     │
            │ 处理     │   │ (网络)     │     │
            └─────────┘   └──────┬─────┘     │
                               │             │
                    ┌──────────┼──────────┐  │
                    │ 是       │ 否       │  │
                    ▼          ▼          ▼  │
               ┌────────┐  ┌────────┐  ┌────┘
               │conn    │  │general │  │fatal
               │backoff │  │backoff │  │exit
               │2s→120s │  │0.5s→30s│  │
               │10m上限 │  │10m上限 │  │
               └────────┘  └────────┘  └────
```

退避配置 (`BackoffConfig`):

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `connInitialMs` | 2,000 | 连接错误初始退避 |
| `connCapMs` | 120,000 | 连接错误退避上限 |
| `connGiveUpMs` | 600,000 | 连接错误放弃超时 (10min) |
| `generalInitialMs` | 500 | 通用错误初始退避 |
| `generalCapMs` | 30,000 | 通用错误退避上限 |
| `generalGiveUpMs` | 600,000 | 通用错误放弃超时 |

来源: `bridgeMain.ts:59-79`

### 7.2 REPL Bridge 环境重连

当环境丢失（poll 返回 404），replBridge 执行两阶段恢复：

```
环境丢失 (poll 404)
   │
   ▼
Strategy 1: Reconnect-in-place
   │  1. re-register with reuseEnvironmentId
   │  2. 如果返回相同 environmentId → reconnectSession()
   │  3. 同一会话，URL 有效，历史保留
   │
   ├─ 成功 → 恢复，poll 继续获取新 work
   │
   └─ 失败 ↓
       │
       ▼
Strategy 2: Fresh session fallback
   │  1. archiveSession(oldSessionId)
   │  2. createSession(newEnvironmentId)
   │  3. 重置 SSE seq-num, inbound dedup, title derivation
   │  4. writeBridgePointer (crash recovery)
   │
   ├─ 成功 → 新会话，旧 URL 失效
   └─ 失败 → 放弃 (MAX_ENVIRONMENT_RECREATIONS=3)
```

来源: `replBridge.ts:587-836`

### 7.3 Env-less Bridge 的 401 恢复

```
SSE onClose(401) 或 JWT 即将过期
   │
   ▼
authRecoveryInFlight = true  ← 互斥锁，防止 laptop-wake 双触发
   │
   ▼
OAuth token refresh (onAuth401 → getAccessToken)
   │
   ▼
POST /v1/code/sessions/{id}/bridge → fresh {worker_jwt, expires_in, worker_epoch}
   │
   ▼
rebuildTransport(fresh, cause):
   │  1. flushGate.start() — 排队写入
   │  2. transport.close() — 关闭旧传输
   │  3. createV2ReplTransport(fresh) — 用新 JWT + epoch 创建传输
   │  4. wireTransportCallbacks() — 重新注册 onConnect/onData/onClose
   │  5. transport.connect() — 连接，带 SSE from_sequence_num
   │  6. refresh.scheduleFromExpiresIn() — 安排下次刷新
   │  7. drainFlushGate() — 排空排队消息
   │
   ▼
authRecoveryInFlight = false
```

关键设计点：每次 `/bridge` 调用都会 bump server-side epoch。仅交换 JWT 而不重建传输会导致旧 CCRClient 的心跳带有 stale epoch → 409 epoch mismatch。

来源: `remoteBridgeCore.ts:468-527`

---

## 8. Spawn 模式与多会话

### 8.1 三种 Spawn 模式

| SpawnMode | 说明 | 生命周期 |
|-----------|------|----------|
| `single-session` | 单会话，工作目录为 cwd | 会话结束时 Bridge 退出 |
| `worktree` | 多会话，每个会话独立 git worktree | 会话结束后回到 idle |
| `same-dir` | 多会话，共享 cwd（可能冲突） | 会话结束后回到 idle |

来源: `types.ts:64-69`

Gate: `tengu_ccr_bridge_multi_session` (GrowthBook)，默认 `maxSessions=32`

来源: `bridgeMain.ts:83-98`

### 8.2 Worktree 隔离流程

```
pollForWork → 收到新 work item
   │
   ▼
activeSessions.size < maxSessions?
   │
   ├─ 否 → 等待 capacityWake / heartbeat-only poll
   │
   └─ 是 ↓
       │
       ▼
spawnMode === 'worktree'?
   │
   ├─ 是 → createAgentWorktree(cwd) → isolatedDir
   │        spawner.spawn(opts, isolatedDir)
   │        sessionWorktrees.set(sessionId, {worktreePath, worktreeBranch, ...})
   │
   └─ 否 → spawner.spawn(opts, cwd)
```

会话结束后自动清理 worktree: `removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)`

来源: `bridgeMain.ts:176-184`, `536-551`

### 8.3 心跳模式（At-capacity）

当活跃会话数达到上限时，Bridge 进入心跳模式：

```
at capacity → 进入 heartbeat-only 循环:
   │
   │  while (atCapacity && !deadlineReached):
   │    1. heartbeatActiveWorkItems()  ← 延长 work lease
   │    2. sleep(non_exclusive_heartbeat_interval_ms, capacitySignal)
   │
   │  退出原因:
   │    - capacity_changed: 某个会话结束，有容量了
   │    - poll_due: atCapMs 超时，强制 poll
   │    - auth_failed: JWT 过期，需要 poll 刷新 token
   │    - shutdown: 收到退出信号
   │    - config_disabled: GrowthBook 实时禁用心跳
   │
   ▼
回到 pollForWork
```

来源: `bridgeMain.ts:640-731`

---

## 9. 消息去重机制

### 9.1 BoundedUUIDSet

环形缓冲区实现的有限集合，内存 O(capacity)：

```typescript
class BoundedUUIDSet {
  private ring: (string | undefined)[]   // 环形数组
  private set: Set<string>                // 快速查找
  private writeIdx: number                // 写入位置

  add(uuid): 添加，超出容量时淘汰最旧
  has(uuid): 查找
  clear(): 清空
}
```

来源: `bridgeMessaging.ts:429-461`

### 9.2 三层去重

| 去重层 | 目标 | 数据结构 |
|--------|------|----------|
| `recentPostedUUIDs` | 出站消息回声过滤 | `BoundedUUIDSet(2000)` |
| `initialMessageUUIDs` | 初始历史消息回声 | `Set<string>`（无界，初始 flush 后固定） |
| `recentInboundUUIDs` | 入站消息重复投递 | `BoundedUUIDSet(2000)` |

来源: `bridgeMessaging.ts:132-208`, `remoteBridgeCore.ts:261-277`

### 9.3 FlushGate

初始历史消息刷写期间，新消息需要排队以保证顺序：

```
writeMessages() called
   │
   ▼
flushGate.active?
   │
   ├─ 是 → flushGate.enqueue(messages) → 排队等待
   │
   └─ 否 → 直接 transport.writeBatch(messages)

初始 flush 完成:
   │
   ▼
drainFlushGate():
   │  msgs = flushGate.end() → 取出所有排队消息
   │  transport.writeBatch(msgs) → 按序发送
```

来源: `remoteBridgeCore.ts:607-622`, `flushGate.ts`

---

## 10. 子进程管理 (sessionRunner.ts)

### 10.1 子进程启动参数

```
claude [scriptArgs] \
  --print \
  --sdk-url {sdkUrl} \
  --session-id {sessionId} \
  --input-format stream-json \
  --output-format stream-json \
  --replay-user-messages \
  [--verbose] \
  [--debug-file {path}] \
  [--permission-mode {mode}]
```

环境变量:

| 变量 | 值 | 说明 |
|------|-----|------|
| `CLAUDE_CODE_OAUTH_TOKEN` | undefined | 清除，防止子进程用 OAuth |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | `'bridge'` | 标识为 Bridge 子进程 |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | JWT | Session Ingress 认证 |
| `CLAUDE_CODE_FORCE_SANDBOX` | `'1'` (条件) | 沙箱模式 |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | `'1'` | v1 使用 POST 写入 |
| `CLAUDE_CODE_USE_CCR_V2` | `'1'` (条件) | 启用 CCR v2 传输 |
| `CLAUDE_CODE_WORKER_EPOCH` | epoch (条件) | CCR v2 Worker epoch |

来源: `sessionRunner.ts:287-323`

### 10.2 Activity 追踪

子进程 stdout 的 NDJSON 被解析为 `SessionActivity`：

| 类型 | 触发条件 | 示例 |
|------|----------|------|
| `tool_start` | `assistant.message.content[].type === 'tool_use'` | `"Editing src/foo.ts"` |
| `text` | `assistant.message.content[].type === 'text'` | `"Hello, I'll help..."` |
| `result` | `result.subtype === 'success'` | `"Session completed"` |
| `error` | `result.subtype !== 'success'` | `"Error: timeout"` |

工具名映射到动词: `Read→Reading`, `Write→Writing`, `Edit→Editing`, `Bash→Running`, `Glob→Searching` 等。

Ring buffer: 最近 10 条 activity + 最近 10 行 stderr。

来源: `sessionRunner.ts:70-200`

### 10.3 Token 刷新传递

Standalone Bridge 在 JWT 刷新时，通过子进程 stdin 传递新 token：

```json
{"type": "update_environment_variables", "variables": {"CLAUDE_CODE_SESSION_ACCESS_TOKEN": "new-jwt"}}
```

子进程的 `StructuredIO` 处理此消息后直接设置 `process.env`，后续 `getSessionIngressAuthToken()` 自动读取新值。

来源: `sessionRunner.ts:527-541`

---

## 11. 版本兼容与会话 ID

### 11.1 Tagged Session ID 兼容

CCR v2 的 compat 层返回 `session_*` 格式 ID 给 v1 客户端，而基础设施层使用 `cse_*` 格式。两者共享相同 UUID：

```
session_ABC123  ←→  cse_ABC123
           ↑ 同一 UUID ↑
```

`sameSessionId(a, b)`: 比较最后一个下划线后的 body 部分（长度 >= 4 防误匹配）。

来源: `workSecret.ts:62-73`

### 11.2 Compat ID 转换

- `toCompatSessionId(cse_*)` → `session_*` (用于 /v1/sessions/* API)
- `toInfraSessionId(session_*)` → `cse_*` (用于 /bridge/reconnect)

来源: `sessionIdCompat.ts`, `remoteBridgeCore.ts:982`

---

## 12. 遥测与分析事件

| 事件名 | 触发时机 | 关键字段 |
|--------|----------|----------|
| `tengu_bridge_repl_started` | Bridge 启动 | `has_initial_messages`, `v2`, `expires_in_s` |
| `tengu_bridge_repl_ws_connected` | 传输层连接 | `v2`, `cause` |
| `tengu_bridge_repl_ws_closed` | 传输层关闭 | `code`, `v2` |
| `tengu_bridge_message_received` | 收到入站消息 | `is_repl` |
| `tengu_bridge_session_done` | 会话结束 | `status`, `duration_ms` |
| `tengu_bridge_token_refreshed` | Token 刷新完成 | - |
| `tengu_bridge_heartbeat_error` | 心跳失败 | `status`, `error_type` |
| `tengu_bridge_heartbeat_mode_entered` | 进入心跳模式 | `active_sessions`, `heartbeat_interval_ms` |
| `tengu_bridge_repl_reconnected_in_place` | 就地重连成功 | - |
| `tengu_bridge_repl_env_expired_fresh_session` | 环境过期，新建会话 | - |
| `tengu_bridge_repl_connect_timeout` | 连接超时 | `v2`, `elapsed_ms`, `cause` |
| `tengu_ccr_mirror_started/teardown` | Mirror 模式事件 | `v2`, `expires_in_s` |

来源: 各 bridge 文件中的 `logEvent()` 调用

---

## 13. 配置与 Feature Gates

| Gate / Config Key | 用途 | 默认值 |
|-------------------|------|--------|
| `tengu_bridge_repl_v2` | 启用 env-less (v2) REPL Bridge 路径 | false |
| `tengu_bridge_repl_v2_config` | v2 Bridge 定时配置 | 见 `envLessBridgeConfig.ts:44-58` |
| `tengu_ccr_bridge_multi_session` | 启用多会话 spawn 模式 | false |
| `tengu_sessions_elevated_auth_enforcement` | 可信设备令牌发送开关 | false |
| `tengu_bridge_min_version` | v1 Bridge 最低 CLI 版本 | - |
| `tengu_bridge_initial_history_cap` | 初始历史消息回放上限 | 200 |
| `tengu_bridge_repl_v2_cse_shim_enabled` | 服务端 cse_* session ID shim | - |
| `tengu_ccr_bridge_multi_environment` | 多环境 per host:dir (非本文范围) | false |
| `CLAUDE_BRIDGE_USE_CCR_V2` | 环境变量覆盖 v2 传输 | - |
| `CLAUDE_BRIDGE_BASE_URL` | 环境变量覆盖 API base URL | - |
| `CLAUDE_TRUSTED_DEVICE_TOKEN` | 环境变量覆盖可信设备令牌 | - |

来源: `envLessBridgeConfig.ts`, `trustedDevice.ts:33`, `bridgeMain.ts:96-98`, `bridgeConfig.ts`

---

## 14. 关键设计决策总结

1. **双拓扑**: Standalone Bridge 每个任务 spawn 独立子进程（隔离性好），REPL Bridge 当前进程即 worker（延迟低、状态共享）。

2. **Env-less v2 路径**: 移除了 Environments API 层的 register/poll/ack 开销，直接通过 `/code/sessions` + `/bridge` 端点建立连接，减少了一层中间件。

3. **传输层抽象**: `ReplBridgeTransport` 统一 v1/v2 接口，使上层代码无需关心底层是 HybridTransport 还是 SSE+CCRClient。

4. **主动 Token 刷新**: 基于 JWT `exp` / `expires_in` 的预刷新机制（过期前 5min），避免会话在长期运行中因 token 过期中断。

5. **epoch 保护**: CCR v2 的 `/bridge` 每次调用 bump epoch，必须完整重建传输（新 SSE 连接 + 新 CCRClient），仅换 JWT 会导致 stale epoch 409。

6. **FlushGate 排序保证**: 初始历史 flush 期间排队新消息，确保服务端收到 `[history..., live...]` 的有序序列。

7. **三层去重**: 回声过滤（`recentPostedUUIDs`）+ 入站去重（`recentInboundUUIDs`）+ 初始历史去重（`initialMessageUUIDs`），防御服务端重播和传输交换竞态。

8. **可信设备二层认证**: Bridge 会话具有 ELEVATED 安全等级，需要独立的可信设备令牌（90天滚动有效期）作为第二因子，与 OAuth/JWT 分离。