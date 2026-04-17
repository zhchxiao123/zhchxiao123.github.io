---
title: "专题: Compact 压缩逻辑深度分析"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/deep-dive-compact/
---

# Claude Code Compact（压缩）逻辑深度分析

> 分析日期: 2026-04-17
> 核心文件:
> - `src/services/compact/compact.ts` (1,706 行) — 核心压缩逻辑
> - `src/services/compact/autoCompact.ts` (352 行) — 自动压缩触发
> - `src/services/compact/microCompact.ts` (531 行) — 微压缩
> - `src/services/compact/sessionMemoryCompact.ts` (631 行) — 会话记忆压缩
> - `src/services/compact/prompt.ts` (375 行) — 摘要 Prompt 模板
> - `src/services/compact/timeBasedMCConfig.ts` — 时间触发配置
> - `src/services/compact/cachedMicrocompact.ts` — 缓存编辑微压缩
> - `src/commands/compact/compact.ts` (288 行) — `/compact` 命令入口

---

## 1. 压缩层级架构

Claude Code 实现了**四级压缩体系**, 按资源消耗从低到高:

```
┌─────────────────────────────────────────────────────────────┐
│  Level 4: FULL COMPACTION (compactConversation)             │
│  - API 调用生成摘要                                         │
│  - 完全重写对话历史                                         │
│  - 用于: /compact 命令, 自动压缩触发                       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ 失败或禁用时降级
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 3: SESSION MEMORY (trySessionMemoryCompaction)       │
│  - 使用 session memory 文件作为摘要                          │
│  - 无 API 调用, 低成本                                      │
│  - 用于: 实验性 GrowthBook tengu_sm_compact                │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ 失败或禁用时降级
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 2: MICROCOMPACT (microcompactMessages)               │
│  - 清除旧工具结果内容 (保持引用)                            │
│  - 两种路径: 时间触发 / 缓存编辑                           │
│  - 用于: 每次 API 请求前自动运行                           │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ 失败时降级
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 1: SNIP (工具)                                      │
│  - 用户手动删除消息                                         │
│  - 立即释放令牌                                            │
│  - 用于: /snip 命令                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心压缩流程

### 2.1 主压缩入口 (`compactConversation`)

```typescript
// src/services/compact/compact.ts:387-763
async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult>
```

**8阶段执行流程**:

```
Phase 1: 前置处理
    |-- 剥离图片 (stripImagesFromMessages)
    |-- 剥离重新注入的附件 (stripReinjectedAttachments)
    |-- 执行 pre-compact hooks
    |-- 构建缓存共享参数
    |
    v
Phase 2: 消息分组
    |-- 按 tool_use/tool_result 配对分组
    |-- 每个分组成为一个 "round"
    |-- 计算每个 round 的估算 token
    |
    v
Phase 3: 确定截断点
    |-- 目标: 保留 ~200K tokens
    |-- 从最新消息向前保留
    |-- 遇到用户消息时停止 (含用户反馈)
    |
    v
Phase 4: 构建摘要请求
    |-- 选择待总结的消息 (pivotIndex 前的所有消息)
    |-- 组装 prompt (BASE_COMPACT_PROMPT 或 PARTIAL_COMPACT_PROMPT)
    |-- 注入自定义指令 (from hooks)
    |
    v
Phase 5: 发送 API 请求
    |-- 使用 maxTurns:1, maxTokens:20K
    |-- NO_TOOLS_PREAMBLE 确保纯文本响应
    |-- 流式接收摘要
    |
    v
Phase 6: 解析摘要
    |-- formatCompactSummary() 剥离 <analysis>
    |-- 提取 <summary> 内容
    |
    v
Phase 7: 构建后压缩消息
    |-- createCompactBoundaryMessage() 标记压缩点
    |-- 保留最近 N 条消息 (含用户反馈)
    |-- 创建附件恢复上下文 (read 文件, plan, skills)
    |
    v
Phase 8: 后置清理
    |-- runPostCompactCleanup()
    |-- notifyCompaction() 更新缓存基线
    |-- markPostCompaction()
```

### 2.2 部分压缩 (`partialCompactConversation`)

针对 `/compact@<msg-id>` 锚定消息的压缩:

```typescript
// pivotIndex 之前 → BASE_COMPACT_PROMPT (完整摘要)
// pivotIndex 之后 → PARTIAL_COMPACT_PROMPT (部分摘要)
```

两种方向:
- `'from'`: 总结 pivot 之前, 保留 pivot 之后
- `'up_to'`: 总结 pivot 之前, pivot 之后作为 "Context for Continuing Work"

---

## 3. 自动压缩触发 (`autoCompact.ts`)

### 3.1 阈值计算

```typescript
// effectiveContextWindow = 模型上下文窗口 - 20K (最大输出预留)
// autoCompactThreshold = effectiveContextWindow - 13K (缓冲)
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 13K
}
```

**典型值** (以 200K 上下文模型):
```
effectiveContextWindow = 200K - 20K = 180K
autoCompactThreshold   = 180K - 13K = 167K (约 83.5%)
```

### 3.2 三层警告状态

```typescript
// WARNING_THRESHOLD_BUFFER = 20K
// ERROR_THRESHOLD_BUFFER   = 20K
// MANUAL_COMPACT_BUFFER    = 3K

isAboveWarningThreshold  → 显示警告
isAboveErrorThreshold   → 显示严重警告
isAboveAutoCompactThreshold → 触发自动压缩
isAtBlockingLimit        → 阻止进一步输入 (context - 3K)
```

### 3.3 熔断机制

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// 连续 3 次压缩失败后, 停止自动压缩尝试
// 防止上下文已超出限制的会话不断浪费 API 调用
```

### 3.4 递归守卫

```typescript
// 这些源触发的压缩不会再次触发自动压缩 (防止死锁)
if (querySource === 'session_memory' || querySource === 'compact') {
  return false
}

// CONTEXT_COLLAPSE 模式下禁用
if (feature('CONTEXT_COLLAPSE') && isContextCollapseEnabled()) {
  return false
}
```

---

## 4. 微压缩 (`microCompact.ts`)

### 4.1 时间触发微压缩

当**上次助手消息距今超过阈值**时, 清除旧工具结果:

```typescript
// 默认: gapThresholdMinutes = 60 分钟, keepRecent = 3
function maybeTimeBasedMicrocompact(messages, querySource) {
  const gapMinutes = (Date.now() - lastAssistant.timestamp) / 60_000
  if (gapMinutes > config.gapThresholdMinutes) {
    // 保留最近 N 个工具结果, 其余替换为 "[Old tool result content cleared]"
    const keepSet = new Set(compactableIds.slice(-config.keepRecent))
    // ...
  }
}
```

**触发场景**: 用户长时间离开, 返回后继续对话。

### 4.2 缓存编辑微压缩 (实验性)

使用 API 的 `cache_edits` 机制删除工具结果, **不修改本地消息内容**:

```typescript
// CACHED_MICROCOMPACT 特性门控
// 仅主线程运行 (防止子代理污染全局状态)

async function cachedMicrocompactPath(messages, querySource) {
  // 1. 注册工具结果到全局状态
  for (const message of messages) {
    if (message.type === 'user') {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          mod.registerToolResult(state, block.tool_use_id)
        }
      }
    }
  }

  // 2. 获取应删除的工具 ID
  const toolsToDelete = mod.getToolResultsToDelete(state)

  // 3. 创建 cache_edits 块 (由 API 层注入)
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  pendingCacheEdits = cacheEdits

  // 4. 返回消息不变 (API 层添加 cache_reference 和 cache_edits)
  return { messages, compactionInfo: { pendingCacheEdits } }
}
```

**关键优势**: 服务器缓存前缀保持有效, 只需发送增量编辑。

---

## 5. 会话记忆压缩 (`sessionMemoryCompact.ts`)

### 5.1 何时使用

```typescript
// GrowthBook: tengu_session_memory=true AND tengu_sm_compact=true
// 或环境变量: ENABLE_CLAUDE_CODE_SM_COMPACT=1

export function shouldUseSessionMemoryCompaction(): boolean {
  return sessionMemoryFlag && smCompactFlag
}
```

### 5.2 配置

```typescript
const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,      // 最少保留 10K tokens
  minTextBlockMessages: 5, // 最少保留 5 条含文本的消息
  maxTokens: 40_000,      // 最多保留 40K tokens (硬上限)
}
```

### 5.3 消息保留策略

```
lastSummarizedIndex (上次摘要位置)
    |
    v
计算从 lastSummarizedIndex+1 到末尾的 token 数
    |
    v
如果 >= minTokens AND >= minTextBlockMessages
    → 直接保留
    |
    否则向前扩展 (加入更早的消息)
    |
    v
直到满足 minTokens 和 minTextBlockMessages
或达到 maxTokens 硬上限
```

### 5.4 API 不变量保护

防止截断点破坏 `tool_use ↔ tool_result` 配对:

```typescript
export function adjustIndexToPreserveAPIInvariants(messages, startIndex) {
  // 1. 如果保留范围内有任何 tool_result,
  //    必须保留其对应的 tool_use 所在的消息
  // 2. 如果 assistant 消息共享相同的 message.id (流式拆分),
  //    必须保留所有相关消息以合并 thinking blocks
}
```

---

## 6. 摘要 Prompt 模板

### 6.1 BASE_COMPACT_PROMPT (完整压缩)

9段结构:
```
1. Primary Request and Intent        — 用户请求详情
2. Key Technical Concepts            — 技术概念列表
3. Files and Code Sections          — 文件和代码片段
4. Errors and fixes                 — 错误和修复
5. Problem Solving                  — 问题解决
6. All user messages                — 所有用户消息
7. Pending Tasks                    — 待处理任务
8. Current Work                     — 当前工作
9. Optional Next Step               — 下一步 (含引用)
```

### 6.2 PARTIAL_COMPACT_PROMPT (部分压缩)

- `'from'`: 仅总结 recent messages, 早期上下文保持不变
- `'up_to'`: 总结 prefix, newer messages 作为 "Context for Continuing Work"

### 6.3 Prompt 包装

```typescript
NO_TOOLS_PREAMBLE = `
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool Calls will be REJECTED — you will fail the task.
- Your entire response must be plain text: <analysis> + <summary>.
`

// + 额外的自定义指令 (来自 hooks)

// +
NO_TOOLS_TRAILER = `
REMINDER: Do NOT call any tools. Respond with plain text only.
`
```

### 6.4 摘要格式化

```typescript
export function formatCompactSummary(summary: string): string {
  // 1. 剥离 <analysis> 草稿板 (无信息价值)
  formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // 2. 提取 <summary> 内容
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)

  // 3. 替换 XML 标签为可读格式
  return `Summary:\n${content.trim()}`
}
```

---

## 7. 压缩后文件恢复

压缩后, 以下上下文通过附件恢复:

```typescript
// 1. 最近访问的文件 (最多 20 个, 每个最多 500 行)
createPostCompactFileAttachments()  // → FileReadTool 附件

// 2. Plan 文件 (如果存在)
createPlanAttachmentIfNeeded()     // → plan.md 附件

// 3. 技能内容
createSkillAttachmentIfNeeded()     // → 技能定义的 JSON 附件

// 4. Plan Mode 状态
createPlanModeAttachmentIfNeeded() // → plan_mode.json 附件

// 5. 异步 Agent 信息
createAsyncAgentAttachmentsIfNeeded() // → agent 信息附件
```

---

## 8. 压缩管线中的 Hook

```
┌─────────────────────────────────────────────────────────────┐
│  Pre-Compact Hooks (executePreCompactHooks)                  │
│  - 可修改 customInstructions                                │
│  - 可返回用户显示消息                                       │
│  - 可注册要清理的上下文                                     │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Post-Compact Hooks (执行在 compactConversation 完成后)     │
│  - 通知外部系统压缩已发生                                   │
│  - 清理相关状态                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. 关键配置常量

| 常量 | 值 | 用途 |
|------|-----|------|
| `COMPACT_MAX_OUTPUT_TOKENS` | 20,000 | 摘要最大输出 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩触发缓冲 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | 警告阈值缓冲 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | 错误阈值缓冲 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | 手动压缩阻塞限制 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 熔断阈值 |
| `TIME_BASED_MC_CLEARED_MESSAGE` | `[Old tool result content cleared]` | 时间触发清除占位符 |

---

## 10. 关键设计决策

### 10.1 工具结果清除策略

仅清除这些工具的结果:
```typescript
const COMPACTABLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  'Edit', 'Write',
])
```

不清除: `Agent`, `Task*`, `NotebookEdit`, `TaskStop` 等 —— 这些工具的结果有长期价值。

### 10.2 为什么保留最后 N 条消息?

压缩边界选择在**用户消息处**停止, 确保:
1. 保留用户最近的反馈/请求
2. 模型能看到用户对之前工作的反应
3. 避免截断正在进行的对话流

### 10.3 缓存失效处理

```typescript
// 压缩后通知缓存断点检测
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  notifyCompaction(querySource, agentId)
}

// 重置缓存读取基线
// 压缩后的缓存读取量下降是正常的, 不是断点
```

### 10.4 压缩与 Snip 的交互

```
Snip: 用户主动删除, 立即释放令牌
     ↓
microcompact 在下次请求时清除工具结果
     ↓
autoCompact 当 token 接近阈值时触发
     ↓
sessionMemoryCompact (如果启用) 替代完整压缩
     ↓
sessionMemory 不可用时 → 完整压缩 (API 调用)
```

---

## 11. Reactive Compact (实验性)

`feature('REACTIVE_COMPACT')` 模式下, 压缩由 **API 返回 413** 触发, 而非客户端阈值检测:

```typescript
// 当 API 返回 prompt_too_long 时
reactiveCompactOnPromptTooLong(messages, cacheSafeParams, {
  customInstructions,
  trigger: 'manual' | 'auto',
})
```

**优势**: 更精确地知道何时真正需要压缩
**风险**: 已经在 413 状态, 压缩失败则无法恢复

---

## 12. Context Collapse (实验性)

`feature('CONTEXT_COLLAPSE')` 是另一种上下文管理方式:

- **90%** 时触发 commit (保存检查点)
- **95%** 时触发 blocking-spawn (阻止输入)
- 压缩由 Context Collapse 系统拥有, autoCompact 被抑制

这是与 autoCompact 完全不同的架构 —— 预防性 vs 反应性。

---

## 13. 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/compact/compact.ts` | 1,706 | 核心压缩逻辑 (compactConversation, partialCompactConversation) |
| `src/services/compact/autoCompact.ts` | 352 | 自动压缩触发器 (阈值计算, 熔断, 守卫) |
| `src/services/compact/microCompact.ts` | 531 | 微压缩 (时间触发, 缓存编辑) |
| `src/services/compact/sessionMemoryCompact.ts` | 631 | 会话记忆压缩 (无 API 调用摘要) |
| `src/services/compact/prompt.ts` | 375 | 摘要 Prompt 模板 (BASE/PARTIAL COMPACT PROMPT) |
| `src/services/compact/timeBasedMCConfig.ts` | — | 时间触发微压缩配置 |
| `src/services/compact/cachedMicrocompact.ts` | — | 缓存编辑微压缩状态管理 |
| `src/services/compact/reactiveCompact.ts` | — | Reactive Compact (413 触发) |
| `src/services/compact/compactWarningHook.ts` | — | 压缩警告 Hook |
| `src/services/compact/compactWarningState.ts` | — | 压缩警告状态 |
| `src/services/compact/postCompactCleanup.ts` | — | 压缩后清理 |
| `src/services/compact/apiMicrocompact.ts` | — | API 层微压缩处理 |
| `src/services/compact/grouping.ts` | — | 消息分组逻辑 |
| `src/commands/compact/compact.ts` | 288 | `/compact` 命令入口 |
| `src/commands/compact/index.ts` | — | 命令导出 |

---

## 14. 类型定义

```typescript
// CompactionResult — 压缩操作的返回结果
interface CompactionResult {
  boundaryMarker: SystemCompactBoundaryMessage  // 压缩边界标记
  summaryMessages: UserMessage[]                // 摘要消息
  attachments: AttachmentMessage[]              // 附件 (文件, plan, skills)
  hookResults: HookResultMessage[]             // Hook 结果
  messagesToKeep: Message[]                    // 保留的消息
  preCompactTokenCount: number                // 压缩前 token 数
  postCompactTokenCount: number               // 压缩后 token 数
  truePostCompactTokenCount: number           // 实际压缩后 token 数
}

// RecompactionInfo — 连续压缩诊断信息
interface RecompactionInfo {
  isRecompactionInChain: boolean      // 是否在压缩链中
  turnsSincePreviousCompact: number  // 距上次压缩的轮数
  previousCompactTurnId: string      // 上次压缩 ID
  autoCompactThreshold: number       // 自动压缩阈值
  querySource?: QuerySource           // 查询来源
}

// MicrocompactResult — 微压缩结果
type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}
```

---

## 15. 调用链路图

```
用户输入或自动触发
    |
    v
/compact 命令 或 autoCompactIfNeeded()
    |
    v
┌─────────────────────────────────────────────────────────────┐
│  commands/compact/compact.ts (call)                          │
│    |                                                        │
│    +-- trySessionMemoryCompaction()  ← 优先尝试              │
│    |     (如果 tengu_sm_compact 启用, 无 API 调用)          │
│    |                                                        │
│    +-- reactiveCompact (如果 REACTIVE_COMPACT 启用)          │
│    |                                                        │
│    +-- microcompactMessages()  ← 每次请求前运行              │
│    |     +-- maybeTimeBasedMicrocompact()                   │
│    |     |     (时间触发: 保留最近 N, 清除旧)               │
│    |     +-- cachedMicrocompactPath()                       │
│    |           (缓存编辑: cache_edits API)                   │
│    |                                                        │
│    +-- compactConversation()  ← 完整压缩                      │
│          +-- executePreCompactHooks()                      │
│          +-- streamCompactSummary()                        │
│          |     (API 调用: maxTurns=1, maxTokens=20K)        │
│          +-- formatCompactSummary()                         │
│          +-- buildPostCompactMessages()                      │
│          +-- runPostCompactCleanup()                        │
└─────────────────────────────────────────────────────────────┘
    |
    v
CompactionResult → 更新 AppState.messages
```