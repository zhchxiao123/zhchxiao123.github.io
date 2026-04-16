---
title: "Step 17: 权限与安全系统"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/17-security-system/
---


## 1. 权限系统架构总览

Claude Code 的权限与安全系统是一个多层防御体系，从宏观到微观分为以下层次：

```
┌─────────────────────────────────────────────────────────┐
│                   权限模式状态机 (Permission Mode)         │
│   default → plan → acceptEdits → auto → bypassPermissions │
├─────────────────────────────────────────────────────────┤
│                   规则引擎 (Rule Engine)                  │
│   alwaysAllow / alwaysDeny / alwaysAsk 规则匹配          │
├───────────────────────┬─────────────────────────────────┤
│   Yolo/Auto 分类器    │       Bash 安全检查               │
│   (LLM 侧查询)        │   (AST 解析 + 模式匹配)           │
├───────────────────────┴─────────────────────────────────┤
│                   沙箱层 (Sandbox)                        │
│   bwrap/bubblewrap 文件系统 + 网络隔离                    │
├─────────────────────────────────────────────────────────┤
│                   SSRF 防护 (HTTP Hooks)                  │
│   DNS 解析拦截, 私有 IP 阻断                              │
├─────────────────────────────────────────────────────────┤
│                   Kill Switch / 紧急制动                  │
│   Statsig 特性门控, 服务端远程禁用                        │
└─────────────────────────────────────────────────────────┘
```

核心文件分布：

| 层次 | 文件 | 职责 |
|------|------|------|
| 权限核心 | `permissions.ts` | 权限检查主流程 (`hasPermissionsToUseTool`) |
| 权限模式 | `PermissionMode.ts` | 模式枚举与配置 |
| 权限规则 | `PermissionRule.ts` | 规则类型定义 |
| 规则解析 | `permissionRuleParser.ts` | 规则字符串序列化/反序列化 |
| 规则加载 | `permissionSetup.ts` | 初始化上下文, 危险规则剥离, kill switch |
| 规则更新 | `PermissionUpdate.ts` | 用户交互后持久化规则变更 |
| Yolo 分类器 | `yoloClassifier.ts` | Auto 模式下 AI 分类决策 |
| Bash 分类器 | `bashClassifier.ts` | Bash 命令本地分类 (deny/ask/allow) |
| 危险模式 | `dangerousPatterns.ts` | 危险命令前缀清单 |
| 文件系统 | `filesystem.ts` | 文件路径安全检查 |
| Kill Switch | `bypassPermissionsKillswitch.ts` | 远程禁用机制 |
| 拒绝追踪 | `denialTracking.ts` | 连续拒绝回退机制 |
| Bash 安全 | `bashSecurity.ts` | 命令注入/危险模式检测 |
| Bash 权限 | `bashPermissions.ts` | Bash/PowerShell 权限匹配 |
| 沙箱适配 | `sandbox-adapter.ts` | 沙箱配置转换与初始化 |
| SSRF 防护 | `ssrfGuard.ts` | HTTP Hooks 的 SSRF 防护 |

---

## 2. 权限模式状态机

### 2.1 模式定义

权限模式定义在 `src/types/permissions.ts` 中：

```typescript
// 外部可用模式
type ExternalPermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'

// 内部模式 (包含 ant-only 模式)
type PermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

### 2.2 模式配置

每个模式有对应的配置 (`PermissionMode.ts`)：

| 模式 | 标题 | 符号 | 颜色 | 说明 |
|------|------|------|------|------|
| `default` | Default | (空) | text | 默认模式, 每次操作都需确认 |
| `plan` | Plan Mode | ⏸ | planMode | 只读规划, 不执行修改操作 |
| `acceptEdits` | Accept edits | ⏵⏵ | autoAccept | 自动接受文件编辑, 其他操作仍需确认 |
| `bypassPermissions` | Bypass Permissions | ⏵⏵ | error | 绕过所有权限检查 |
| `dontAsk` | Don't Ask | ⏵⏵ | error | 静默拒绝所有权限请求 |
| `auto` | Auto mode | ⏵⏵ | warning | AI 分类器自动决策 (ant-only) |

### 2.3 模式流转

```
                    ┌─────────┐
          启动 ───→ │ default  │ ←── 模式重置
                    └────┬────┘
                         │ 用户 Tab/Shift-Tab 切换
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        ┌─────────┐ ┌────────┐ ┌──────────────┐
        │  plan   │ │acceptEd│ │bypassPerms* │
        │(只读)   │ │(自动编辑)│ │(全权绕过)   │
        └────┬────┘ └───┬────┘ └──────┬───────┘
             │          │             │
             │ plan中Tab│             │
             └──────┐   │             │
                    ▼   │             │
              ┌────────┐│             │
              │  auto  ││  (ant-only)  │
              │(AI决策) ││             │
              └────────┘│             │
                        │             │
              ┌─────────┘             │
              │ dontAsk               │
              │ (静默拒绝)            │
              └───────────────────────┘

* bypassPermissions 需要 Statsig 门控通过 + 设置允许
```

关键流转逻辑：

1. **default → plan**: 用户按 Shift+Tab 进入计划模式
2. **plan → auto**: 在 plan 模式中按 Tab 可以激活 auto 模式 (需要 TRANSCRIPT_CLASSIFIER feature flag)
3. **default → acceptEdits**: 用户按 Tab 切换到自动编辑模式
4. **default → bypassPermissions**: 需要 `isBypassPermissionsModeAvailable` 为 true，且 Statsig 门控未禁用
5. **任何模式 → dontAsk**: 异步 Agent 模式下，当无法弹出提示时自动进入

### 2.4 Kill Switch 机制对模式的影响

`bypassPermissionsKillswitch.ts` 实现了两个关键的远程禁用机制：

1. **Bypass Permissions Kill Switch**: 如果 Statsig 特性门控 `tengu_disable_bypass_permissions_mode` 启用，或者 `settings.permissions.disableBypassPermissionsMode === 'disable'`，则强制切回 `default` 模式并设置 `isBypassPermissionsModeAvailable: false`。极端情况下调用 `gracefulShutdown(1, 'bypass_permissions_disabled')` 关闭进程。

2. **Auto Mode Gate**: `verifyAutoModeGateAccess()` 检查以下条件：
   - GrowthBook 配置的 `enabled` 状态 (`enabled` / `disabled` / `opt-in`)
   - 用户是否显式 opt-in (`skipAutoPermissionPrompt` 设置 或 CLI `--enable-auto-mode` 标志)
   - 模型是否支持 auto 模式
   - Circuit breaker 是否触发（连续拒绝过多时自动禁用）

---

## 3. 规则评估流程

### 3.1 规则数据结构

权限规则存储在 `ToolPermissionContext` 中：

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource  // 按 source 分组的允许规则
  alwaysDenyRules: ToolPermissionRulesBySource     // 按 source 分组的拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource     // 按 source 分组的询问规则
  isBypassPermissionsModeAvailable: boolean       // bypass 模式是否可用
  strippedDangerousRules?: ToolPermissionRulesBySource  // 被剥离的危险规则
  shouldAvoidPermissionPrompts?: boolean          // 是否避免弹出提示
  awaitAutomatedChecksBeforeDialog?: boolean
  prePlanMode?: PermissionMode
}
```

规则来源 (`PermissionRuleSource`) 优先级从高到低：

1. `policySettings` - 企业策略设置 (最高优先级)
2. `flagSettings` - 命令行标志
3. `userSettings` - 全局用户设置 (`~/.claude/settings.json`)
4. `projectSettings` - 项目设置 (`.claude/settings.json`)
5. `localSettings` - 本地项目设置 (`.claude/settings.local.json`)
6. `cliArg` - CLI 参数
7. `command` - /命令 会话内规则
8. `session` - 会话级规则

### 3.2 规则解析格式

`permissionRuleParser.ts` 处理规则的序列化格式：

```
格式: "ToolName" 或 "ToolName(content)"
内容可包含转义括号: \( 和 \)
```

解析逻辑：
- `Bash` → `{ toolName: 'Bash' }` (工具级规则, 匹配所有 Bash 操作)
- `Bash(npm install)` → `{ toolName: 'Bash', ruleContent: 'npm install' }` (精确匹配)
- `Bash(python:*)` → `{ toolName: 'Bash', ruleContent: 'python:*' }` (前缀通配符)
- `Bash(python -c "print\(1\)")` → `{ toolName: 'Bash', ruleContent: 'python -c "print(1)"' }` (转义处理)

### 3.3 评估流程

`hasPermissionsToUseTool` (在 `permissions.ts` 中) 是权限检查的入口，完整流程如下：

```
输入: tool, input, context, assistantMessage, toolUseID
                │
                ▼
    ┌─── bypassPermissions 模式? ───→ 直接 allow
    │
    ▼
    ┌─── 检查 alwaysDeny 规则 ───→ 命中则 deny
    │
    ▼
    ┌─── 检查 alwaysAllow 规则 ───→ 命中则 allow
    │
    ▼
    ┌─── 检查 alwaysAsk 规则 ───→ 命中则 ask
    │
    ▼
    ┌─── 调用 tool.checkPermissions() ───→ 工具特定安全检查
    │       │
    │       ├─ 文件系统安全检查 (filesystem.ts)
    │       ├─ Bash 安全检查 (bashSecurity.ts)
    │       ├─ PowerShell 安全检查
    │       ├─ 工作目录检查
    │       └─ Hook 检查
    │
    ▼
    ┌─── dontAsk 模式? ───→ 静默 deny
    │
    ▼
    ┌─── auto/plan+autoActive 模式? ───→ Yolo 分类器
    │       │
    │       ├─ acceptEdits 快速路径: 先尝试 acceptEdits 模式检查
    │       ├─ 安全工具白名单: 直接 allow
    │       └─ AI 分类器: classifyYoloAction()
    │
    ▼
    ┌─── 其他模式 ───→ ask (弹出用户提示)
    │
    ▼
    结果: { behavior: 'allow' | 'deny' | 'ask' }
```

### 3.4 规则匹配细节

对于 Bash 工具，规则匹配有特殊逻辑（`bashPermissions.ts`）：

1. **精确匹配**: `Bash(npm install)` 只匹配 `npm install`
2. **前缀匹配**: `Bash(npm:*)` 匹配所有以 `npm` 开头的命令
3. **通配符匹配**: `Bash(npm run *)` 匹配 `npm run build` 等
4. **安全包装器剥离**: `timeout 30 npm run build` 先剥离 `timeout` 后匹配 `npm run`
5. **环境变量剥离**: `NODE_ENV=prod npm run build` 剥离 `NODE_ENV=prod` 后匹配

---

## 4. Yolo/Auto 分类器

### 4.1 概述

Auto 模式（又称 Yolo 模式）是 ant-only 的功能，通过 AI 分类器自动决定是允许还是阻断操作，取代用户的手动确认。核心实现在 `yoloClassifier.ts`。

### 4.2 分类器架构

分类器采用两阶段 XML 分类（2-Stage XML Classifier）：

```
┌──────────────────────────────────────┐
│        构建 Action 描述               │
│   formatActionForClassifier()        │
│   将工具调用序列化为紧凑格式          │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│     构建 System Prompt               │
│   buildYoloSystemPrompt()            │
│   含权限模板 + 用户 allow/deny 规则   │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│     构建 Transcript (上下文)         │
│   buildTranscriptEntries()           │
│   用户消息 + 助手工具调用历史          │
│   + CLAUDE.md 用户配置               │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│        Stage 1: 快速分类              │
│   XML 格式: <block>yes/no</block>    │
│   较小模型, 低延迟                    │
│   后缀: "Err on the side of          │
│          blocking. <block> immediately"│
└──────────────┬───────────────────────┘
               │
         ┌─────┴─────┐
         │ 明确?      │
         ├─ 是 ──→ 返回结果
         └─ 否 ──→ Stage 2
               │
               ▼
┌──────────────────────────────────────┐
│     Stage 2: 深度推理                 │
│   带 extended thinking 的深度分析     │
│   后缀: "Review the classification    │
│          process and follow it        │
│          carefully..."                │
└──────────────┬───────────────────────┘
               │
               ▼
          返回 shouldBlock + reason
```

### 4.3 分类器 Prompt 组成

系统 Prompt 由以下部分组装：

1. **BASE_PROMPT** (`auto_mode_system_prompt.txt`): 基础安全分类指令
2. **权限模板**:
   - Anthropic 内部: `permissions_anthropic.txt` (更严格的安全规则)
   - 外部用户: `permissions_external.txt` (标准安全规则)
3. **用户自定义规则** (settings.autoMode):
   - `allow`: 用户定义的允许描述列表
   - `soft_deny`: 用户定义的拒绝描述列表
   - `environment`: 用户定义的环境描述列表

### 4.4 Bash 本地分类器

在进入 LLM 分类器之前，Bash 命令首先经过本地分类器 (`bashClassifier.ts`)：

```typescript
type ClassifierResult = {
  matches: boolean          // 是否匹配
  matchedDescription?: string  // 匹配的规则描述
  confidence: 'high' | 'medium' | 'low'  // 置信度
  reason: string            // 分类原因
}
type ClassifierBehavior = 'deny' | 'ask' | 'allow'
```

本地分类器有三类描述列表：
- **deny**: 始终拒绝的命令描述
- **ask**: 需要提示用户的命令描述
- **allow**: 允许自动执行的命令描述

当 `feature('BASH_CLASSIFIER')` 启用时，本地分类器的结果会融入 Yolo 分类器的 Prompt 中。

### 4.5 拒绝追踪与回退

`denialTracking.ts` 实现了连续拒绝计数器：

```typescript
type DenialTrackingState = {
  consecutiveDenials: number  // 连续拒绝次数
  totalDenials: number        // 总拒绝次数
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续 3 次拒绝后回退到提示模式
  maxTotal: 20,        // 总共 20 次拒绝后回退到提示模式
}
```

当 auto 模式下分类器连续拒绝达到阈值时，系统会回退到手动提示模式，防止 AI 在误判时无限循环。

### 4.6 acceptEdits 快速路径

在调用昂贵的 AI 分类器之前，系统会先检查 `acceptEdits` 模式是否允许该操作：

```typescript
// 如果 acceptEdits 模式会允许此操作，跳过分类器
const acceptEditsResult = await tool.checkPermissions(parsedInput, {
  ...context,
  getAppState: () => ({
    ...state,
    toolPermissionContext: { ...state.toolPermissionContext, mode: 'acceptEdits' },
  }),
})
if (acceptEditsResult.behavior === 'allow') {
  // 快速路径：直接允许，不调用分类器
  return { behavior: 'allow', decisionReason: { type: 'mode', mode: 'auto' } }
}
```

这避免了不必要的分类器 API 调用，特别是对文件编辑操作。

### 4.7 安全工具白名单

`classifierDecision.ts` 中有一个安全工具白名单 (`isAutoModeAllowlistedTool`)，以下工具在 auto 模式下直接放行，不需要分类器评估：

- 读取类工具 (Read, Glob, Grep 等)
- 搜索类工具
- 其他非破坏性工具

---

## 5. 沙箱架构

### 5.1 沙箱层级

```
┌─────────────────────────────────────────────┐
│           SandboxManager (适配层)            │
│   将 Claude Code 配置转换为 sandbox-runtime  │
│   配置格式, 处理路径解析, 订阅设置变更        │
├─────────────────────────────────────────────┤
│       BaseSandboxManager (sandbox-runtime)   │
│   底层 bwrap/bubblewrap 进程沙箱管理          │
│   文件系统挂载, 网络代理, 资源限制             │
├─────────────────────────────────────────────┤
│       OS 级沙箱 (bubblewrap/bwrap)           │
│   Linux: bwrap + socat 代理                  │
│   macOS: sandbox-exec                        │
│   Windows: 不支持 (WSL2 可用)               │
└─────────────────────────────────────────────┘
```

### 5.2 沙箱配置

`convertToSandboxRuntimeConfig()` 将 Claude Code 设置转换为沙箱运行时配置：

```typescript
type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[]       // 允许的网络域名
    deniedDomains: string[]         // 拒绝的网络域名
    allowUnixSockets?: string[]    // 允许的 Unix socket
    allowLocalBinding?: boolean     // 允许本地绑定
    httpProxyPort?: number         // HTTP 代理端口
    socksProxyPort?: number        // SOCKS 代理端口
  }
  filesystem: {
    allowWrite: string[]           // 允许写入的路径
    denyWrite: string[]            // 拒绝写入的路径
    allowRead: string[]            // 允许读取的路径
    denyRead: string[]             // 拒绝读取的路径
  }
  // ...其他配置
}
```

### 5.3 关键安全配置

**写入保护** (始终拒绝写入):
- 所有 settings.json 文件 (防止沙箱逃逸)
- `.claude/skills/` 目录 (技能文件具有等同于命令的权限)
- `.git/` 下的裸仓库文件 (防止 git 钩子注入攻击)

**写入允许** (始终允许写入):
- 当前工作目录 (`.`)
- Claude 临时目录 (`/tmp/claude-{uid}/`)
- Git worktree 的主仓库 `.git` 目录
- 用户通过 `--add-dir` 添加的目录

**路径解析规则**:
- `//path` → 绝对路径 (从文件系统根目录)
- `/path` → 相对于设置文件目录
- `~/path` → 用户主目录
- `./path` → 相对于当前工作目录

### 5.4 沙箱排除命令

`shouldUseSandbox.ts` 决定命令是否需要在沙箱内运行：

```typescript
function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  // 1. 沙箱未启用 → 不使用
  if (!SandboxManager.isSandboxingEnabled()) return false

  // 2. 显式禁用沙箱 + 策略允许非沙箱命令 → 不使用
  if (input.dangerouslyDisableSandbox &&
      SandboxManager.areUnsandboxedCommandsAllowed()) return false

  // 3. 命令包含排除列表中的命令 → 不使用
  if (containsExcludedCommand(input.command)) return false

  return true  // 其他情况使用沙箱
}
```

排除命令匹配支持：
- 精确匹配
- 前缀匹配 (`bazel:*`)
- 通配符匹配
- 环境变量和包装器剥离 (`NODE_ENV=prod bazel run` → 匹配 `bazel:*`)

### 5.5 裸仓库攻击防御

`sandbox-adapter.ts` 包含了一个关键的安全防御——防止通过创建假 git 仓库来逃逸沙箱：

```typescript
// 攻击向量: 在沙箱内创建 HEAD + objects/ + refs/ 使 git 认为当前目录是裸仓库
// 然后通过 core.fsmonitor 钩子在沙箱外的 git 操作中执行任意代码
//
// 防御:
// 1. 如果文件存在 → denyWrite (只读绑定)
// 2. 如果文件不存在 → scrubBareGitRepoFiles() 在沙箱命令后清理
```

---

## 6. SSRF 防护

### 6.1 概述

`ssrfGuard.ts` 为 HTTP Hooks 提供服务器端请求伪造 (SSRF) 防护，阻止私有/链路本地 IP 地址的请求。

### 6.2 阻断规则

| IP 范围 | 描述 | 动作 |
|---------|------|------|
| `0.0.0.0/8` | "this" 网络 | 阻断 |
| `10.0.0.0/8` | 私有网络 (A 类) | 阻断 |
| `100.64.0.0/10` | CGNAT / 共享地址空间 | 阻断 |
| `169.254.0.0/16` | 链路本地 (云元数据) | 阻断 |
| `172.16.0.0/12` | 私有网络 (B 类) | 阻断 |
| `192.168.0.0/16` | 私有网络 (C 类) | 阻断 |
| `127.0.0.0/8` | 本地回环 | **允许** |
| `::1` | IPv6 本地回环 | **允许** |
| `::` | IPv6 未指定 | 阻断 |
| `fc00::/7` | IPv6 唯一本地 | 阻断 |
| `fe80::/10` | IPv6 链路本地 | 阻断 |
| `::ffff:a.b.c.d` | IPv4 映射的 IPv6 | 委托给 v4 检查 |

### 6.3 实现

`ssrfGuardedLookup()` 是一个与 `dns.lookup` 兼容的函数，用作 axios 的自定义 DNS 解析器：

```typescript
// 关键实现细节:
// 1. IP 字面量直接验证，不经过 DNS
// 2. 域名先通过 dns.lookup 解析，然后验证所有结果 IP
// 3. 任何结果 IP 在阻断列表中 → 整个请求被拒绝
// 4. IPv4 映射的 IPv6 地址 (如 ::ffff:169.254.169.254) 会被提取并检查
```

特别注意：当使用全局代理或沙箱网络代理时，SSRF 防护实际上被绕过，因为代理执行自己的 DNS 解析。沙箱代理有自己的域名白名单。

---

## 7. Hook 安全模型

### 7.1 Hook 类型与权限交互

Claude Code 支持以下 Hook 类型，它们可以影响权限决策：

- **PreToolUse**: 工具调用前执行，可以修改输入或拒绝操作
- **PostToolUse**: 工具调用后执行
- **Notification**: 通知事件
- **Stop**: 停止事件

### 7.2 Hook 对权限的影响

在 `hasPermissionsToUseTool` 流程中，Hook 的 PermissionRequest 钩子可以在无交互环境（如异步 Agent）中做权限决策：

```typescript
// 异步 Agent 中的 Hook 优先级:
// 1. Hook 返回 allow → 允许执行
// 2. Hook 返回 deny → 拒绝执行
// 3. Hook 返回无决策 → 自动拒绝 (无交互环境默认拒绝)
```

Hook 决策的 `decisionReason` 类型为 `{ type: 'hook', hookName: string, reason?: string }`，与规则决策、模式决策等并列。

---

## 8. 危险模式清单

### 8.1 Bash 危险命令前缀 (`dangerousPatterns.ts`)

跨平台代码执行入口点：

```typescript
export const CROSS_PLATFORM_CODE_EXEC = [
  // 解释器
  'python', 'python3', 'python2', 'node', 'deno', 'tsx', 'ruby', 'perl', 'php', 'lua',
  // 包管理器运行器
  'npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run',
  // Shell
  'bash', 'sh',
  // 远程命令
  'ssh',
]
```

仅 Unix 的危险命令 (ant 额外添加)：

```typescript
// ant-only 额外列表:
'fa run', 'coo', 'gh', 'gh api', 'curl', 'wget', 'git',
'kubectl', 'aws', 'gcloud', 'gsutil'
```

完整 Bash 危险模式：

```typescript
export const DANGEROUS_BASH_PATTERNS = [
  ...CROSS_PLATFORM_CODE_EXEC,  // 上面所有跨平台命令
  'zsh', 'fish',               // 额外 shell
  'eval', 'exec',               // 代码执行
  'env',                        // 环境变量操纵
  'xargs',                      // 批量命令执行
  'sudo',                       // 权限提升
  // ant-only 额外命令...
]
```

### 8.2 PowerShell 危险命令 (`permissionSetup.ts`)

```typescript
// PowerShell 特有的危险命令:
'pwsh', 'powershell', 'cmd', 'wsl',          // Shell 嵌套
'iex', 'invoke-expression',                   // 代码执行
'icm', 'invoke-command',                      // 远程执行
'start-process', 'saps', 'start',             // 进程启动
'start-job', 'sajb', 'start-threadjob',       // 后台任务
'register-objectevent', 'register-engineevent', // 事件注册
'register-wmievent', 'register-scheduledjob',  // 计划任务
'new-pssession', 'nsn', 'enter-pssession', 'etsn', // 远程会话
'add-type',                                    // .NET C# 注入
'new-object',                                  // COM 对象
```

### 8.3 Bash 安全检查模式 (`bashSecurity.ts`)

命令替换和注入模式：

```typescript
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /=\(/, message: 'Zsh process substitution =()' },
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, message: 'Zsh equals expansion (=cmd)' },
  { pattern: /\$\(/, message: '$() command substitution' },
  { pattern: /\$\{/, message: '${} parameter substitution' },
  { pattern: /\$\[/, message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/, message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/, message: 'Zsh glob qualifier with command execution' },
  { pattern: /\}\s*always\s*\{/, message: 'Zsh always block (try/always construct)' },
  { pattern: /<#/, message: 'PowerShell comment syntax' },
]
```

Zsh 危险内置命令：

```typescript
const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',     // 模块加载网关
  'emulate',      // eval 等价物
  'sysopen',      // 文件描述符控制
  'sysread', 'syswrite', 'sysseek', // FD 读写
  'zpty',         // 伪终端执行
  'ztcp',         // TCP 连接
  'zsocket',      // Unix/TCP socket
  'mapfile',      // 关联数组文件 I/O
  'zf_rm', 'zf_mv', 'zf_ln', 'zf_chmod', 'zf_chown', // 内置文件操作
  'zf_mkdir', 'zf_rmdir', 'zf_chgrp',
])
```

### 8.4 文件系统危险路径 (`filesystem.ts`)

危险文件（自动编辑时需要额外确认）：

```typescript
export const DANGEROUS_FILES = [
  '.gitconfig', '.gitmodules',     // Git 配置
  '.bashrc', '.bash_profile',       // Shell 配置
  '.zshrc', '.zprofile', '.profile', // Shell 配置
  '.ripgreprc',                      // 搜索工具配置
  '.mcp.json', '.claude.json',      // Claude 配置
]

export const DANGEROUS_DIRECTORIES = [
  '.git',     // Git 仓库
  '.vscode',  // VS Code 配置
  '.idea',    // JetBrains 配置
  '.claude',  // Claude 配置
]
```

Windows 特殊路径模式检测：
- NTFS 交替数据流 (`file.txt::$DATA`)
- 8.3 短文件名 (`GIT~1`)
- 长路径前缀 (`\\?\C:\...`, `\\.\C:\...`)
- 尾部点和空格 (`.git.` → 规范化为 `.git`)
- DOS 设备名 (`.git.CON`, `.bashrc.AUX`)
- UNC 路径 (`\\server\share`)
- 路径遍历 (`...`)

---

## 9. Kill Switch 机制

### 9.1 Bypass Permissions Kill Switch

`bypassPermissionsKillswitch.ts` 实现了两个独立的 kill switch：

#### 远程禁用 (Statsig 门控)

```typescript
async function checkAndDisableBypassPermissionsIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<void> {
  // 只运行一次 (启动时检查)
  if (bypassPermissionsCheckRan) return
  bypassPermissionsCheckRan = true

  // 检查 bypass 模式是否可用
  if (!toolPermissionContext.isBypassPermissionsModeAvailable) return

  // 查询远程 Statsig 门控
  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) return

  // 强制切换到 default 模式并标记 bypass 不可用
  setAppState(prev => ({
    ...prev,
    toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext),
  }))
}
```

#### 紧急关闭

当 Statsig 门控触发但进程已经在 bypass 模式时：

```typescript
async function checkAndDisableBypassPermissions(
  currentContext: ToolPermissionContext,
): Promise<void> {
  if (!currentContext.isBypassPermissionsModeAvailable) return
  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) return

  // 紧急关闭进程!
  void gracefulShutdown(1, 'bypass_permissions_disabled')
}
```

### 9.2 Auto Mode Gate

Auto 模式有一个类似的多层门控机制：

```typescript
async function checkAndDisableAutoModeIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
  fastMode?: boolean,
): Promise<void> {
  // 1. 检查 GrowthBook 配置
  const { updateContext, notification } = await verifyAutoModeGateAccess(
    toolPermissionContext,
    fastMode,
  )

  // 2. 更新权限上下文 (可能降级 auto → default)
  setAppState(prev => {
    const nextCtx = updateContext(prev.toolPermissionContext)
    // 可能附带通知消息
    if (notification) {
      return { ...prev, toolPermissionContext: nextCtx, notifications: { ... } }
    }
    return nextCtx === prev.toolPermissionContext ? prev : { ...prev, toolPermissionContext: nextCtx }
  })
}
```

`verifyAutoModeGateAccess()` 检查：

1. **GrowthBook 配置**:
   - `enabled: 'enabled'` → 自动模式可用
   - `enabled: 'disabled'` → 自动模式被远程禁用 (circuit breaker)
   - `enabled: 'opt-in'` → 需要用户显式 opt-in

2. **设置检查**:
   - `settings.permissions.disableAutoMode === 'disable'` → 禁用

3. **模型支持**: 模型是否支持自动模式

4. **Fast Mode 断路器**: 某些模型配置下自动模式在 fast mode 中不可用

### 9.3 安全规则剥离

进入 auto/bypass 模式时，系统会自动剥离危险权限规则 (`permissionSetup.ts`)：

```typescript
// 在 auto 模式下剥离的危险规则:
// - Bash(*) 或 Bash(无内容) → 允许所有 Bash 命令
// - Bash(python:*) 等解释器前缀规则
// - PowerShell(*) 或 PowerShell(iex:*) 等
// - Agent(*) → 允许所有子代理 (绕过分类器评估)

function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent)
  )
}
```

被剥离的规则存储在 `strippedDangerousRules` 中，退出 auto 模式时可以恢复。

### 9.4 Kill Switch 重置

登录后可以重置 kill switch 状态，允许重新检查：

```typescript
export function resetBypassPermissionsCheck(): void {
  bypassPermissionsCheckRan = false
}

export function resetAutoModeGateCheck(): void {
  autoModeCheckRan = false
}
```

---

## 10. 关键安全设计原则总结

### 纵深防御 (Defense in Depth)

权限系统不是单一检查点，而是多层防御：

1. **规则层**: alwaysDeny > alwaysAllow > alwaysAsk
2. **工具特定检查层**: 每个工具的 `checkPermissions()` 方法
3. **分类器层**: AI 模型评估操作安全性
4. **沙箱层**: OS 级别的文件系统和网络隔离
5. **Hook 层**: 用户自定义的前置/后置钩子

### Fail-Safe 默认

系统始终采用"最安全"的默认值：
- 未知模式 → 回退到 `default` (需要确认)
- 分类器不可用 → 回退到提示用户
- 连续拒绝超过阈值 → 回退到提示模式
- Kill switch 触发 → 强制关闭或降级模式

### 最小权限原则

- Auto 模式自动剥离危险规则 (不信任过宽的 allow 规则)
- 沙箱默认拒绝写入关键配置文件
- SSRF 防护默认阻断所有私有 IP
- bypassPermissions 模式有远程禁用开关

### 时间敏感安全

- Kill switch 只运行一次 (启动时)，登录后重置
- 拒绝追踪有最大连续数和总数限制
- 沙箱配置在设置变更时动态更新 (通过 `settingsChangeDetector`)