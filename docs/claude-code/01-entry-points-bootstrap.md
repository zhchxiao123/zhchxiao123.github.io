---
title: "Step 1: 入口点与启动流程"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/01-entry-points-bootstrap/
---


> 分析日期: 2026-04-16
> 核心文件: main.tsx (4,683行), cli.tsx, init.ts, setup.ts (477行), migrations/

---

## 1. 调用图: main() -> run() -> [子命令路径]

```
cli.tsx::main()                    [启动入口 - 零导入快速路径]
  |
  +-- 快速路径 (提前返回，零/低模块加载):
  |     |--version/-v/-V           -> console.log(MACRO.VERSION) and return
  |     |--dump-system-prompt      -> enableConfigs() -> getSystemPrompt() -> return
  |     |--claude-in-chrome-mcp    -> runClaudeInChromeMcpServer() -> return
  |     |--chrome-native-host      -> runChromeNativeHost() -> return
  |     |--computer-use-mcp        -> runComputerUseMcpServer() -> return  [feature: CHICAGO_MCP]
  |     |--daemon-worker <kind>    -> runDaemonWorker(kind) -> return     [feature: DAEMON]
  |     |remote-control/rc/remote/sync/bridge -> bridgeMain(args)         [feature: BRIDGE_MODE]
  |     |daemon [subcommand]       -> daemonMain(args)                    [feature: DAEMON]
  |     |ps|logs|attach|kill      -> bg.{handler}()                     [feature: BG_SESSIONS]
  |     |--bg/--background         -> bg.handleBgFlag(args)              [feature: BG_SESSIONS]
  |     |new|list|reply            -> templatesMain(args)                [feature: TEMPLATES]
  |     |environment-runner        -> environmentRunnerMain(args)        [feature: BYOC_ENVIRONMENT_RUNNER]
  |     |self-hosted-runner        -> selfHostedRunnerMain(args)         [feature: SELF_HOSTED_RUNNER]
  |     |--worktree --tmux         -> execIntoTmuxWorktree(args)         [条件快速路径]
  |
  +-- --bare 标志: 尽早设置 CLAUDE_CODE_SIMPLE=1
  |
  +-- 回退到完整 CLI:
        startCapturingEarlyInput()
        import('../main.js') -> main()

main.tsx::main()                    [完整 CLI 入口 - ~135ms 模块导入]
  |
  +-- 模块求值时的副作用 (main() 运行前):
  |     profileCheckpoint('main_tsx_entry')
  |     startMdmRawRead()               [并行触发 MDM 子进程]
  |     startKeychainPrefetch()          [并行触发 keychain 读取]
  |
  +-- 安全: set NoDefaultCurrentDirectoryInExePath=1
  +-- initializeWarningHandler()
  +-- cc:// / cc+unix:// URL 重写    [feature: DIRECT_CONNECT]
  +-- --handle-uri 深链接处理         [feature: LODESTONE]
  +-- 'assistant' 子命令重写           [feature: KAIROS]
  +-- 'ssh' 子命令参数重写            [feature: SSH_REMOTE]
  +-- 确定 isNonInteractive (来自 -p/--print, --init-only, --sdk-url, !isTTY)
  +-- setIsInteractive(isInteractive)
  +-- initializeEntrypoint(isNonInteractive)
  +-- 确定 clientType (github-action, sdk-typescript, sdk-python 等)
  +-- setClientType(clientType)
  +-- setQuestionPreviewFormat()
  +-- eagerLoadSettings()
  +-- run()

main.tsx::run()
  |
  +-- 创建 Commander 程序（排序帮助）
  +-- 注册 preAction hook:
  |     await ensureMdmSettingsLoaded() + ensureKeychainPrefetchCompleted()
  |     await init()                         [entrypoints/init.ts]
  |     process.title = 'claude'
  |     initSinks()
  |     setInlinePlugins() / clearPluginCache()
  |     runMigrations()
  |     void loadRemoteManagedSettings()
  |     void loadPolicyLimits()
  |     void uploadUserSettingsInBackground()  [feature: UPLOAD_USER_SETTINGS]
  |
  +-- 注册顶级选项 (150+ 标志)
  +-- 注册默认动作处理器（主要交互/headless 逻辑）
  +-- program.parseAsync(process.argv)
```

---

## 2. 启动序列表

| 步骤 | 函数 | 文件 | 用途 | 特性开关/条件 |
|------|------|------|------|--------------|
| 0 | `COREPACK_ENABLE_AUTO_PIN = '0'` | cli.tsx (顶层) | 防止 corepack 自动固定 | 始终 |
| 0 | `NODE_OPTIONS --max-old-space-size=8192` | cli.tsx (顶层) | 设置 CCR 容器堆限制 | `CLAUDE_CODE_REMOTE=true` |
| 0 | 消融基线环境变量 | cli.tsx (顶层) | 设置 L0 消融基线环境 | `feature('ABLATION_BASELINE')` |
| 1 | `profileCheckpoint('cli_entry')` | cli.tsx:48 | 标记 CLI 入口时间戳 | 始终 |
| 2 | `--version` 快速路径 | cli.tsx:37-42 | 打印版本并退出 | `--version` |
| 3 | `enableConfigs()` | cli.tsx (各种快速路径) | 为 bridge/daemon/bg 等启用配置 | 仅子命令快速路径 |
| 4 | `bridgeMain()` | cli.tsx:160 | 启动 bridge 远程控制 | `feature('BRIDGE_MODE')` |
| 5 | `daemonMain()` | cli.tsx:178 | 启动守护进程 | `feature('DAEMON')` |
| 6 | `bg.{handler}()` | cli.tsx:192-208 | 会话管理 | `feature('BG_SESSIONS')` |
| 7 | `templatesMain()` | cli.tsx:216 | 模板命令 | `feature('TEMPLATES')` |
| 8 | `environmentRunnerMain()` | cli.tsx:229 | BYOC 无头运行器 | `feature('BYOC_ENVIRONMENT_RUNNER')` |
| 9 | `selfHostedRunnerMain()` | cli.tsx:241 | 自托管运行器 | `feature('SELF_HOSTED_RUNNER')` |
| 10 | `execIntoTmuxWorktree()` | cli.tsx:261 | Tmux worktree 快速路径 | `--tmux + --worktree` |
| 11 | `--bare -> CLAUDE_CODE_SIMPLE=1` | cli.tsx:283 | 尽早设置极简模式 | `--bare` |
| 12 | `startCapturingEarlyInput()` | cli.tsx:291 | 在完整初始化前捕获 stdin | 始终 |
| 13 | `profileCheckpoint('main_tsx_entry')` | main.tsx:12 | 模块求值时间戳 | 始终 |
| 14 | `startMdmRawRead()` | main.tsx:16 | 并行触发 MDM 子进程 | 始终 |
| 15 | `startKeychainPrefetch()` | main.tsx:20 | 并行触发 keychain 读取 | 始终 |
| 16 | `initializeWarningHandler()` | main.tsx:594 | 捕获未处理警告 | 始终 |
| 17 | cc:// URL 重写 | main.tsx:612-641 | 重写 cc:// 方案 argv | `feature('DIRECT_CONNECT')` |
| 18 | `--handle-uri` 处理 | main.tsx:648-676 | 深链接 URI 处理 | `feature('LODESTONE')` |
| 19 | `assistant` 子命令重写 | main.tsx:685-700 | 暂存 assistant session ID | `feature('KAIROS')` |
| 20 | `ssh` 子命令重写 | main.tsx:706-794 | 暂存 SSH 主机/目录 | `feature('SSH_REMOTE')` |
| 21 | 确定 `isNonInteractive` | main.tsx:799-803 | 从 -p, --init-only, --sdk-url, !isTTY | 条件 |
| 22 | `initializeEntrypoint()` | main.tsx:815 | 设置 `CLAUDE_CODE_ENTRYPOINT` 环境变量 | 始终 |
| 23 | `setClientType()` | main.tsx:834 | 识别客户端来源 | 始终 |
| 24 | `eagerLoadSettings()` | main.tsx:852 | 早期解析 --settings, --setting-sources | 始终 |
| 25 | `run()` | main.tsx:854 | 启动 Commander 程序 | 始终 |
| 26 | `preAction` hook | main.tsx:907-967 | 任何命令前初始化 | Commander 生命周期 |
| 27 | `ensureMdmSettingsLoaded()` | main.tsx:914 | 等待子进程结果 | 始终 |
| 28 | `init()` | entrypoints/init.ts:57 | 核心初始化（记忆化） | 始终 |
| 29 | `enableConfigs()` | init.ts:65 | 验证和启用配置系统 | 始终 |
| 30 | `applySafeConfigEnvironmentVariables()` | init.ts:74 | 在信任前应用安全环境变量 | 始终 |
| 31 | `applyExtraCACertsFromConfig()` | init.ts:79 | 在 TLS 前应用 CA 证书 | 始终 |
| 32 | `setupGracefulShutdown()` | init.ts:87 | 注册退出处理器 | 始终 |
| 33 | `initialize1PEventLogging()` | init.ts:94-106 | 启动 1P 分析（延迟） | 始终 |
| 34 | `populateOAuthAccountInfoIfNeeded()` | init.ts:110 | 填充 OAuth 信息缓存 | 始终 |
| 35 | `initJetBrainsDetection()` | init.ts:114 | 检测 JetBrains IDE | 始终 |
| 36 | `detectCurrentRepository()` | init.ts:118 | 检测 GitHub 仓库 | 始终 |
| 37 | `initializeRemoteManagedSettingsLoadingPromise()` | init.ts:124 | 企业远程设置 | 有条件 |
| 38 | `initializePolicyLimitsLoadingPromise()` | init.ts:127 | 策略限制初始化 | 有条件 |
| 39 | `configureGlobalMTLS()` | init.ts:137 | mTLS 配置 | 始终 |
| 40 | `configureGlobalAgents()` | init.ts:146 | HTTP 代理/agent 配置 | 始终 |
| 41 | `preconnectAnthropicApi()` | init.ts:159 | TCP+TLS 预热 | 非代理/mTLS |
| 42 | `initUpstreamProxy()` | init.ts:168-183 | CCR 上游代理 | `CLAUDE_CODE_REMOTE=true` |
| 43 | `setShellIfWindows()` | init.ts:186 | Windows 上 Git-bash | 仅 Windows |
| 44 | `registerCleanup(shutdownLspServerManager)` | init.ts:189 | 退出时 LSP 清理 | 始终 |
| 45 | `ensureScratchpadDir()` | init.ts:205 | 创建 scratchpad 目录 | `isScratchpadEnabled()` |
| 46 | `initSinks()` | main.tsx:934 | 附加分析接收器 | 始终 |
| 47 | `runMigrations()` | main.tsx:950 | 运行所有配置迁移 | 始终 |
| 48 | `loadRemoteManagedSettings()` | main.tsx:957 | 企业远程设置 | 即发即弃 |
| 49 | `loadPolicyLimits()` | main.tsx:958 | 策略限制 | 即发即弃 |
| 50 | `uploadUserSettingsInBackground()` | main.tsx:964 | 设置同步 | `feature('UPLOAD_USER_SETTINGS')` |
| 51 | `setup()` | setup.ts:56 | 完整设置（cwd, worktree, hooks 等） | 始终 |
| 52 | `initBuiltinPlugins()` + `initBundledSkills()` | main.tsx:1924-1926 | 注册插件/技能 | 非 `local-agent` |
| 53 | `showSetupScreens()` | main.tsx:2241 | 信任对话框、认证、引导 | 仅交互 |
| 54 | `initializeTelemetryAfterTrust()` | init.ts:247 | 启动 3P 遥测 | 信任后 |
| 55 | `runHeadless()` 或 `launchRepl()` | main.tsx:2829/3798 | 启动无头或交互会话 | 模式依赖 |

---

## 3. 入口点清单: CLI 标志 -> 处理器映射

### 快速路径入口点 (cli.tsx - 零/低导入)

| CLI 调用 | 处理器 | 特性开关 |
|----------|--------|---------|
| `claude --version` / `-v` | `console.log(MACRO.VERSION)` | 无 |
| `claude --dump-system-prompt` | `enableConfigs() -> getSystemPrompt()` | `feature('DUMP_SYSTEM_PROMPT')` |
| `claude --claude-in-chrome-mcp` | `runClaudeInChromeMcpServer()` | 无 |
| `claude --chrome-native-host` | `runChromeNativeHost()` | 无 |
| `claude --computer-use-mcp` | `runComputerUseMcpServer()` | `feature('CHICAGO_MCP')` |
| `claude --daemon-worker <kind>` | `runDaemonWorker(kind)` | `feature('DAEMON')` |
| `claude remote-control/rc/remote/sync/bridge` | `bridgeMain(args)` | `feature('BRIDGE_MODE')` |
| `claude daemon [subcommand]` | `daemonMain(args)` | `feature('DAEMON')` |
| `claude ps/logs/attach/kill` | `bg.{handler}()` | `feature('BG_SESSIONS')` |
| `claude --bg/--background` | `bg.handleBgFlag(args)` | `feature('BG_SESSIONS')` |
| `claude new/list/reply` | `templatesMain(args)` | `feature('TEMPLATES')` |
| `claude environment-runner` | `environmentRunnerMain(args)` | `feature('BYOC_ENVIRONMENT_RUNNER')` |
| `claude self-hosted-runner` | `selfHostedRunnerMain(args)` | `feature('SELF_HOSTED_RUNNER')` |
| `claude --worktree --tmux` | `execIntoTmuxWorktree(args)` | `isWorktreeModeEnabled()` |

### 完整 CLI 入口点 (main.tsx - Commander 子命令)

| CLI 调用 | 处理器 | 特性开关 |
|----------|--------|---------|
| `claude [prompt]` (默认) | 交互 REPL: `launchRepl()` | 无 |
| `claude -p/--print` | 无头: `runHeadless()` | 无 |
| `claude --init-only` | 处理 hooks -> 退出 | 无 |
| `claude -c/--continue` | `loadConversationForResume()` -> `launchRepl()` | 无 |
| `claude -r/--resume` | 恢复选择器 -> `launchRepl()` | 无 |
| `claude mcp serve` | `mcpServeHandler()` -> `startMCPServer()` | 无 |
| `claude server` | `startServer()` | `feature('DIRECT_CONNECT')` |
| `claude open <cc-url>` | `createDirectConnectSession()` | `feature('DIRECT_CONNECT')` |
| `claude ssh <host> [dir]` | `createSSHSession()` | `feature('SSH_REMOTE')` |
| `claude auth` | 认证子命令 | 无 |
| `claude plugin/plugins` | 插件子命令 | 无 |
| `claude doctor` | 健康检查 | 无 |
| `claude update/upgrade` | 自动更新 | 无 |
| `claude assistant [sessionId]` | 连接 REPL 到 bridge 会话 | `feature('KAIROS')` |
| `claude auto-mode` | 检查自动模式配置 | `feature('TRANSCRIPT_CLASSIFIER')` |

---

## 4. 初始化顺序图

```
[进程启动]
    |
    v
+-----------------------------------------------------------+
|  cli.tsx: 顶层副作用                                       |
|  - COREPACK_ENABLE_AUTO_PIN = '0'                          |
|  - CLAUDE_CODE_REMOTE -> max-old-space-size=8192           |
|  - ABLATION_BASELINE -> 设置 7 个环境变量                   |
+-----------------------------------------------------------+
    |
    v
+-----------------------------------------------------------+
|  cli.tsx::main()  --  启动入口点                             |
|  所有导入都是 DYNAMIC 以最小化模块求值                          |
+-----------------------------------------------------------+
    |
    +--> 快速路径? (--version, --dump-system-prompt,
    |    --claude-in-chrome-mcp, --chrome-native-host,
    |    --computer-use-mcp, --daemon-worker,
    |    remote-control, daemon, ps/logs/attach/kill,
    |    templates, environment-runner, self-hosted-runner,
    |    --worktree --tmux)
    |      |
    |      +--> 是: 执行处理器并返回
    |
    v  (无快速路径匹配)
+-----------------------------------------------------------+
|  --bare -> CLAUDE_CODE_SIMPLE=1                            |
|  startCapturingEarlyInput()                                |
|  import('../main.js')                                      |
+-----------------------------------------------------------+
    |
    v
+-----------------------------------------------------------+
|  main.tsx: 模块求值副作用                                   |
|  (在 main() 调用前运行)                                     |
|  - profileCheckpoint('main_tsx_entry')                     |
|  - startMdmRawRead()       [异步, 并行]                     |
|  - startKeychainPrefetch() [异步, 并行]                     |
+-----------------------------------------------------------+
    |
    v
+-----------------------------------------------------------+
|  main.tsx::main()                                          |
|  - 安全: NoDefaultCurrentDirectoryInExePath               |
|  - initializeWarningHandler()                              |
|  - cc:// URL 重写           [DIRECT_CONNECT]               |
|  - --handle-uri 深链接      [LODESTONE]                    |
|  - assistant 重写           [KAIROS]                       |
|  - ssh 重写                 [SSH_REMOTE]                   |
|  - 确定 isNonInteractive                                  |
|  - initializeEntrypoint()                                   |
|  - 确定 clientType                                         |
|  - eagerLoadSettings()                                     |
|  - run()                                                   |
+-----------------------------------------------------------+
    |
    v
+-----------------------------------------------------------+
|  main.tsx::run()                                           |
|  - 创建 Commander 程序                                     |
|  - 注册 preAction hook                                     |
|  - 注册 150+ CLI 选项                                      |
|  - 注册默认动作处理器                                       |
|  - 注册子命令 (mcp, auth, plugin 等)                        |
|  - program.parseAsync(process.argv)                        |
+-----------------------------------------------------------+
    |
    v  (Commander preAction hook 触发)
+-----------------------------------------------------------+
|  preAction hook                                            |
|  1. ensureMdmSettingsLoaded() + ensureKeychainPrefetchCompleted()  |
|  2. init() [entrypoints/init.ts]                          |
|     +-- enableConfigs()                                    |
|     +-- applySafeConfigEnvironmentVariables()              |
|     +-- applyExtraCACertsFromConfig()                      |
|     +-- setupGracefulShutdown()                            |
|     +-- initialize1PEventLogging() (异步, 即发即弃)         |
|     +-- populateOAuthAccountInfoIfNeeded() (异步)          |
|     +-- initJetBrainsDetection() (异步)                    |
|     +-- detectCurrentRepository() (异步)                   |
|     +-- initializeRemoteManagedSettingsLoadingPromise()    |
|     +-- initializePolicyLimitsLoadingPromise()              |
|     +-- configureGlobalMTLS()                              |
|     +-- configureGlobalAgents()                            |
|     +-- preconnectAnthropicApi() (异步)                    |
|     +-- initUpstreamProxy() (异步, 仅 CCR)                 |
|     +-- setShellIfWindows()                                |
|     +-- registerCleanup(shutdownLspServerManager)          |
|     +-- ensureScratchpadDir() (如果启用)                   |
|  3. initSinks()                                            |
|  4. setInlinePlugins() + clearPluginCache()               |
|  5. runMigrations()                                        |
|  6. loadRemoteManagedSettings() (即发即弃)                 |
|  7. loadPolicyLimits() (即发即弃)                          |
|  8. uploadUserSettingsInBackground() (条件)                |
+-----------------------------------------------------------+
    |
    v  (Commander 分发到匹配的动作处理器)
+-----------------------------------------------------------+
|  默认动作处理器（主会话逻辑）                               |
|  +-- 解析所有 CLI 选项                                     |
|  +-- Assistant 模式设置 [KAIROS]                           |
|  +-- initializeToolPermissionContext()                     |
|  +-- 解析 MCP 配置                                         |
|  +-- Claude in Chrome 设置                                 |
|  +-- 验证格式                                               |
|  +-- getInputPrompt()                                      |
|  +-- getTools(toolPermissionContext)                       |
|  +-- initBuiltinPlugins() + initBundledSkills()            |
|  +-- setup() [与 getCommands/getAgentDefs 并行]            |
|  +-- [仅交互] showSetupScreens()                           |
|  +-- [信任后] initializeTelemetryAfterTrust()              |
|  +-- [信任后] initializeLspServerManager()                 |
|  +-- MCP 配置解析 + prefetchAllMcpResources               |
|  +-- processSessionStartHooks('startup')                   |
|  +--                                                        |
|  +-- IF --init-only: 处理 hooks -> 退出                   |
|  +-- IF --print 模式: runHeadless(...)                      |
|  +-- IF 交互:                                              |
|       +-- IF --continue: 加载会话 -> launchRepl()          |
|       +-- IF --resume: 恢复选择器 -> launchRepl()          |
|       +-- IF cc://: 创建直接连接 -> launchRepl()           |
|       +-- IF ssh: 创建 SSH 会话 -> launchRepl()           |
|       +-- IF assistant: assistant 会话 -> launchRepl()     |
|       +-- ELSE: launchRepl() (新会话)                       |
+-----------------------------------------------------------+
```

---

## 5. 关键类型定义

**PendingConnect** (main.tsx:543-547):
```typescript
type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};
```

**PendingAssistantChat** (main.tsx:555-558):
```typescript
type PendingAssistantChat = {
  sessionId?: string;
  discover?: boolean;
};
```

**PendingSSH** (main.tsx:567-576):
```typescript
type PendingSSH = {
  host?: string;
  cwd?: string;
  local?: boolean;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  extraCliArgs: string[];
};
```

---

## 6. 迁移编目

| 迁移 | 文件 | 用途 | 特性开关/守卫 |
|------|------|------|--------------|
| `migrateAutoUpdatesToSettings()` | migrateAutoUpdatesToSettings.ts | 将 user-disabled autoUpdates 从全局配置移到 settings.json | `globalConfig.autoUpdates === false` |
| `migrateBypassPermissionsAcceptedToSettings()` | migrateBypassPermissionsAcceptedToSettings.ts | 将 `bypassPermissionsModeAccepted` 移到 settings.json | 全局配置中存在该字段 |
| `migrateEnableAllProjectMcpServersToSettings()` | migrateEnableAllProjectMcpServersToSettings.ts | 将 MCP 服务器审批字段移到本地设置 | 项目配置中存在这些字段 |
| `resetProToOpusDefault()` | resetProToOpusDefault.ts | 为 Pro 用户设置时间戳以通知默认模型变更 | `isProSubscriber()` |
| `migrateSonnet1mToSonnet45()` | migrateSonnet1mToSonnet45.ts | 固定 sonnet[1m] 用户到显式 4.5 | `!config.sonnet1m45MigrationComplete` |
| `migrateLegacyOpusToCurrent()` | migrateLegacyOpusToCurrent.ts | 将旧 Opus 字符串重映射到 'opus' 别名 | `isLegacyModelRemapEnabled()` |
| `migrateSonnet45ToSonnet46()` | migrateSonnet45ToSonnet46.ts | 将 Pro/Max/Team 用户从 Sonnet 4.5 迁移到 4.6 | 1P 用户 + 订阅者 |
| `migrateOpusToOpus1m()` | migrateOpusToOpus1m.ts | 为 Max/Team 用户将 'opus' 迁移到 'opus[1m]' | `isOpus1mMergeEnabled()` |
| `migrateReplBridgeEnabledToRemoteControlAtStartup()` | migrateReplBridgeEnabledToRemoteControlAtStartup.ts | 复制 replBridgeEnabled -> remoteControlAtStartup | 旧键存在且新键未设置 |
| `resetAutoModeOptInForDefaultOffer()` | resetAutoModeOptInForDefaultOffer.ts | 清除旧的自动模式选择对话框 | `feature('TRANSCRIPT_CLASSIFIER')` |
| `migrateFennecToOpus()` | migrateFennecToOpus.ts | 将已移除的 fennec 模型别名重映射到 Opus | `USER_TYPE === 'ant'` |

所有迁移由 `CURRENT_MIGRATION_VERSION = 11` 跟踪。当 `globalConfig.migrationVersion !== 11` 时，所有同步迁移运行并版本号更新。

---

## 7. 关键洞察

**eagerLoadSettings()** (main.tsx:502-516): 在 `init()` 运行前解析 `--settings` 和 `--setting-sources` 标志，使用 `eagerParseCliFlag()`。这是必要的，因为 `init()` 调用 `applySafeConfigEnvironmentVariables()` 读取设置，而那些设置必须已包含标志提供的值。

**initializeEntrypoint()** (main.tsx:517-540): 如果尚未设置，则设置 `CLAUDE_CODE_ENTRYPOINT` 环境变量。优先级: (1) 已设置则跳过 (SDK/外部), (2) `mcp serve` 检测到则设为 `'mcp'`, (3) GitHub Action 则设为 `'claude-code-github-action'`, (4) 非交互则设为 `'sdk-cli'`, (5) 交互则设为 `'cli'`。

**init()** (entrypoints/init.ts:57-238): 通过 lodash 记忆化。运行一次不再运行。在 `ConfigParseError` 时，根据 `getIsNonInteractiveSession()` 显示交互对话框或 stderr 消息。

**setup()** (setup.ts:56-477): 从动作处理器调用，与 `getCommands()` 和 `getAgentDefinitionsWithOverrides()` 并行化。关键职责: Node.js 版本检查 (>=18)、UDS 消息、worktree 创建、hooks 快照、会话记忆初始化、权限安全验证、记录 `tengu_started` 事件。

**两次 Commander parseAsync 调用**: (1) 第 3887 行 - 仅 print 模式，在子命令注册前解析（避免 -p 加载子命令模块）。(2) 第 4504 行 - 所有其他路径，在完整子命令注册后解析。