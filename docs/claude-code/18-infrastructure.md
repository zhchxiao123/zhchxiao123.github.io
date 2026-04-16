---
title: "Step 18: 基础设施系统"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/18-infrastructure/
---


> 分析日期: 2026-04-16
> 核心目录: src/vim/(5文件), src/keybindings/(14文件), src/migrations/(11文件), src/utils/settings/(15文件), src/utils/cron*(5文件), src/utils/claudemd.ts(1,479行), src/context.ts(189行), src/utils/context.ts(221行), src/history.ts(464行), src/cost-tracker.ts(323行)

---

## 1. Vim 模式

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `vim/types.ts` | 199 | 类型定义: VimState, CommandState, PersistentState, RecordedChange |
| `vim/motions.ts` | 82 | 光标移动解析: h/j/k/l/w/b/e/$/0/G/gg 等 |
| `vim/operators.ts` | 556 | 操作符执行: d/c/y/x/r/p/J/>>/o/O 等 |
| `vim/transitions.ts` | 490 | 状态机转换: NORMAL 模式下所有状态转移 |
| `vim/textObjects.ts` | 186 | 文本对象: iw/aw/i"/a"/i)/a) 等 |

### 状态机架构

```
VimState = CommandState | PersistentState
    |
    CommandState (可辨识联合):
    |
    +-- { type: 'idle' }              等待输入
    +-- { type: 'count', count }     数字前缀累积
    +-- { type: 'operator', op, count }     等待操作对象 (d/c/y 后)
    +-- { type: 'operatorCount', op, opCount, count }  操作符+数字
    +-- { type: 'operatorFind', op, count, findType }   f/F/t/T 等待字符
    +-- { type: 'operatorTextObj', op, count, scope }   i/a 等待对象类型
    +-- { type: 'operatorG', op, count }     g 前缀
    +-- { type: 'find', findType, count }    f/F/t/T 等待字符
    +-- { type: 'g', count }           g 前缀 (gg/gE/g$ 等)
    +-- { type: 'replace' }           r 等待替换字符
    +-- { type: 'indent', dir, count } >/< 等待缩进对象
```

### 转换函数

```
transition(state, input, ctx) -> TransitionResult
    |
    +-- fromIdle: 单键操作 (dd/cc/yy/x/r/p/J/~/</>/o/O)
    +-- fromCount: 数字累积 or 操作符/运动键
    +-- fromOperator: 运动/查找/文本对象/g前缀/数字
    +-- fromOperatorCount: 运动/查找/文本对象/g前缀
    +-- fromOperatorFind: 等待查找字符
    +-- fromOperatorTextObj: 等待文本对象类型 (w/"/)/b/]/} 等)
    +-- fromFind: 等待查找字符 (f/F/t/T)
    +-- fromG: g 后续键 (gg/gE/g$/g0)
    +-- fromOperatorG: 操作符+g 后续键
    +-- fromReplace: r 后续字符
    +-- fromIndent: 等待缩进对象 (运动行)
```

### 支持的操作符

| 操作符 | 键 | 行为 |
|--------|-----|------|
| delete | d | 删除选区/行 |
| change | c | 删除并进入插入模式 |
| yank | y | 复制选区/行 |
| delete char | x | 删除光标处字符 |
| replace | r | 替换单个字符 |
| toggle case | ~ | 切换大小写 |
| join | J | 合并行 |
| paste | p/P | 粘贴 (后/前) |
| indent | >/<< | 缩进/反缩进 |
| open line | o/O | 下方/上方开新行 |

### 文本对象

| 对象 | inner | around |
|------|-------|--------|
| word | iw | aw |
| WORD | iW | aW |
| quote | i" / i' | a" / a' |
| bracket | i) / i] / i} | a) / a] / a} |

### Dot-Repeat 机制

`RecordedChange` 类型记录最近一次变更用于 `.` 重复:
- 变更类型 (delete/change/paste/indent 等)
- 变更参数 (count, findType, motion 等)
- 通过 `persistentState.lastChange` 持久化

---

## 2. 键绑定系统

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `keybindings/schema.ts` | 236 | Zod schema 定义 + 上下文/动作枚举 |
| `keybindings/parser.ts` | 203 | 按键字符串解析: "ctrl+shift+k" -> ParsedKeystroke |
| `keybindings/match.ts` | 120 | Ink Key 对象与 ParsedKeystroke 匹配 |
| `keybindings/resolver.ts` | 244 | 按键解析: 输入 -> 动作 (含 chord 支持) |
| `keybindings/validate.ts` | 498 | 用户配置验证: 重复/保留/无效检测 |
| `keybindings/defaultBindings.ts` | 340 | 默认键绑定定义 |
| `keybindings/loadUserBindings.ts` | 472 | 用户键绑定加载 + 文件监视 |
| `keybindings/KeybindingContext.tsx` | 242 | React Context: 注册/解析/上下文管理 |
| `keybindings/KeybindingProviderSetup.tsx` | 307 | Provider 初始化 + 上下文注册 |
| `keybindings/useKeybinding.ts` | 196 | React Hook: useKeybinding / useKeybindings |
| `keybindings/useShortcutDisplay.ts` | 59 | 快捷键显示 Hook |
| `keybindings/reservedShortcuts.ts` | 127 | 不可重绑定快捷键列表 |
| `keybindings/shortcutFormat.ts` | 63 | 快捷键格式化工具 |
| `keybindings/template.ts` | 52 | 键绑定模板生成 |

### 键绑定解析流

```
用户按键 (Ink Key 对象)
    |
    v
buildKeystroke(input, key) -- 从 Ink 事件构建 ParsedKeystroke
    |
    v
resolveKeyWithChordState() -- 支持多键组合 (chord)
    |
    +-- 检查 pending chord 状态
    +-- 与活跃上下文的 bindings 匹配
    +-- 匹配 chord 前缀? -> 保存 pending, 返回 pending
    +-- 完全匹配? -> 返回 { action, display }
    +-- 无匹配? -> 返回 { type: 'none' }
    |
    v
handler() -- 执行绑定动作
```

### 上下文系统

| 上下文名 | 用途 |
|---------|------|
| `global` | 全局快捷键 (Ctrl+C, Escape 等) |
| `input` | 输入框激活时 |
| `vimNormal` | Vim 正常模式 |
| `dialog` | 对话框激活时 |
| `search` | 搜索模式 |
| `todo` | Todo 视图 |

上下文优先级: 后注册的上下文优先。组件挂载时通过 `useRegisterKeybindingContext` 注册。

### 保留快捷键

**不可重绑定 (NON_REBINDABLE)**: Ctrl+C, Escape 等

**终端保留 (TERMINAL_RESERVED)**: Ctrl+S, Ctrl+Q, Ctrl+Z 等

**macOS 保留 (MACOS_RESERVED)**: Cmd+Q, Cmd+W, Cmd+M 等

### 用户自定义

- 配置文件: `~/.claude/keybindings.json`
- Schema: Zod 验证的 `KeybindingBlock[]`
- 文件监视: chokidar 监听变更, 自动重载
- Feature 开关: `tengu_keybinding_customization` GrowthBook 门控

---

## 3. 迁移系统

### 迁移清单

| 文件 | 行数 | 迁移内容 | 触发条件 |
|------|------|---------|---------|
| `migrateAutoUpdatesToSettings.ts` | 61 | autoUpdaterStatus -> installMethod + autoUpdates | 版本升级 |
| `migrateBypassPermissionsAcceptedToSettings.ts` | 40 | bypassPermissionsAccepted -> settings | 权限模式迁移 |
| `migrateEnableAllProjectMcpServersToSettings.ts` | 118 | enableAllProjectMcpServers -> settings | MCP 配置迁移 |
| `migrateFennecToOpus.ts` | 45 | fennec 模型 -> opus | 模型更名 |
| `migrateLegacyOpusToCurrent.ts` | 57 | 旧 opus ID -> 新 opus ID | 模型 ID 更名 |
| `migrateOpusToOpus1m.ts` | 43 | opus -> opus-1m | 1M 上下文迁移 |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | 22 | replBridgeEnabled -> remoteControlAtStartup | Bridge 重命名 |
| `migrateSonnet1mToSonnet45.ts` | 48 | sonnet-1m -> sonnet-4.5 | 模型更名 |
| `migrateSonnet45ToSonnet46.ts` | 67 | sonnet-4.5 -> sonnet-4.6 | 模型更名 |
| `resetAutoModeOptInForDefaultOffer.ts` | 51 | 重置 auto mode opt-in | 默认行为变更 |
| `resetProToOpusDefault.ts` | 51 | Pro 默认模型 -> Opus | 模型层级调整 |

### 迁移执行顺序

```
main.tsx startup
    |
    v
runMigrations() -- 按文件名排序执行
    |
    v
每个迁移:
    1. 检查前置条件 (配置中是否存在旧值)
    2. 应用转换 (读取 -> 修改 -> 写入)
    3. 标记完成 (避免重复执行)
```

**模式**: 每个迁移是独立的、幂等的函数。通过 `saveGlobalConfig(updater)` 原子写入。

---

## 4. 设置系统

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `utils/settings/types.ts` | 1,148 | SettingsJson 类型定义 (~100 字段) |
| `utils/settings/settings.ts` | 1,015 | 核心设置读写: getInitialSettings, getSettingsForSource |
| `utils/settings/changeDetector.ts` | 488 | 设置变更检测 |
| `utils/settings/validation.ts` | 265 | 设置验证逻辑 |
| `utils/settings/permissionValidation.ts` | 262 | 权限相关设置验证 |
| `utils/settings/applySettingsChange.ts` | 92 | 设置变更应用 |
| `utils/settings/constants.ts` | 202 | 设置常量 |
| `utils/settings/validationTips.ts` | 164 | 验证提示文本 |
| `utils/settings/managedPath.ts` | 34 | 托管路径管理 |
| `utils/settings/internalWrites.ts` | 37 | 内部写入辅助 |
| `utils/settings/pluginOnlyPolicy.ts` | 60 | 插件策略 |
| `utils/settings/toolValidationConfig.ts` | 103 | 工具验证配置 |
| `utils/settings/validateEditTool.ts` | 45 | 编辑工具验证 |
| `utils/settings/schemaOutput.ts` | 8 | Schema 输出 |
| `utils/settings/allErrors.ts` | 32 | 错误类型定义 |

### 设置层级 (优先级从低到高)

```
defaults (createDefaultGlobalConfig)
    |
    v
project settings (.claude/settings.json)
    |
    v
user settings (~/.claude/settings.json)
    |
    v
managed settings (MDM/企业策略)
    |
    v
CLI flags (--flag, env vars)
```

### 关键设置字段分类

**模型/行为**: model, mainLoopModel, fastMode, effortLevel, thinkingEnabled

**权限**: permissions, autoApprove, bypassPermissions

**UI**: outputStyle, editorMode, diffTool, verbose

**MCP**: mcpServers, enableAllProjectMcpServers

**代理**: agent, advisors

**集成**: notifications, remoteControlAtStartup

### 设置来源枚举

```
SettingSource = 'defaults' | 'project' | 'user' | 'managed' | 'cli'
```

`getSettingsForSource(source)` 返回特定来源的设置层。
`getSettingsWithSources()` 返回合并后设置 + 各字段来源信息。

### 全局配置类型 (GlobalConfig, ~400 字段)

核心字段包括:
- `userID`: 匿名用户 ID
- `hasCompletedOnboarding`: 引导完成标志
- `installMethod`: 安装方式 (local/native/global/unknown)
- `autoUpdates`: 自动更新
- `apiKeyHelperStatus`: API Key 助手状态
- `projects`: 项目配置 Map
- `oauthToken`: OAuth 令牌
- `customApiKeyResponses`: 自定义 API Key 审批

---

## 5. 成本追踪

### 架构

```
API 响应 (usage: { input_tokens, output_tokens, cache_read/write })
    |
    v
addToTotalSessionCost(cost, usage, model)
    |-- 计算实际费用 (考虑缓存折扣)
    |-- 累加到 totalSessionCost
    |-- 累加到 modelUsage[] (按模型分组)
    |-- 保存到项目配置 (saveCurrentSessionCosts)
    |
    v
useCostSummary (React Hook)
    |-- 格式化总成本 (formatTotalCost)
    |-- 格式化每模型用量 (formatModelUsage)
    |-- 触发 UI 更新
```

### 成本计算

- **输入令牌**: 按 model 价格计算 (考虑缓存读取折扣)
- **输出令牌**: 按 model 价格计算
- **缓存读取**: 低于标准输入价格
- **会话恢复**: `restoreCostStateForSession()` 从项目配置恢复

### 成本存储

- **运行时**: `totalSessionCost` (模块级变量)
- **持久化**: 项目配置中的 `costs` 字段 (通过 `saveCurrentSessionCosts`)
- **恢复**: 会话恢复时通过 `getStoredSessionCosts()` 读取

---

## 6. 上下文收集

### 系统上下文 (`getSystemContext`, memoized)

```
getSystemContext()
    |
    +-- gitStatus (异步)
    |     |-- 当前分支
    |     |-- 主分支
    |     |-- Git 用户名
    |     |-- git status --short (截断至 2,000 字符)
    |     |-- 最近 5 条提交
    |
    +-- cacheBreaker (条件性)
          |-- feature('BREAK_CACHE_COMMAND') 时注入
          |-- 用于缓存失效 (仅 Ant 内部)
```

### 用户上下文 (`getUserContext`, memoized)

```
getUserContext()
    |
    +-- claudeMd
    |     |-- CLAUDE.md 内容组装
    |     |-- 禁用条件: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1
    |     |-- --bare 模式跳过自动发现
    |
    +-- currentDate
          |-- "Today's date is <ISO date>."
```

### 上下文窗口计算 (`utils/context.ts`)

| 函数 | 用途 |
|------|------|
| `getContextWindowForModel(model)` | 获取模型上下文窗口大小 (默认 200K, 1M beta 可用) |
| `calculateContextPercentages(usage)` | 计算上下文使用百分比 |
| `getModelMaxOutputTokens(model)` | 获取模型最大输出令牌 (默认 32K, Opus 64K) |
| `getMaxThinkingTokensForModel(model)` | 获取最大思考令牌 |
| `modelSupports1M(model)` | 检查模型是否支持 1M 上下文 |

---

## 7. 历史管理

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `history.ts` | 464 | 命令历史记录: 写入/读取/删除 |

### 架构

```
用户输入
    |
    v
addToHistory(command)
    |-- 加入 pendingEntries 队列 (内存)
    |
    v
flushPromptHistory()
    |-- 获取文件锁 (lockfile)
    |-- 读取现有 JSONL 文件
    |-- 追加新条目
    |-- 写入文件
    |-- 释放锁
```

### 历史条目类型

```typescript
type HistoryEntry = {
  command: string          // 命令文本
  timestamp?: number      // 时间戳
  pastedContents?: Record<number, PastedContent>  // 粘贴内容
}
```

### 粘贴内容处理

- 大段粘贴内容存储在独立的粘贴存储中
- 历史条目中仅保存引用 `[Pasted text #N]`
- `expandPastedTextRefs()` 展开引用为完整内容

### 存储位置

- 历史文件: `~/.claude/history.jsonl`
- 粘贴存储: `~/.claude/paste-store/`

---

## 8. Cron 系统

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `utils/cron.ts` | 308 | Cron 表达式解析 + 下次运行计算 |
| `utils/cronTasks.ts` | 458 | Cron 任务 CRUD + 抖动计算 |
| `utils/cronScheduler.ts` | 565 | Cron 调度器: 加载/检查/执行/通知 |
| `utils/cronTasksLock.ts` | 195 | 调度器互斥锁 (跨进程) |
| `utils/cronJitterConfig.ts` | 75 | 抖动配置 (GrowthBook 门控) |

### Cron 表达式解析

```
5 字段: 分 时 日 月 周
    |
    v
parseCronExpression(expr) -> CronFields
    |-- expandField(): 支持 * , - / 语法
    |-- 返回每个字段的匹配值数组
    |
    v
computeNextCronRun(fields, from) -> Date | null
    |-- 从 from 开始，找到下一个匹配时间
    |-- 逐级匹配: 秒 -> 分 -> 时 -> 日 -> 月 -> 年
```

### Cron 任务类型

```typescript
type CronTask = {
  id: string             // 8 字符 UUID 切片
  cron: string           // Cron 表达式
  prompt: string         // 执行的提示
  recurring: boolean     // 是否重复
  durable: boolean       // 是否持久化
  createdAt: number      // 创建时间
  lastFiredAt?: number   // 上次触发时间
  agentId?: string       // 关联 Agent
}
```

### 调度器生命周期

```
createCronScheduler(options)
    |
    +-- load(initial) -- 初始加载 (读文件 + 会话任务合并)
    +-- check() -- 定时检查 (每 checkIntervalMs)
    |     |-- 计算每个任务的下次触发时间 (含抖动)
    |     |-- 触发到期任务
    |     |-- 通知错过的任务
    |
    +-- enable() -- 启用调度器
    +-- start() -- 开始轮询
    +-- stop() -- 停止轮询
    +-- getNextFireTime() -- 下次触发时间
```

### 抖动机制

- **循环任务**: 加随机延迟 (`jitteredNextCronRunMs`) — 基于任务 ID 的确定性抖动
- **一次性任务**: 减随机提前量 (`oneShotJitteredNextCronRunMs`)
- **配置来源**: GrowthBook `tengu_kairos_cron_config` 特性开关
- **目的**: 分散多会话同时触发的负载

### 互斥锁

`tryAcquireSchedulerLock()` 确保同一项目仅一个会话运行调度器:
- 锁文件: `.claude/scheduler.lock.json`
- 锁内容: `{ sessionId, pid, acquiredAt }`
- 锁检查: 进程存活验证 (`isProcessRunning`)
- 逃生舱: 僵锁 10 分钟后可被新会话抢占

---

## 9. CLAUDE.md 系统

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `utils/claudemd.ts` | 1,479 | CLAUDE.md 文件发现、解析、组装 |

### 文件发现顺序 (优先级从低到高)

```
1. 管理内存 (/etc/claude-code/CLAUDE.md)  -- 全局管理
2. 用户内存 (~/.claude/CLAUDE.md)         -- 用户私有
3. 项目内存 (CLAUDE.md, .claude/CLAUDE.md) -- 项目共享
4. 项目规则 (.claude/rules/*.md)          -- 条件规则
5. 本地内存 (CLAUDE.local.md)            -- 项目私有
```

**注意**: CWD 遍历方向为从 CWD 向上到根目录。越靠近 CWD 的文件优先级越高 (后加载覆盖先加载)。

### @include 指令

```
@include 语法: @path, @./relative/path, @~/home/path, @/absolute/path
    |
    v
extractIncludePathsFromTokens(tokens, basePath)
    |-- 从 Markdown token 中提取路径
    |-- 限制: 仅叶文本节点 (不在代码块内)
    |-- 扩展名白名单: TEXT_FILE_EXTENSIONS (100+ 种)
    |-- 循环引用防护: processedPaths Set
    |-- 最大字符数: MAX_MEMORY_CHARACTER_COUNT = 40,000
```

### 内容组装

```
getClaudeMds(memoryFiles, filter?)
    |
    v
MEMORY_INSTRUCTION_PROMPT + "\n\n" + memories.join("\n\n")
    |
    每个文件包装:
    "Contents of <path> (<type description>):\n\n<content>"
```

### 注入路径

```
getUserContext()
    |-- getMemoryFiles()  -- 发现所有内存文件
    |-- filterInjectedMemoryFiles()  -- 过滤 (tengu_moth_copse 门控)
    |-- getClaudeMds()  -- 组装为字符串
    |-- setCachedClaudeMdContent()  -- 缓存供 yoloClassifier 使用
    |
    v
userContext.claudeMd -> 注入到系统提示
```

### 条件绕过

| 条件 | 效果 |
|------|------|
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | 完全禁用 |
| `--bare` 模式 | 跳过自动发现, 保留显式 `--add-dir` |
| `tengu_paper_halyard` GrowthBook | 跳过 Project/Local 层级 |
| `isClaudeMdExcluded()` | 按用户排除规则跳过 |

---

## 10. 关键观察

1. **Vim 实现是完整的状态机**: 不是简单的键映射，而是完整的 NORMAL 模式状态机，支持 count 前缀、operator 等待、find 等待、chord 等。但仅实现 NORMAL 模式，没有 INSERT/VISUAL 模式。

2. **键绑定系统高度模块化**: 解析 -> 匹配 -> 解析 -> 验证 -> 上下文管理 完全分离。支持用户自定义、chord 组合键、上下文优先级。

3. **迁移系统是原子性的**: 每个迁移独立执行，通过 `saveGlobalConfig(updater)` 原子写入。幂等设计避免重复执行。

4. **设置层级严格**: defaults -> project -> user -> managed -> CLI 的优先级链，managed 层级用于企业 MDM 控制。

5. **Cron 抖动是确定性的**: 基于任务 ID (8 字符 UUID 切片) 的哈希，同一任务在不同会话中产生相同抖动。避免了分布式调度器的惊群效应。

6. **CLAUDE.md 是项目级配置即代码**: 通过版本控制的 CLAUDE.md 文件，团队可以共享 AI 行为配置。@include 支持模块化，但需注意循环引用和大小限制。