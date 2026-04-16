---
title: "Step 20: 系统提示组装"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/20-system-prompt/
---


> 分析日期: 2026-04-16
> 核心文件: src/constants/prompts.ts(914行), src/constants/systemPromptSections.ts(69行), src/context.ts(189行), src/utils/context.ts(221行), src/utils/systemPrompt.ts(123行), src/utils/claudemd.ts(1,479行), src/coordinator/coordinatorMode.ts(369行), src/services/compact/prompt.ts(374行)

---

## 1. 系统提示类型

```typescript
// utils/systemPromptType.ts
export type SystemPrompt = readonly string[] & { readonly __brand: 'SystemPrompt' }
export function asSystemPrompt(value: readonly string[]): SystemPrompt
```

数组中每个字符串成为独立的 `TextBlockParam`。品牌类型防止意外使用普通字符串数组。

---

## 2. 组装管线 (端到端)

```
QueryEngine.ts:ask()
    |
    v
fetchSystemPromptParts() -- 并行执行:
    |-- getSystemPrompt()    -- 主提示数组
    |-- getUserContext()      -- CLAUDE.md + 当前日期
    |-- getSystemContext()    -- Git 状态 + 缓存失效标记
    |
    v
合并 coordinator 上下文:
userContext = { ...baseUserContext, ...getCoordinatorUserContext() }
    |
    v
构建最终 SystemPrompt:
systemPrompt = asSystemPrompt([
    ...(customPrompt ?? defaultSystemPrompt),
    ...(memoryMechanicsPrompt ?? []),
    ...(appendSystemPrompt ?? []),
])
    |
    v
buildEffectiveSystemPrompt() -- 优先级解析:
    1. Override (loop 模式) -- 替换全部
    2. Coordinator (CLAUDE_CODE_COORDINATOR_MODE) -- 替换默认
    3. Agent (mainThreadAgentDefinition) -- 追加或替换
    4. Custom (--system-prompt)
    5. Default (getSystemPrompt())
    + appendSystemPrompt 总是追加
    |
    v
services/api/claude.ts query():
    |-- 前置: 归属头 (attribution header)
    |-- 前置: CLI 系统提示前缀
    |-- 主体: systemPrompt
    |-- 后置: Advisor 工具指令 (条件)
    |-- 后置: Chrome 工具搜索指令 (条件)
    |
    v
buildSystemPromptBlocks() -> splitSysPromptPrefix()
    |-- 分割为 TextBlockParam[] + cache_control 注解
    |-- 结果发送到 API
```

---

## 3. 主提示组装 (getSystemPrompt)

### 3.1 SIMPLE 模式快速路径

```
CLAUDE_CODE_SIMPLE=1 时:
"You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ...\nDate: ..."
```

### 3.2 PROACTIVE/KAIROS 模式快速路径

```
1. 自治代理身份 + CYBER_RISK_INSTRUCTION
2. 系统提醒段落
3. 记忆提示 (loadMemoryPrompt)
4. 环境信息 (computeSimpleEnvInfo)
5. 语言段落
6. MCP 指令 (除非 delta 启用)
7. Scratchpad 指令
8. 函数结果清理段落
9. SUMMARIZE_TOOL_RESULTS_SECTION
10. 主动段落 (getProactiveSection)
```

### 3.3 默认路径 (完整标准提示)

**静态内容 (可缓存, 在边界标记前):**

| 段落 | 函数 | 内容 |
|------|------|------|
| Intro | `getSimpleIntroSection` | 身份声明、网络风险指令、URL 安全指南 |
| System | `getSimpleSystemSection` | Markdown 渲染、权限模式、system-reminder 标签、Hook 说明、自动压缩通知 |
| Doing tasks | `getSimpleDoingTasksSection` | 软件工程指导、代码风格 (Ant 内部: 无注释默认、验证前置、反虚假声明) |
| Actions | `getActionsSection` | 风险/可逆性指导、破坏性操作确认 |
| Using tools | `getUsingYourToolsSection` | 专用工具优先 (Read/Edit/Write/Glob/Grep)、任务管理、并行工具调用 |
| Tone/style | `getSimpleToneAndStyleSection` | 避免 emoji、file:line 引用、GitHub issue 格式 |
| Output efficiency | `getOutputEfficiencySection` | Ant 内部: 长篇通信指导; 外部: 简洁指导 |

**BOUNDARY MARKER**: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`

边界标记之前的内容可使用 `cacheScope: 'global'`；之后为会话特定内容。

**动态内容 (注册表管理, 边界标记后):**

| 段落名 | 计算函数 | 缓存 | 条件 |
|--------|---------|------|------|
| `session_guidance` | `getSessionSpecificGuidanceSection` | 缓存 | 依赖启用工具、交互模式、子 Agent、技能/代理可用性 |
| `memory` | `loadMemoryPrompt()` | 缓存 | 依赖自动记忆、团队记忆、KAIROS 设置 |
| `ant_model_override` | `getAntModelOverrideSection` | 缓存 | 仅 Ant 内部、undercover 检查 |
| `env_info_simple` | `computeSimpleEnvInfo` | 缓存 | 始终存在 |
| `language` | `getLanguageSection` | 缓存 | 语言偏好设置时 |
| `output_style` | `getOutputStyleSection` | 缓存 | 输出风格配置时 |
| `mcp_instructions` | `getMcpInstructionsSection` | **不缓存** | MCP 连接/断开时失效; delta 启用时跳过 |
| `scratchpad` | `getScratchpadInstructions` | 缓存 | scratchpad 特性开关 |
| `frc` | `getFunctionResultClearingSection` | 缓存 | CACHED_MICROCOMPACT 特性 + 模型支持 |
| `summarize_tool_results` | 静态字符串 | 缓存 | 始终存在 |
| `numeric_length_anchors` | 静态字符串 | 缓存 | 仅 Ant 内部 |
| `token_budget` | 静态字符串 | 缓存 | TOKEN_BUDGET 特性 |
| `brief` | `getBriefSection` | 缓存 | KAIROS/KAIROS_BRIEF 特性 |

---

## 4. 系统提示段落注册表

```typescript
// systemPromptSections.ts
type SystemPromptSection = {
  name: string
  compute: () => string | null | Promise<string | null>
}

// 缓存版本
systemPromptSection(name, compute)  -- 计算一次, 缓存到 systemPromptSectionCache

// 不缓存版本 (每次重新计算)
DANGEROUS_uncachedSystemPromptSection(name, compute, reason)
```

缓存存储在 `bootstrap/state.ts` 的 `systemPromptSectionCache` (`Map<string, string | null>`) 中。`/clear` 和 `/compact` 命令通过 `clearSystemPromptSections()` 清除缓存。

---

## 5. 缓存控制

### 5.1 静态/动态分割

```
splitSysPromptPrefix(systemPrompt) -> TextBlockParam[]
    |
    +-- 模式 1: MCP 工具存在 (skipGlobalCache=true)
    |     Block 0: 归属头 (cacheScope: null)
    |     Block 1: 系统提示前缀 (cacheScope: 'org')
    |     Block 2: 其余内容 (cacheScope: 'org')
    |
    +-- 模式 2: 全局缓存 + 边界标记 (1P, 边界找到)
    |     Block 0: 归属头 (cacheScope: null)
    |     Block 1: 系统提示前缀 (cacheScope: null)
    |     Block 2: 静态内容 (cacheScope: 'global')
    |     Block 3: 动态内容 (cacheScope: null)
    |
    +-- 模式 3: 默认 (3P 提供商 / 无边界)
          Block 0: 归属头 (cacheScope: null)
          Block 1: 系统提示前缀 (cacheScope: null)
          Block 2: 全部内容 (cacheScope: 'org')
```

### 5.2 CLI 系统提示前缀

| 场景 | 前缀字符串 |
|------|-----------|
| 默认/Vertex | `"You are Claude Code, Anthropic's official CLI for Claude."` |
| 非交互 + appendSystemPrompt | `"...running within the Claude Agent SDK."` |
| 非交互, 无 append | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` |

### 5.3 归属头

```
x-anthropic-billing-header: cc_version=<version>.<fingerprint>; cc_entrypoint=<entrypoint>; cch=00000; cc_workload=<workload>;
```

`cch=00000` 占位符在 HTTP 传输层被 Bun 原生认证覆盖。

---

## 6. Coordinator 系统提示

**文件**: `src/coordinator/coordinatorMode.ts` (369行)

`getCoordinatorSystemPrompt()` 返回约 2000 字的协调者提示:

| 段落 | 内容 |
|------|------|
| 角色定义 | 协调者, 非执行者 |
| 工具清单 | Agent, SendMessage, TaskStop, PR 订阅 |
| 任务通知格式 | XML `<task-notification>` 块 |
| Worker 能力描述 | 研究者/实现者/测试者 |
| 工作流阶段 | 研究 -> 综合 -> 实现 -> 验证 |
| 并发规则 | 并行只读、串行写重 |
| 验证标准 | 运行测试、执行脚本 |
| Worker 失败处理 | 重试/替换/报告 |
| 继续与生成决策表 | 何时复用 vs 生成新 Worker |

**激活条件**: `CLAUDE_CODE_COORDINATOR_MODE=1` + `COORDINATOR_MODE` 特性开关

---

## 7. 压缩提示模板

**文件**: `src/services/compact/prompt.ts` (374行)

### 7.1 BASE_COMPACT_PROMPT (完整压缩)

9 段结构:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

### 7.2 PARTIAL_COMPACT_PROMPT (部分压缩)

- `direction='from'`: 仅总结最近部分
- `direction='up_to'`: 总结放在继续会话开头, 第 9 段替换为 "Context for Continuing Work"

### 7.3 包装

所有变体被包装:
- `NO_TOOLS_PREAMBLE`: 仅文本响应, 不调用工具
- `NO_TOOLS_TRAILER`: 提醒
- `<analysis>` 起草草稿板 (由 `formatCompactSummary` 剥离)
- 可选自定义指令追加

### 7.4 压缩阈值

| 参数 | 值 | 用途 |
|------|-----|------|
| `COMPACT_MAX_OUTPUT_TOKENS` | 20,000 | 压缩摘要最大令牌 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩触发缓冲 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | 上下文警告缓冲 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 最大连续失败次数 |

自动压缩在 `effectiveContextWindow - 13,000` 令牌时触发。

---

## 8. CLAUDE.md 注入路径

```
getUserContext() (context.ts)
    |
    v
getMemoryFiles() (claudemd.ts)  -- 发现所有内存文件
    |
    v
filterInjectedMemoryFiles()  -- tengu_moth_copse 门控过滤
    |
    v
getClaudeMds()  -- 组装为字符串:
    MEMORY_INSTRUCTION_PROMPT + "\n\n" + memories.join("\n\n")
    |
    v
setCachedClaudeMdContent()  -- 缓存供 yoloClassifier 使用
    |
    v
userContext.claudeMd  -- 注入到 API 调用
```

---

## 9. 模板变量替换

系统提示使用直接 JavaScript 模板插值 (无模板引擎):

| 变量 | 来源 | 位置 |
|------|------|------|
| `${getCwd()}` | 当前工作目录 | prompts.ts |
| `${getSessionStartDate()}` | 会话开始日期 | prompts.ts |
| `${osType()} ${osRelease()}` | 操作系统信息 | prompts.ts |
| `${env.platform}` | 平台 | prompts.ts |
| `${process.env.SHELL}` | 用户 Shell | prompts.ts |
| `${modelId}` | 当前模型 ID | prompts.ts |
| `${getMarketingNameForModel()}` | 模型营销名 | prompts.ts |
| `${getScratchpadDir()}` | Scratchpad 路径 | prompts.ts |
| `${settings.language}` | 语言偏好 | prompts.ts |
| `${outputStyleConfig.name/prompt}` | 输出风格 | prompts.ts |
| 工具名常量 | 导入 | prompts.ts |
| `${getLocalISODate()}` | 当前日期 | context.ts |

---

## 10. 特性开关门控段落

| 特性开关 | 效果 |
|---------|------|
| `COORDINATOR_MODE` | 启用协调者系统提示 |
| `PROACTIVE` / `KAIROS` | 启用自治代理提示路径、主动段落 |
| `KAIROS_BRIEF` | 启用 brief 段落 |
| `EXPERIMENTAL_SKILL_SEARCH` | 启用 DiscoverSkills 工具和指导 |
| `CACHED_MICROCOMPACT` | 启用函数结果清理段落 |
| `TOKEN_BUDGET` | 启用令牌预算段落 |
| `BREAK_CACHE_COMMAND` | 启用缓存失效注入 |
| `VERIFICATION_AGENT` | 添加验证 Agent 指导 (Ant 内部) |
| `TEAMMEM` | 启用团队记忆功能 |
| `USER_TYPE=ant` | Ant 内部: 更长代码风格、无注释默认、反虚假声明、数字长度锚 |
| `CLAUDE_CODE_SIMPLE` | 最小提示路径 |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | 禁用 CLAUDE.md |
| `CLAUDE_CODE_REMOTE` | 跳过 Git 状态 |
| `isUndercover()` | 从提示中移除模型名/ID |
| `isReplModeEnabled()` | 简化工具使用段落 |

---

## 11. 关键观察

1. **三层组装架构**: 静态段落 (可缓存) + 动态段落 (注册表管理) + 运行时注入 (API 层)。边界标记分隔缓存和非缓存区域。

2. **MCP 指令是最不稳定的**: 唯一使用 `DANGEROUS_uncachedSystemPromptSection` 的段落，因为 MCP 连接/断开会改变可用工具集。MCP 指令增量 (delta) 模式可以减少这种不稳定性。

3. **Ant 内部 vs 外部提示差异显著**: Ant 内部用户获得额外的代码风格指导 (无注释默认、验证前置、反虚假声明、长篇通信) 和内部工具 (Tungsten、Config、REPL)。

4. **压缩是提示工程的关键**: 自动压缩、部分压缩、函数结果清理三个机制协同工作，在上下文窗口限制下维持对话连续性。

5. **CLAUDE.md 是用户/项目配置的入口**: 通过文件系统发现和 @include 递归，CLAUDE.md 提供了一种零代码的方式定制 AI 行为。40,000 字符限制防止上下文窗口被过度占用。