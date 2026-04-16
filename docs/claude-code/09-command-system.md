---
title: "Step 9: 命令系统架构深度分析"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/09-command-system/
---


> 分析日期: 2026-04-16
> 核心文件: `src/types/command.ts`, `src/commands.ts`, `src/skills/loadSkillsDir.ts`, `src/skills/bundledSkills.ts`, `src/skills/bundled/index.ts`, `src/tools/SkillTool/SkillTool.ts`, `src/utils/processUserInput/processSlashCommand.tsx`, `src/utils/plugins/loadPluginCommands.ts`

---

## 1. 命令类型合约 (Command Discriminated Union)

命令系统的核心类型定义在 `src/types/command.ts` 中，采用判别联合 (discriminated union) 模式，通过 `type` 字段将命令分为三大类。

### 1.1 Command 类型分解

```
Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
         ────────────   ────────────────────────────────────────────────
         公共基础字段      三种互斥执行模式的判别联合
```

**定义位置**: `src/types/command.ts:205-206`

### 1.2 CommandBase -- 公共基础字段

**定义位置**: `src/types/command.ts:175-203`

```typescript
type CommandBase = {
  availability?: CommandAvailability[]   // 认证/提供商门控
  description: string                    // 命令描述
  hasUserSpecifiedDescription?: boolean   // 是否有用户显式描述
  isEnabled?: () => boolean               // 动态启用检查 (GrowthBook/平台/环境变量)
  isHidden?: boolean                      // 是否从 typeahead/help 隐藏
  name: string                            // 命令名称 (唯一标识符)
  aliases?: string[]                      // 命令别名
  isMcp?: boolean                         // 是否来自 MCP
  argumentHint?: string                   // 参数提示文本 (灰色显示)
  whenToUse?: string                      // Skill 规范中的详细使用场景
  version?: string                        // 命令/技能版本
  disableModelInvocation?: boolean        // 禁止模型主动调用
  userInvocable?: boolean                 // 用户是否可通过 /skill-name 调用
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'                        // 区分工作流支持的命令
  immediate?: boolean                     // 是否绕过队列立即执行
  isSensitive?: boolean                   // 参数是否从会话历史中脱敏
  userFacingName?: () => string           // 用户可见名称 (可覆盖 name)
}
```

辅助函数:
- `getCommandName(cmd)`: 返回 `cmd.userFacingName?.() ?? cmd.name` (`types/command.ts:209-211`)
- `isCommandEnabled(cmd)`: 返回 `cmd.isEnabled?.() ?? true` (`types/command.ts:214-216`)

### 1.3 PromptCommand -- 提示词扩展型

**定义位置**: `src/types/command.ts:25-57`

核心语义：将命令内容**展开为提示词注入到对话中**，模型直接处理展开后的文本。

```typescript
type PromptCommand = {
  type: 'prompt'                              // 判别标签
  progressMessage: string                     // 进度提示文本
  contentLength: number                       // 内容字符长度 (用于 token 估算)
  argNames?: string[]                         // 命名参数列表
  allowedTools?: string[]                     // 该技能允许的工具白名单
  model?: string                              // 模型覆盖
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: {                              // 插件元信息
    pluginManifest: PluginManifest
    repository: string
  }
  disableNonInteractive?: boolean             // 禁用非交互模式
  hooks?: HooksSettings                        // 技能调用时注册的钩子
  skillRoot?: string                           // 技能资源根目录
  context?: 'inline' | 'fork'                 // 执行上下文: inline=当前对话, fork=子代理
  agent?: string                              // fork 时使用的代理类型
  effort?: EffortValue                        // 努力级别覆盖
  paths?: string[]                            // 文件路径 glob 模式 (条件激活)
  getPromptForCommand(                        // 核心: 生成提示词内容
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]>
}
```

**执行语义**:
- `context: 'inline'` (默认): 技能内容展开到当前对话，作为用户消息注入
- `context: 'fork'`: 在独立子代理中执行，拥有独立的上下文和 token 预算

### 1.4 LocalCommand -- 本地文本型

**定义位置**: `src/types/command.ts:74-78`

核心语义：执行本地逻辑，返回**纯文本结果**，不涉及 UI 渲染。

```typescript
type LocalCommand = {
  type: 'local'                         // 判别标签
  supportsNonInteractive: boolean        // 是否支持非交互模式
  load: () => Promise<LocalCommandModule> // 懒加载实现
}
```

`LocalCommandCall` 签名 (`src/types/command.ts:62-65`):
```typescript
type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>
```

`LocalCommandResult` 返回类型 (`src/types/command.ts:16-23`):
```typescript
type LocalCommandResult =
  | { type: 'text'; value: string }           // 文本输出
  | { type: 'compact'; compactionResult: CompactionResult; displayText?: string }
  | { type: 'skip' }                          // 跳过消息
```

### 1.5 LocalJSXCommand -- 本地 UI 型

**定义位置**: `src/types/command.ts:144-152`

核心语义：渲染 **Ink (React CLI) UI 组件**，用于交互式操作界面。

```typescript
type LocalJSXCommand = {
  type: 'local-jsx'                            // 判别标签
  load: () => Promise<LocalJSXCommandModule>   // 懒加载实现
}
```

`LocalJSXCommandCall` 签名 (`src/types/command.ts:131-135`):
```typescript
type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,    // 完成回调
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
) => Promise<React.ReactNode>      // 返回 React 组件树
```

`LocalJSXCommandOnDone` 回调 (`src/types/command.ts:117-126`):
```typescript
type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: 'skip' | 'system' | 'user'  // 结果显示方式
    shouldQuery?: boolean                   // 完成后是否查询模型
    metaMessages?: string[]                 // 额外元消息
    nextInput?: string                      // 预填充下一条输入
    submitNextInput?: boolean               // 是否自动提交下一条输入
  },
) => void
```

`LocalJSXCommandContext` (`src/types/command.ts:80-98`): 扩展 `ToolUseContext`，增加 `setMessages`、`options`、`onChangeAPIKey`、`onChangeDynamicMcpConfig`、`onInstallIDEExtension`、`resume` 等交互上下文。

### 1.6 三种类型的对比总结

| 特征 | PromptCommand | LocalCommand | LocalJSXCommand |
|------|--------------|-------------|-----------------|
| 执行模式 | 提示词注入对话 | 本地函数调用 | React UI 渲染 |
| 模型是否可见 | 是 (内容发给模型) | 否 (仅本地) | 否 (仅本地 UI) |
| Bridge 安全 | 是 (文本展开天然安全) | 需显式白名单 | 否 (Ink UI 不兼容) |
| 典型用途 | 技能/工作流 | 配置/查询 | 交互面板/选择器 |
| 懒加载 | 通过 getPromptForCommand | 通过 load() | 通过 load() |
| 子代理支持 | context:'fork' | 无 | 无 |
| 返回类型 | ContentBlockParam[] | LocalCommandResult | React.ReactNode |

### 1.7 CommandAvailability -- 认证门控

**定义位置**: `src/types/command.ts:169-173`

```typescript
type CommandAvailability =
  | 'claude-ai'    // claude.ai OAuth 订阅者 (Pro/Max/Team/Enterprise)
  | 'console'      // Console API 密钥用户 (直接 api.anthropic.com)
```

门控逻辑 (`src/commands.ts:417-443`):
- `availability` 未设置 = 全局可用
- `'claude-ai'` -> `isClaudeAISubscriber()` 为 true 时可用
- `'console'` -> 非 claude.ai 订阅者 + 非 3P 服务 + 第一方 base URL 时可用
- 不记忆化 -- 认证状态可在会话中变更（如 /login 后立即生效）

---

## 2. 命令注册与发现流

### 2.1 命令发现的六大数据源

命令发现由 `getCommands(cwd)` 函数统一调度，数据从六个独立来源并行加载。

**调度入口**: `src/commands.ts:476-517` (`getCommands`)

```
getCommands(cwd)
  │
  └─► loadAllCommands(cwd)   [src/commands.ts:449-469, memoize]
       │
       ├─► getSkills(cwd)              [src/commands.ts:353-398]
       │    ├─► getSkillDirCommands(cwd)      → 磁盘技能目录
       │    ├─► getPluginSkills()              → 插件技能
       │    ├─► getBundledSkills()             → 内置技能
       │    └─► getBuiltinPluginSkillCommands() → 内置插件技能
       │
       ├─► getPluginCommands()          → 插件命令
       │
       ├─► getWorkflowCommands(cwd)     → 工作流命令 (feature gate)
       │
       └─► COMMANDS()                   → 静态注册的硬编码命令
            [src/commands.ts:258-346, memoize]
```

### 2.2 源 1: 磁盘技能目录 (Skill Dir Commands)

**核心函数**: `getSkillDirCommands()` (`src/skills/loadSkillsDir.ts:638-804`)

搜索路径 (并行加载):
```
优先级 (从高到低):
  1. managedSkillsDir   → <managed-path>/.claude/skills/     (策略/管理设置)
  2. userSkillsDir      → ~/.claude/skills/                  (用户设置)
  3. projectSkillsDirs  → .claude/skills/ (向上遍历至 home)   (项目设置)
  4. additionalDirs     → --add-dir 指定的路径/.claude/skills/ (附加目录)
  5. legacyCommandsDir  → .claude/commands/ (向上遍历)        (遗留命令)
```

磁盘技能加载流程:
```
loadSkillsFromSkillsDir(basePath, source)     [loadSkillsDir.ts:407-480]
  │
  ├─► fs.readdir(basePath)
  │
  └─► 对每个子目录 entry:
       ├─► 读取 skill-name/SKILL.md
       ├─► parseFrontmatter(content) → 提取 YAML 元数据
       ├─► parseSkillFrontmatterFields() → 解析规范字段
       ├─► parseSkillPaths() → 解析条件路径模式
       └─► createSkillCommand() → 构造 Command 对象
```

**去重策略**: 通过 `realpath()` 解析符号链接后基于文件标识去重，先加载者优先 (`loadSkillsDir.ts:725-763`)。

**条件技能 (Conditional Skills)**:
- 带 `paths` frontmatter 的技能在加载时不立即激活
- 存入 `conditionalSkills` Map (`loadSkillsDir.ts:827`)
- 当文件操作触及匹配 `paths` 模式的文件时激活 (`activateConditionalSkillsForPaths`, `loadSkillsDir.ts:997-1058`)
- 使用 `ignore` 库进行 gitignore 风格匹配

**动态技能发现 (Dynamic Skill Discovery)**:
- 文件操作时向上遍历目录树，查找 `.claude/skills/` 目录
- `discoverSkillDirsForPaths()` (`loadSkillsDir.ts:861-915`)
- `addSkillDirectories()` (`loadSkillsDir.ts:923-975`)
- gitignored 目录被跳过
- 触发 `skillsLoaded` 信号通知缓存清理

**--bare 模式**: 跳过自动发现，仅加载 `--add-dir` 路径中的技能 (`loadSkillsDir.ts:658-675`)。

### 2.3 源 2: 内置技能 (Bundled Skills)

**注册机制**: `registerBundledSkill()` (`src/skills/bundledSkills.ts:53-100`)

初始化入口: `initBundledSkills()` (`src/skills/bundled/index.ts:24-79`)

```
initBundledSkills()
  │
  ├─► registerUpdateConfigSkill()     → /update-config
  ├─► registerKeybindingsSkill()      → /keybindings
  ├─► registerVerifySkill()           → /verify (ant-only)
  ├─► registerDebugSkill()            → /debug
  ├─► registerLoremIpsumSkill()       → /lorem-ipsum
  ├─► registerSkillifySkill()         → /skillify
  ├─► registerRememberSkill()         → /remember
  ├─► registerSimplifySkill()          → /simplify
  ├─► registerBatchSkill()            → /batch
  ├─► registerStuckSkill()            → /stuck
  │
  ├─► [KAIROS]         → registerDreamSkill()
  ├─► [REVIEW_ARTIFACT] → registerHunterSkill()
  ├─► [AGENT_TRIGGERS]  → registerLoopSkill()
  ├─► [AGENT_TRIGGERS_REMOTE] → registerScheduleRemoteAgentsSkill()
  ├─► [BUILDING_CLAUDE_APPS]  → registerClaudeApiSkill()
  ├─► [shouldAutoEnableClaudeInChrome()] → registerClaudeInChromeSkill()
  └─► [RUN_SKILL_GENERATOR]    → registerRunSkillGeneratorSkill()
```

`registerBundledSkill()` 将 `BundledSkillDefinition` 转换为 `Command` 对象 (`type: 'prompt'`, `source: 'bundled'`, `loadedFrom: 'bundled'`)。带 `files` 字段的技能会延迟提取到磁盘 (首次调用时，通过闭包级 Promise 记忆化防止并发竞态)。

### 2.4 源 3: 插件命令与技能

**核心函数**:
- `getPluginCommands()` (`src/utils/plugins/loadPluginCommands.ts:414-677`)
- `getPluginSkills()` (`src/utils/plugins/loadPluginCommands.ts:840-942`)

插件命令加载流程:
```
getPluginCommands()
  │
  ├─► loadAllPluginsCacheOnly() → 获取已启用插件列表
  │
  └─► 对每个插件 (并行):
       ├─► plugin.commandsPath → loadCommandsFromDirectory()
       ├─► plugin.commandsPaths[] → loadCommandsFromDirectory() / 单文件加载
       └─► plugin.commandsMetadata → 内联内容命令
```

插件技能加载流程:
```
getPluginSkills()
  │
  └─► 对每个插件 (并行):
       ├─► plugin.skillsPath → loadSkillsFromDirectory()
       └─► plugin.skillsPaths[] → loadSkillsFromDirectory()
```

插件命令命名规则: `plugin-name:command-name` 或 `plugin-name:namespace:command-name` (`loadPluginCommands.ts:60-97`)。

`--bare` 模式下跳过 marketplace 插件自动加载，仅加载 `--plugin-dir` 指定的内联插件 (`loadPluginCommands.ts:414-421`)。

### 2.5 源 4: MCP 技能

**入口**: `getMcpSkillCommands()` (`src/commands.ts:547-559`)

MCP 技能来自 MCP 服务器的 `prompts/list` 响应，通过 `AppState.mcp.commands` 存取。需同时满足:
- `cmd.type === 'prompt'`
- `cmd.loadedFrom === 'mcp'`
- `!cmd.disableModelInvocation`
- `feature('MCP_SKILLS')` 启用

MCP 技能通过 `mcpSkillBuilders.ts` 间接使用 `createSkillCommand` 和 `parseSkillFrontmatterFields`，避免循环依赖 (`mcpSkillBuilders.ts:26-44`)。注册发生在 `loadSkillsDir.ts` 模块初始化时 (`loadSkillsDir.ts:1083-1086`)。

### 2.6 源 5: 工作流命令

**条件**: `feature('WORKFLOW_SCRIPTS')` 启用时，通过 `getWorkflowCommands(cwd)` 从 `createWorkflowCommand.ts` 加载 (`commands.ts:401-406`)。

### 2.7 源 6: 硬编码静态命令

**定义位置**: `src/commands.ts:258-346` (`COMMANDS()` memoize)

通过静态 import 引入约 80 个命令模块，每个模块导出一个满足 `Command` 类型约束的对象。部分命令受 feature gate 控制，仅在特定条件下加载：

```typescript
// 条件加载示例 (commands.ts:62-122)
const proactive = feature('PROACTIVE') || feature('KAIROS')
  ? require('./commands/proactive.js').default : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default : null
```

### 2.8 命令合并与过滤

**合并顺序** (`src/commands.ts:460-468`):
```
最终命令列表 = [
  ...bundledSkills,         // 内置技能 (最高优先级)
  ...builtinPluginSkills,   // 内置插件技能
  ...skillDirCommands,      // 磁盘技能目录
  ...workflowCommands,       // 工作流命令
  ...pluginCommands,         // 插件命令
  ...pluginSkills,           // 插件技能
  ...COMMANDS(),             // 硬编码静态命令 (最低优先级)
]
```

**动态技能插入** (`src/commands.ts:480-516`):
动态发现的技能插入在插件技能之后、内置命令之前。

**过滤管线** (`src/commands.ts:483-484`):
```
allCommands.filter(cmd => meetsAvailabilityRequirement(cmd) && isCommandEnabled(cmd))
```

- `meetsAvailabilityRequirement()`: 认证门控检查 (`commands.ts:417-443`)
- `isCommandEnabled()`: 动态启用检查 (`types/command.ts:214-216`，默认 true)

**内部命令过滤** (`commands.ts:343-345`):
```
...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
  ? INTERNAL_ONLY_COMMANDS
  : [])
```

### 2.9 缓存架构

| 缓存 | 函数 | 清除方法 |
|------|------|---------|
| loadAllCommands | lodash memoize (by cwd) | `clearCommandMemoizationCaches()` |
| getSkillToolCommands | lodash memoize | `clearCommandMemoizationCaches()` |
| getSlashCommandToolSkills | lodash memoize | `clearCommandMemoizationCaches()` |
| getSkillDirCommands | lodash memoize | `clearSkillCaches()` |
| getPluginCommands | lodash memoize | `clearPluginCommandCache()` |
| getPluginSkills | lodash memoize | `clearPluginSkillsCache()` |
| skillIndex (搜索) | lodash memoize | `clearSkillIndexCache()` |

`clearCommandsCache()` (`commands.ts:534-539`) 清除全部缓存。动态技能加载时通过 `skillsLoaded` 信号 (`loadSkillsDir.ts:832`) 通知清除。

**关键区分**: 负载层（磁盘 I/O、动态导入）记忆化，但过滤层（认证、启用检查）不记忆化 -- 确保 `/login` 后认证变更立即生效。

---

## 3. 完整命令清单

### 3.1 静态硬编码命令 (COMMANDS 数组)

以下表格基于 `src/commands.ts:258-346` 的 `COMMANDS()` 数组。bridge-safe 列使用以下规则:
- `prompt` 类型: 始终安全 (Yes)
- `local-jsx` 类型: 始终不安全 (No)
- `local` 类型: 需在 `BRIDGE_SAFE_COMMANDS` 白名单中才安全

| name | type | availability | bridge-safe | source |
|------|------|-------------|-------------|--------|
| add-dir | local-jsx | - | No | commands/add-dir |
| advisor | local | - | No | commands/advisor.ts |
| agents | local-jsx | - | No | commands/agents |
| branch | local | - | No | commands/branch |
| btw | local | - | Yes (REMOTE) | commands/btw |
| chrome | local-jsx | - | No | commands/chrome |
| clear | local | - | Yes (both) | commands/clear |
| color | local | - | Yes (REMOTE) | commands/color |
| compact | local | - | Yes (BRIDGE) | commands/compact |
| config | local-jsx | - | No | commands/config |
| context | local-jsx | - | No | commands/context |
| context-noninteractive | local | - | No | commands/context |
| copy | local | - | Yes (REMOTE) | commands/copy |
| cost | local | - | Yes (both) | commands/cost |
| desktop | local-jsx | - | No | commands/desktop |
| diff | local-jsx | - | No | commands/diff |
| doctor | local-jsx | - | No | commands/doctor |
| effort | local-jsx | - | No | commands/effort |
| exit | local-jsx | - | Yes (REMOTE) | commands/exit |
| export | local-jsx | - | No | commands/export |
| extra-usage | local-jsx | claude-ai, console | No | commands/extra-usage |
| extra-usage-ni | local | claude-ai, console | No | commands/extra-usage |
| fast | local-jsx | - | No | commands/fast |
| feedback | local | - | Yes (REMOTE) | commands/feedback |
| files | local | - | Yes (BRIDGE) | commands/files |
| heapdump | local | - | No | commands/heapdump |
| help | local-jsx | - | Yes (REMOTE) | commands/help |
| hooks | local-jsx | - | No | commands/hooks |
| ide | local-jsx | - | No | commands/ide |
| init | prompt | - | Yes (type) | commands/init.ts |
| insights | prompt | - | Yes (type) | commands/insights.ts |
| install-github-app | local-jsx | - | No | commands/install-github-app |
| install-slack-app | local-jsx | - | No | commands/install-slack-app |
| keybindings | local | - | Yes (REMOTE) | commands/keybindings |
| login | local-jsx | - | No | commands/login |
| logout | local-jsx | - | No | commands/logout |
| mcp | local-jsx | - | No | commands/mcp |
| memory | local-jsx | - | No | commands/memory |
| mobile | local | - | Yes (REMOTE) | commands/mobile |
| model | local-jsx | - | No | commands/model |
| output-style | local-jsx | - | No | commands/output-style |
| passes | local-jsx | - | No | commands/passes |
| permissions | local-jsx | - | No | commands/permissions |
| plan | local-jsx | - | Yes (REMOTE) | commands/plan |
| plugin | local-jsx | - | No | commands/plugin |
| pr-comments | local-jsx | - | No | commands/pr_comments |
| privacy-settings | local-jsx | - | No | commands/privacy-settings |
| rate-limit-options | local-jsx | - | No | commands/rate-limit-options |
| release-notes | local | - | Yes (BRIDGE) | commands/release-notes |
| reload-plugins | local-jsx | - | No | commands/reload-plugins |
| remote-env | local-jsx | - | No | commands/remote-env |
| rename | local-jsx | - | No | commands/rename |
| resume | local-jsx | - | No | commands/resume |
| review | prompt | - | Yes (type) | commands/review.ts |
| ultrareview | local-jsx | - | No | commands/review.ts |
| rewind | local | - | No | commands/rewind |
| sandbox-toggle | local-jsx | - | No | commands/sandbox-toggle |
| security-review | prompt | - | Yes (type) | commands/security-review.ts |
| session | local-jsx | - | Yes (REMOTE) | commands/session |
| skills | local-jsx | - | No | commands/skills |
| stats | local-jsx | - | No | commands/stats |
| status | local-jsx | - | No | commands/status |
| statusline | local | - | Yes (REMOTE) | commands/statusline |
| stickers | local | - | Yes (REMOTE) | commands/stickers |
| tag | local | - | No | commands/tag |
| tasks | local-jsx | - | No | commands/tasks |
| terminal-setup | local-jsx | - | No | commands/terminalSetup |
| theme | local | - | Yes (REMOTE) | commands/theme |
| thinkback | local | - | No | commands/thinkback |
| thinkback-play | local | - | No | commands/thinkback-play |
| upgrade | local-jsx | - | No | commands/upgrade |
| usage | local | - | Yes (REMOTE) | commands/usage |
| vim | local | - | Yes (REMOTE) | commands/vim |
| env | local-jsx | - | No | commands/env |
| oauth-refresh | local-jsx | - | No | commands/oauth-refresh |
| debug-tool-call | local-jsx | - | No | commands/debug-tool-call |

### 3.2 Internal-Only 命令 (仅 Ant 内部用户)

**定义位置**: `src/commands.ts:225-254`

仅当 `process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO` 时加载。

| name | type | bridge-safe | source |
|------|------|-------------|--------|
| backfill-sessions | local-jsx | No | commands/backfill-sessions |
| break-cache | local-jsx | No | commands/break-cache |
| bughunter | local-jsx | No | commands/bughunter |
| commit | prompt | Yes (type) | commands/commit.ts |
| commit-push-pr | prompt | Yes (type) | commands/commit-push-pr.ts |
| ctx-viz | local-jsx | No | commands/ctx_viz |
| good-claude | local-jsx | No | commands/good-claude |
| issue | local-jsx | No | commands/issue |
| init-verifiers | prompt | Yes (type) | commands/init-verifiers.ts |
| force-snip | local | No | commands/force-snip.ts |
| mock-limits | local-jsx | No | commands/mock-limits |
| bridge-kick | local | No | commands/bridge-kick.ts |
| version | local | No | commands/version.ts |
| ultraplan | prompt | Yes (type) | commands/ultraplan.ts |
| subscribe-pr | prompt | Yes (type) | commands/subscribe-pr.ts |
| reset-limits | local | No | commands/reset-limits |
| reset-limits-ni | local | No | commands/reset-limits |
| onboarding | local-jsx | No | commands/onboarding |
| share | local | No | commands/share |
| summary | local | Yes (BRIDGE) | commands/summary |
| teleport | local | No | commands/teleport |
| ant-trace | local | No | commands/ant-trace |
| perf-issue | local | No | commands/perf-issue |
| autofix-pr | local-jsx | No | commands/autofix-pr |
| agents-platform | local-jsx | No | commands/agents-platform |

### 3.3 Feature-Gated 命令 (条件加载)

| name | type | feature gate | source |
|------|------|-------------|--------|
| proactive | prompt | PROACTIVE / KAIROS | commands/proactive.ts |
| brief | prompt | KAIROS / KAIROS_BRIEF | commands/brief.ts |
| assistant | local-jsx | KAIROS | commands/assistant |
| bridge | local-jsx | BRIDGE_MODE | commands/bridge |
| remote-control-server | local-jsx | DAEMON + BRIDGE_MODE | commands/remoteControlServer |
| voice | local-jsx | VOICE_MODE | commands/voice |
| force-snip | local | HISTORY_SNIP | commands/force-snip.ts |
| workflows | local | WORKFLOW_SCRIPTS | commands/workflows |
| web (remote-setup) | local-jsx | CCR_REMOTE_SETUP | commands/remote-setup |
| subscribe-pr | prompt | KAIROS_GITHUB_WEBHOOKS | commands/subscribe-pr.ts |
| ultraplan | prompt | ULTRAPLAN | commands/ultraplan.ts |
| torch | prompt | TORCH | commands/torch.ts |
| peers | local-jsx | UDS_INBOX | commands/peers |
| fork | local-jsx | FORK_SUBAGENT | commands/fork |
| buddy | local-jsx | BUDDY | commands/buddy |

### 3.4 内置技能 (Bundled Skills)

**注册入口**: `initBundledSkills()` (`src/skills/bundled/index.ts:24-79`)

| name | 条件 | disableModelInvocation | userInvocable |
|------|------|----------------------|---------------|
| update-config | 无条件 | No | true |
| keybindings | 无条件 | No | true |
| verify | ant-only | No | true |
| debug | 无条件 | Yes (true) | true |
| lorem-ipsum | 无条件 | No | true |
| skillify | 无条件 | No | true |
| remember | isAutoMemoryEnabled() | No | true |
| simplify | 无条件 | No | true |
| batch | 无条件 | No | true |
| stuck | 无条件 | No | true |
| dream | KAIROS / KAIROS_DREAM | No | true |
| hunter | REVIEW_ARTIFACT | No | true |
| loop | AGENT_TRIGGERS | No | true |
| schedule-remote-agents | AGENT_TRIGGERS_REMOTE | No | true |
| claude-api | BUILDING_CLAUDE_APPS | No | true |
| claude-in-chrome | shouldAutoEnableClaudeInChrome() | No | true |
| run-skill-generator | RUN_SKILL_GENERATOR | No | true |

### 3.5 Bridge 安全分类总结

**REMOTE_SAFE_COMMANDS** (`src/commands.ts:619-637`): 仅影响本地 TUI 状态，不依赖本地文件系统/git/shell/IDE/MCP:
session, exit, clear, help, theme, color, vim, cost, usage, copy, btw, feedback, plan, keybindings, statusline, stickers, mobile

**BRIDGE_SAFE_COMMANDS** (`src/commands.ts:651-660`): local 类型中可在 bridge 上安全执行的:
compact, clear, cost, summary, release-notes, files

**isBridgeSafeCommand()** 规则 (`src/commands.ts:672-676`):
- `local-jsx` -> 始终 false (Ink UI 不兼容远程渲染)
- `prompt` -> 始终 true (文本展开天然安全)
- `local` -> 需在 `BRIDGE_SAFE_COMMANDS` 白名单中

**filterCommandsForRemoteMode()** (`src/commands.ts:684-686`): 远程模式预过滤，仅保留 `REMOTE_SAFE_COMMANDS` 中的命令，防止 CCR 初始化前短暂显示本地命令。

---

## 4. 命令执行流图

### 4.1 用户输入路径 (TUI)

```
用户输入 "/command-name args"
  │
  ▼
processUserInput()                              [processUserInput.ts:85-270]
  │
  ├─► parseSlashCommand(input)                  [slashCommandParsing.ts]
  │    → 提取 commandName 和 args
  │
  ├─► [bridgeOrigin] isBridgeSafeCommand(cmd)?
  │    ├─ Yes → 清除 skipSlash 标志，继续执行
  │    └─ No  → 返回 "/xxx isn't available over Remote Control"
  │
  └─► processSlashCommand()                    [processSlashCommand.tsx]
       │
       ├─► findCommand(commandName, commands)    [commands.ts:688-698]
       │    → 匹配 name / userFacingName() / aliases
       │
       ├─► [命令未找到] → "Unknown command" 消息
       │
       └─► 按类型分发:
            │
            ├─ type === 'prompt'
            │    │
            │    ├─ context === 'fork'
            │    │    └─► executeForkedSlashCommand()
            │    │         [processSlashCommand.tsx:62]
            │    │         │
            │    │         ├─► prepareForkedCommandContext()
            │    │         │    → cmd.getPromptForCommand(args, ctx)
            │    │         │    → 构造子代理定义 (agent/model/effort)
            │    │         ├─► runAgent() → 子代理独立执行
            │    │         │    → 独立 token 预算和上下文窗口
            │    │         │    → [KAIROS] 可异步后台返回
            │    │         └─► extractResultText(agentMessages)
            │    │
            │    └─ context === 'inline' (默认)
            │         └─► getMessagesForPromptSlashCommand()
            │              │
            │              ├─► cmd.getPromptForCommand(args, ctx)
            │              │    → 生成 ContentBlockParam[]
            │              ├─► executeShellCommandsInPrompt()
            │              │    → 执行 !`cmd` 和 ```! ... ``` 内联 shell 命令
            │              ├─► substituteArguments()
            │              │    → 替换 $ARGUMENTS / 命名参数
            │              ├─► addInvokedSkill() → 注册 compaction 保留
            │              ├─► registerSkillHooks() → 注册技能钩子
            │              └─► 返回 messages + allowedTools + model + effort
            │
            ├─ type === 'local'
            │    └─► cmd.load() → module.call(args, context)
            │         → LocalCommandResult (text | compact | skip)
            │
            └─ type === 'local-jsx'
                 └─► cmd.load() → module.call(onDone, context, args)
                      → React.ReactNode (Ink 渲染)
                      → onDone(result?, options?)
                         ├─ options.display: 'skip' | 'system' | 'user'
                         ├─ options.shouldQuery: 是否触发模型查询
                         ├─ options.metaMessages: 额外元消息
                         ├─ options.nextInput: 预填充输入
                         └─ options.submitNextInput: 是否自动提交
```

### 4.2 模型调用路径 (SkillTool)

```
模型输出 tool_use: {skill: "command-name", args: "..."}
  │
  ▼
SkillTool.validateInput()                       [SkillTool.ts:354-430]
  │
  ├─► 去除前导 /
  ├─► getAllCommands(context) → 包含 MCP 技能
  ├─► findCommand() → 验证命令存在
  ├─► disableModelInvocation → 拒绝
  └─► type !== 'prompt' → 拒绝 (仅 prompt 类型可通过 SkillTool)
  │
  ▼
SkillTool.checkPermissions()                    [SkillTool.ts:432-578]
  │
  ├─► 检查 deny 规则 → deny 时阻止
  ├─► [EXPERIMENTAL_SKILL_SEARCH] 远程规范技能 → 自动允许
  ├─► 检查 allow 规则 → allow 时放行
  ├─► skillHasOnlySafeProperties() → 自动允许
  │    (SAFE_SKILL_PROPERTIES 白名单: type, name, description, isEnabled, etc.)
  └─► 默认: ask (请求用户许可)
  │
  ▼
SkillTool.call()                                [SkillTool.ts:580-841]
  │
  ├─► [远程规范技能] _canonical_<slug>
  │    └─► executeRemoteSkill()
  │         → 从 AKI/GCS 加载 SKILL.md → 注入用户消息
  │
  ├─► context === 'fork'
  │    └─► executeForkedSkill()
  │         → prepareForkedCommandContext() → runAgent()
  │         → 独立子代理，返回 result 文本
  │
  └─► context === 'inline' (默认)
       └─► processPromptSlashCommand()
            → 与用户路径的 getMessagesForPromptSlashCommand() 相同逻辑
            → 返回 newMessages + contextModifier
               ├─► allowedTools: 注入到 toolPermissionContext
               ├─► model: 覆盖模型选择
               └─► effort: 覆盖努力级别
```

### 4.3 提示词展开管线 (Prompt Expansion Pipeline)

所有 PromptCommand 类型共享的展开管线:

```
getPromptForCommand(args, context)
  │
  ▼
Markdown 内容 (可能含 YAML frontmatter)
  │
  ├─► substituteArguments(content, args, true, argNames)
  │    → 替换 $ARGUMENTS / $1, $2 / 命名参数
  │
  ├─► 替换 ${CLAUDE_SKILL_DIR}
  │    → 技能目录绝对路径
  │
  ├─► 替换 ${CLAUDE_SESSION_ID}
  │    → 当前会话 ID
  │
  ├─► [插件] substitutePluginVariables()
  │    → 替换 ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}
  │
  ├─► [插件] substituteUserConfigInContent()
  │    → 替换 ${user_config.X} (敏感键用占位符)
  │
  ├─► [非 MCP] executeShellCommandsInPrompt()
  │    → 执行 !`command` 和 ```! ... ``` 内联 shell 命令
  │    → MCP 技能跳过 (远程不可信)
  │
  └─► 返回 ContentBlockParam[]
       → 作为用户消息注入对话
```

### 4.4 子代理执行管线 (Forked Execution)

```
context: 'fork' 触发
  │
  ▼
prepareForkedCommandContext()                    [forkedAgent.ts]
  │
  ├─► cmd.getPromptForCommand(args, ctx)
  │    → 获取技能内容
  │
  ├─► 构造 baseAgent 定义
  │    → agentType: cmd.agent 或 'general-purpose'
  │
  ├─► 构造 promptMessages
  │    → 包含技能内容的用户消息
  │
  └─► 返回 {modifiedGetAppState, baseAgent, promptMessages, skillContent}

  │
  ▼
runAgent()                                      [AgentTool/runAgent.ts]
  │
  ├─► 独立的 token 预算和上下文窗口
  ├─► 可使用 cmd.model 覆盖模型
  ├─► 可使用 cmd.effort 覆盖努力级别
  ├─► 可使用 cmd.allowedTools 限制工具
  │
  └─► extractResultText(agentMessages)
       → 提取最终结果文本
```

---

## 5. 技能转换机制

### 5.1 命令向技能的演进

Claude Code 的命令系统正在经历从"命令"到"技能"的架构迁移。

**遗留路径** (`/commands/`): 单 `.md` 文件或目录内 `SKILL.md`
**新路径** (`/skills/`): 仅支持目录格式 `skill-name/SKILL.md`

`loadedFrom` 字段标记命令来源:
- `'commands_DEPRECATED'`: 遗留 `/commands/` 目录加载
- `'skills'`: 新 `/skills/` 目录加载
- `'bundled'`: 编译时内置技能
- `'plugin'`: 插件提供
- `'managed'`: 策略/管理设置
- `'mcp'`: MCP 服务器提供

### 5.2 Markdown → Command 转换流程 (磁盘技能)

```
SKILL.md 文件
  │
  ▼
parseFrontmatter(content, filePath)             [frontmatterParser.ts]
  │
  ├─► 提取 YAML frontmatter 元数据
  └─► 分离 markdown 正文内容
  │
  ▼
parseSkillFrontmatterFields()                   [loadSkillsDir.ts:185-265]
  │
  ├─► displayName        ← frontmatter.name
  ├─► description        ← frontmatter.description || 首行提取
  ├─► hasUserSpecifiedDescription ← 是否显式声明
  ├─► allowedTools       ← parseSlashCommandToolsFromFrontmatter()
  ├─► argumentHint       ← frontmatter['argument-hint']
  ├─► argumentNames      ← parseArgumentNames(frontmatter.arguments)
  ├─► whenToUse          ← frontmatter.when_to_use
  ├─► version            ← frontmatter.version
  ├─► model              ← parseUserSpecifiedModel(frontmatter.model)
  ├─► disableModelInvocation ← parseBooleanFrontmatter()
  ├─► userInvocable      ← parseBooleanFrontmatter() (默认 true)
  ├─► hooks              ← parseHooksFromFrontmatter() + HooksSchema 验证
  ├─► executionContext   ← frontmatter.context ('fork' | undefined)
  ├─► agent              ← frontmatter.agent
  ├─► effort             ← parseEffortValue(frontmatter.effort)
  └─► shell              ← parseShellFrontmatter(frontmatter.shell)
  │
  ▼
createSkillCommand()                            [loadSkillsDir.ts:270-401]
  │
  └─► 构造完整的 Command 对象 (type: 'prompt')
       ├─► userFacingName(): 返回 displayName || skillName
       ├─► getPromptForCommand(): 含完整展开管线
       │    ├─► 添加 "Base directory for this skill: ..." 前缀
       │    ├─► substituteArguments()
       │    ├─► ${CLAUDE_SKILL_DIR} 替换
       │    ├─► ${CLAUDE_SESSION_ID} 替换
       │    ├─► [非 MCP] executeShellCommandsInPrompt()
       │    └─► 返回 ContentBlockParam[]
       └─► source / loadedFrom 标记来源
```

### 5.3 内置技能 → Command 转换

```
BundledSkillDefinition                         [bundledSkills.ts:16-41]
  │
  ▼
registerBundledSkill(definition)                [bundledSkills.ts:53-100]
  │
  ├─► [有 files 字段] → 设置延迟提取到磁盘
  │    ├─► getBundledSkillExtractDir(name) → 确定性目录
  │    ├─► 包装 getPromptForCommand:
  │    │    ├─► extractBundledSkillFiles() → 写文件到磁盘
  │    │    └─► prependBaseDir(blocks, extractedDir)
  │    └─► 进程级 Promise 记忆化 (防止并发竞态)
  │
  └─► 构造 Command 对象
       ├─► type: 'prompt'
       ├─► source: 'bundled'
       ├─► loadedFrom: 'bundled'
       ├─► hasUserSpecifiedDescription: true
       ├─► isHidden: !(definition.userInvocable ?? true)
       └─► 推入 bundledSkills 全局数组
```

### 5.4 插件 Markdown → Command 转换

```
Plugin SKILL.md / command.md
  │
  ▼
createPluginCommand()                           [loadPluginCommands.ts:218-412]
  │
  ├─► parseFrontmatter() → 提取元数据
  ├─► 命名: pluginName:commandName 或 pluginName:namespace:commandName
  ├─► [skillMode] 添加 "Base directory for this skill: ..." 前缀
  │
  └─► getPromptForCommand() 含:
       ├─► substituteArguments()
       ├─► substitutePluginVariables()
       │    → ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}
       ├─► substituteUserConfigInContent()
       │    → ${user_config.X} (敏感键 → 占位符)
       ├─► [skillMode] ${CLAUDE_SKILL_DIR} 替换
       ├─► ${CLAUDE_SESSION_ID} 替换
       └─► executeShellCommandsInPrompt()
```

### 5.5 MCP 技能转换

MCP 服务器通过 `prompts/list` 提供 prompt 定义，在 `mcpSkills.ts` 中通过 `mcpSkillBuilders.ts` 间接调用 `createSkillCommand()` 和 `parseSkillFrontmatterFields()`:

```
MCP prompt definition
  │
  ▼
getMCPSkillBuilders()                           [mcpSkillBuilders.ts:37-44]
  │
  ├─► parseSkillFrontmatterFields() → 解析规范字段
  └─► createSkillCommand() → 构造 Command 对象
       ├─► loadedFrom: 'mcp'
       └─► getPromptForCommand() 中跳过 shell 命令执行 (安全限制)
```

`mcpSkillBuilders.ts` 是一个依赖图叶子节点，用于打破 `client.ts → mcpSkills.ts → loadSkillsDir.ts → ... → client.ts` 的循环依赖。注册发生在 `loadSkillsDir.ts` 模块初始化时 (`loadSkillsDir.ts:1083-1086`)。

### 5.6 MovedToPlugin 迁移机制

部分原有硬编码命令正在迁移到插件系统。`createMovedToPluginCommand()` (`src/commands/createMovedToPluginCommand.ts:22-65`) 创建一个过渡性 `prompt` 类型命令:

- Ant 内部用户: 提示安装插件 `claude plugin install <name>@claude-code-marketplace`
- 外部用户 (marketplace 未公开前): 使用本地 fallback 提示词 (`getPromptWhileMarketplaceIsPrivate`)

示例: `/security-review` 使用此机制 (`src/commands/security-review.ts:198-243`)。

### 5.7 技能搜索与发现 (实验性)

**feature gate**: `EXPERIMENTAL_SKILL_SEARCH`

远程规范技能通过 `_canonical_<slug>` 命名约定识别:
- `DiscoverSkills` 工具发现远程技能
- `SkillTool.validateInput()` 拦截 `_canonical_` 前缀 (`SkillTool.ts:377-396`)
- `SkillTool.call()` 中 `executeRemoteSkill()` 从 AKI/GCS 加载 SKILL.md (`SkillTool.ts:969-1108`)
- 本地缓存避免重复下载
- 远程技能为声明式 Markdown，不执行 shell 命令

### 5.8 SkillTool 安全模型

**权限检查** (`SkillTool.ts:432-578`):

```
SkillTool.checkPermissions()
  │
  ├─► deny 规则匹配 → 阻止
  ├─► 远程规范技能 → 自动允许 (ant-only)
  ├─► allow 规则匹配 → 放行
  ├─► skillHasOnlySafeProperties() → 自动允许
  │    (白名单: type, name, description, isEnabled, progressMessage,
  │     contentLength, argNames, model, effort, source, pluginInfo, etc.)
  └─► 默认: ask (请求用户许可)
```

---

## 6. 关键源文件索引

| 文件 | 行数 | 核心职责 |
|------|------|---------|
| `src/types/command.ts` | 217 | Command 类型系统定义 (PromptCommand, LocalCommand, LocalJSXCommand, CommandBase) |
| `src/commands.ts` | 755 | 命令注册中心、发现管线、过滤、查找、Bridge 安全、缓存管理 |
| `src/skills/loadSkillsDir.ts` | 1087 | 磁盘技能发现 (skills/ + commands/)、条件技能、动态发现、去重 |
| `src/skills/bundledSkills.ts` | 221 | 内置技能注册表 (registerBundledSkill / getBundledSkills) |
| `src/skills/bundled/index.ts` | 80 | 内置技能初始化入口 (initBundledSkills) |
| `src/skills/mcpSkillBuilders.ts` | 45 | MCP 技能构建器注册 (打破循环依赖) |
| `src/utils/plugins/loadPluginCommands.ts` | 947 | 插件命令/技能加载 (Markdown 解析、命名、变量替换) |
| `src/commands/createMovedToPluginCommand.ts` | 65 | 命令向插件迁移的过渡机制 |
| `src/tools/SkillTool/SkillTool.ts` | 1109 | 模型侧技能调用工具 (SkillTool)、权限检查、fork/inline/remote 执行 |
| `src/utils/processUserInput/processSlashCommand.tsx` | ~500 | 用户侧斜杠命令分发、fork 执行 |
| `src/utils/processUserInput/processUserInput.ts` | ~500 | 用户输入统一入口、bridge 安全检查、ultraplan 关键词路由 |