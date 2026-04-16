---
title: "Step 4: 特性开关与死代码消除"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/04-feature-gates/
---


> 分析日期: 2026-04-16
> 核心文件: constants/betas.ts, services/analytics/growthbook.ts, bun:bundle feature()

---

## 1. 两层特性开关架构

### 第一层: 编译时 `feature()` (来自 `bun:bundle`)

`feature()` 函数从 `bun:bundle` 导入，作为**编译时死代码消除**机制。当 `feature('FLAG')` 返回 `false` 时，Bun 的打包器将受保护的代码从输出中完全消除。这些标志是**二元的**（开/关），在构建时烘焙 —— 它们区分内部 ("ant") 构建和外部/公开构建。

### 第二层: 运行时 GrowthBook 特性开关

GrowthBook 提供**运行时**特性开关，从远程服务器获取。通过以下方式读取:
- `getFeatureValue_CACHED_MAY_BE_STALE(feature, default)` —— 优先，非阻塞
- `getFeatureValue_DEPRECATED(feature, default)` —— 阻塞，已弃用
- `checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate)` —— 布尔门，Statsig 迁移
- `checkGate_CACHED_OR_BLOCKING(gate)` —— 磁盘缓存显示 false 时阻塞
- `checkSecurityRestrictionGate(gate)` —— 认证变更后等待重新初始化
- `getDynamicConfig_CACHED_MAY_BE_STALE(config, default)` —— 对象配置

---

## 2. 编译时 `feature()` 标志完整编目

| # | 标志名 | 主要文件 | 用途 | 关闭时消除的死代码 |
|---|--------|---------|------|-------------------|
| 1 | `ABLATION_BASELINE` | entrypoints/cli.tsx:21 | 消融测试基线模式 | 启动时整个消融测试路径 |
| 2 | `AGENT_MEMORY_SNAPSHOT` | main.tsx:2258, tools/AgentTool/loadAgentsDir.ts:348 | 自定义 Agent 记忆快照 | Agent 记忆快照功能 |
| 3 | `AGENT_TRIGGERS` | skills/bundled/index.ts:47, tools.ts:29 | 定时任务/Cron 触发器 | 所有调度/Cron 工具, /loop 技能 |
| 4 | `AGENT_TRIGGERS_REMOTE` | skills/bundled/index.ts:56, tools.ts:36 | 远程 Agent 触发器 | 远程 Agent 调度技能 |
| 5 | `ANTI_DISTILLATION_CC` | services/api/claude.ts:303 | CC 反蒸馏 | 反蒸馏头 |
| 6 | `AUTO_THEME` | tools/ConfigTool/supportedSettings.ts:34 | 自动主题检测 | 配置中的自动主题设置, ThemeProvider 自动检测 |
| 7 | `AWAY_SUMMARY` | hooks/useAwaySummary.ts:54 | 离开/休眠摘要 | 整个离开摘要 hook |
| 8 | `BASH_CLASSIFIER` | tools/BashTool/bashPermissions.ts | ML Bash 命令分类 | Bash 分类器逻辑, 影子评估, tree-sitter 解析 |
| 9 | `BG_SESSIONS` | main.tsx:1116, entrypoints/cli.tsx:185 | 后台会话支持 | 后台会话 CLI 命令和恢复逻辑 |
| 10 | `BRIDGE_MODE` | commands.ts:73,77, main.tsx:2246,3866,4322 | IDE 集成远程控制/bridge 模式 | 整个 bridge 系统, 远程控制 CLI, bridge 设置 |
| 11 | `BUDDY` | commands.ts:118, components/PromptInput/PromptInput.tsx | Buddy/伴游精灵功能 | 伴游精灵, Buddy 通知, /buddy 命令 |
| 12 | `CACHED_MICROCOMPACT` | constants/prompts.ts:66, services/api/claude.ts | 缓存微紧凑优化 | 缓存 MC 状态, MC 配置读取, MC 头注入 |
| 13 | `CCR_AUTO_CONNECT` | bridge/bridgeEnabled.ts:186 | CCR 自动连接 bridge | 自动连接 bridge 逻辑 |
| 14 | `CCR_MIRROR` | bridge/bridgeEnabled.ts:198, main.tsx:1477,1608 | CCR 镜像模式 | 镜像模式检测, bridge 出站处理 |
| 15 | `CCR_REMOTE_SETUP` | commands.ts:91 | CCR 远程设置命令 | /remote-setup 命令 |
| 16 | `CHICAGO_MCP` | main.tsx:1477,1608, entrypoints/cli.tsx:86 | 计算机 MCP (Chicago) | --computer-use-mcp CLI 入口, MCP 服务器设置 |
| 17 | `COMMIT_ATTRIBUTION` | cli/print.ts:809,2833,4112 | Git 提交归属追踪 | 提交流程中的归属逻辑 |
| 18 | `CONNECTOR_TEXT` | constants/betas.ts:23, services/api/claude.ts | 连接器文本摘要 beta | API 中的连接器文本块过滤 |
| 19 | `CONTEXT_COLLAPSE` | tools.ts:110, services/compact/autoCompact.ts:179 | 上下文崩溃用于 compact | CtxInspectTool, 自动紧凑崩溃模式 |
| 20 | `COORDINATOR_MODE` | main.tsx:76,1872,3770, tools.ts:120,280 | 多 Agent coordinator 模式 | Coordinator 模块, coordinator 命令 |
| 21 | `DAEMON` | commands.ts:77, entrypoints/cli.tsx:100,165 | 守护进程模式 | --daemon-worker CLI, daemon 命令 |
| 22 | `DIRECT_CONNECT` | main.tsx:548,612,3156 | 直接连接到远程会话 | 待处理连接结构, 直接连接 CLI 路径 |
| 23 | `DOWNLOAD_USER_SETTINGS` | services/settingsSync/index.ts:160 | 用户设置下载同步 | 设置同步下载 |
| 24 | `DUMP_SYSTEM_PROMPT` | entrypoints/cli.tsx:53 | --dump-system-prompt CLI | 系统提示转储 CLI |
| 25 | `EXPERIMENTAL_SKILL_SEARCH` | commands.ts:96, constants/prompts.ts:95 | 实验性技能搜索 | 远程技能模块, 技能搜索逻辑 |
| 26 | `EXTRACT_MEMORIES` | cli/print.ts:374,967 | 提取记忆模式 | 提取记忆模块 |
| 27 | `FILE_PERSISTENCE` | cli/print.ts:2134,2256 | 跨回合文件持久化 | 回合开始时间追踪, 文件持久化保存逻辑 |
| 28 | `FORK_SUBAGENT` | commands.ts:113 | Fork 子 Agent 命令 | /fork 命令 |
| 29 | `HARD_FAIL` | main.tsx:3870 | 硬失败模式 | 主循环中的硬失败处理 |
| 30 | `HISTORY_PICKER` | components/PromptInput/PromptInput.tsx | 历史选择器 UI | 历史选择器组件和键盘绑定 |
| 31 | `HISTORY_SNIP` | QueryEngine.ts:122,125,1276, tools.ts:123 | 历史裁剪 (VCR/snip 工具) | Snip 模块, SnipTool, /snip 命令 |
| 32 | `KAIROS` | 50+ 位置跨 15+ 文件 | **核心 Kairos/assistant 模式** | 整个 assistant 模式系统, BriefTool, 会话恢复, 等 |
| 33 | `KAIROS_BRIEF` | main.tsx:1728,2184,2918, commands.ts:67 | Brief 模式 (轻量 Kairos brief) | BriefTool, brief 提示段落, brief 布局 |
| 34 | `KAIROS_CHANNELS` | main.tsx:1642,3841,4334 | Kairos 通道 (消息通道) | ChannelsNotice 组件, 通道键绑定 |
| 35 | `KAIROS_DREAM` | skills/bundled/index.ts:35 | Kairos 梦境 (自动 dream) | Dream 技能注册 |
| 36 | `KAIROS_GITHUB_WEBHOOKS` | commands.ts:101, tools.ts:50 | GitHub webhook 订阅 | /subscribe-pr 命令, SubscribePRTool |
| 37 | `KAIROS_PUSH_NOTIFICATION` | tools.ts:46 | Kairos 推送通知工具 | 推送通知工具注册 |
| 38 | `LODESTONE` | main.tsx:647,3781 | Lodestar/lodestone 功能 (深链接) | Lodestone 激活路径 |
| 39 | `MCP_RICH_OUTPUT` | tools/MCPTool/UI.tsx:51,125,139 | MCP 工具结果富输出渲染 | MCPTextOutput 组件 |
| 40 | `MONITOR_TOOL` | tools.ts:39, tools/BashTool/BashTool.tsx:525 | 后台任务监控工具 | MonitorTool 注册, 监控提示段落 |
| 41 | `PERFETTO_TRACING` | utils/telemetry/perfettoTracing.ts | Perfetto 追踪输出 | 整个 Perfetto 追踪系统 |
| 42 | `PROACTIVE` | commands.ts:63, screens/REPL.tsx:194,198 | 主动模式 | 主动模块, useProactive hook, 主动提示 |
| 43 | `PROMPT_CACHE_BREAK_DETECTION` | services/api/claude.ts:1460,2383 | 提示缓存中断检测 | Compact 和 API 层中的缓存中断检测 |
| 44 | `QUICK_SEARCH` | keybindings/defaultBindings.ts:52 | 快速搜索 UI | 快速搜索组件, 键绑定 |
| 45 | `REACTIVE_COMPACT` | services/compact/autoCompact.ts:195 | 反应式压缩触发 | 反应式紧凑检测 |
| 46 | `SSH_REMOTE` | main.tsx:577,706,3193,4045 | SSH 远程会话连接 | 待处理 SSH 结构, SSH 连接路径 |
| 47 | `STREAMLINED_OUTPUT` | cli/print.ts:857 | 精简输出格式 | 精简输出显示逻辑 |
| 48 | `TEAMMEM` | memdir/memdir.ts:7, utils/claudemd.ts:82 | 团队记忆系统 | 团队记忆路径, 团队记忆监视器, 团队记忆同步 |
| 49 | `TEMPLATES` | entrypoints/cli.tsx:212 | 模板项目创建 | new/list/reply CLI 命令 |
| 50 | `TERMINAL_PANEL` | tools.ts:113, keybindings/defaultBindings.ts:60 | 终端面板 | TerminalCaptureTool, 终端键绑定 |
| 51 | `TOKEN_BUDGET` | constants/prompts.ts:538, components/PromptInput/PromptInput.tsx | Token 预算显示 | Token 预算提示段落 |
| 52 | `TRANSCRIPT_CLASSIFIER` | main.tsx:171,337, tools/BashTool/bashPermissions.ts | 自动模式/转录分类器 | 'auto' 权限模式, autoModeState 模块, AFK 模式 |
| 53 | `UDS_INBOX` | screens/REPL.tsx:199, commands.ts:108, tools.ts:126 | Unix 域套接字收件箱 | ListPeersTool, UDS 收件箱路径 |
| 54 | `ULTRAPLAN` | commands.ts:104,468 | 超级计划模式 | Ultraplan 命令, 触发检测 |
| 55 | `UPLOAD_USER_SETTINGS` | services/settingsSync/index.ts:63 | 用户设置上传同步 | 设置同步上传路径 |
| 56 | `VERIFICATION_AGENT` | constants/prompts.ts:391 | 任务更新中的验证 Agent | 验证 Agent 提示 |
| 57 | `VOICE_MODE` | screens/REPL.tsx:98,103, commands.ts:80 | 语音输入模式 (按讲) | 语音集成 hook, 语音设置, /voice 命令 |
| 58 | `WEB_BROWSER_TOOL` | screens/REPL.tsx:272, tools.ts:117 | Web 浏览器工具 | WebBrowserPanelModule, WebBrowserTool |
| 59 | `WORKFLOW_SCRIPTS` | constants/tools.ts:45, tools.ts:129 | 工作流脚本 | WORKFLOW_TOOL_NAME, WorkflowTool, 工作流命令 |

---

## 3. 运行时 GrowthBook 特性开关 (tengu_* 名称)

| # | GrowthBook 标志 | 默认值 | 用途 |
|---|----------------|--------|------|
| 1 | `tengu_agent_list_attach` | false | Agent 列表附件 |
| 2 | `tengu_amber_flint` | true | Agent swarms 启用（默认开，杀死开关）|
| 3 | `tengu_amber_json_tools` | false | JSON 工具输出 beta |
| 4 | `tengu_amber_prism` | false | 消息格式变体 |
| 5 | `tengu_amber_quartz_disabled` | false | 语音模式杀死开关（否定：disabled=true 表示关闭）|
| 6 | `tengu_amber_stoat` | true | 内置 Agent 启用（默认开）|
| 7 | `tengu_attribution_header` | true | 系统提示中的归属头 |
| 8 | `tengu_auto_background_agents` | false | 自动后台 Agent |
| 9 | `tengu_basalt_3kr` | false | MCP 指令增量 |
| 10 | `tengu_birch_trellis` | true | Tree-sitter bash 影子（默认开）|
| 11 | `tengu_bramble_lintel` | null(1) | 记忆提取并行度 |
| 12 | `tengu_bridge_repl_v2` | false | Bridge REPL v2 |
| 13 | `tengu_ccr_bridge` | false | CCR bridge 门控 |
| 14 | `tengu_ccr_bundle_seed_enabled` | bool | 传送的 bundle seed |
| 15 | `tengu_ccr_mirror` | false | CCR 镜像功能 |
| 16 | `tengu_chair_sermon` | bool | 消息渲染变体 (Statsig) |
| 17 | `tengu_chomp_inflection` | false | 提示建议变体 |
| 18 | `tengu_chrome_auto_enable` | false | Chrome 自动启用 |
| 19 | `tengu_cicada_nap_ms` | 0 | 后台刷新节流 (ms) |
| 20 | `tengu_cobalt_harbor` | false | Cobalt harbor bridge 功能 |
| 21 | `tengu_cobalt_lantern` | false | 远程设置 |
| 22 | `tengu_cobalt_raccoon` | false | Compact/上下文分析变体 |
| 23 | `tengu_collage_kaleidoscope` | true | 图片拼贴模式（默认开）|
| 24 | `tengu_copper_bridge` | false | Chrome MCP bridge |
| 25 | `tengu_copper_panda` | false | 技能改进功能 |
| 26 | `tengu_coral_fern` | false | 记忆提取变体 |
| 27 | `tengu_destructive_command_warning` | false | 破坏性命令警告 UI |
| 28 | `tengu_glacier_2xr` | false | 2x 工具搜索结果 |
| 29 | `tengu_harbor` | false | Harbor/通道白名单 |
| 30 | `tengu_harbor_permissions` | false | Harbor 通道权限 |
| 31 | `tengu_herring_clock` | false | 团队记忆时间 |
| 32 | `tengu_hive_evidence` | false | 验证 Agent / hive 证据 |
| 33 | `tengu_kairos_brief` | false | Brief 模式运行时门控 |
| 34 | `tengu_lapis_finch` | false | 插件提示推荐 |
| 35 | `tengu_lodestone_enabled` | false | 深链接功能 |
| 36 | `tengu_marble_fox` | false | 附件变体 |
| 37 | `tengu_marble_sandcastle` | false | 快速模式变体 |
| 38 | `tengu_miraculo_the_bard` | false | 提示/歌曲变体 |
| 39 | `tengu_pebble_leaf_prune` | false | 会话存储修剪 |
| 40 | `tengu_quartz_lantern` | false | 文件写入/编辑变体 |
| 41 | `tengu_remote_backend` | false | 远程后端模式 |
| 42 | `tengu_scratch` | bool | Coordinator scratch (Statsig) |
| 43 | `tengu_session_memory` | false | 会话记忆功能 |
| 44 | `tengu_slate_prism` | true | Beta/功能变体（默认开）|
| 45 | `tengu_slim_subagent_claudemd` | true | 精简子 Agent claude.md（默认开）|
| 46 | `tengu_surreal_dali` | false | 远程触发 Agent 功能 |
| 47 | `tengu_terminal_panel` | false | 终端面板运行时门控 |
| 48 | `tengu_terminal_sidebar` | false | 终端侧边栏 UI |
| 49 | `tengu_thinkback` | bool | Thinkback 功能 (Statsig) |
| 50 | `tengu_tool_pear` | bool | Tool pear 功能 (Statsig) |
| 51 | `tengu_trace_lantern` | false | Beta 会话追踪 |
| 52 | `tengu_turtle_carbon` | true | 思考模式（默认开，杀死开关）|
| 53 | `tengu_willow_mode` | 'off' | Willow 模式 (字符串枚举) |
| 54 | `enhanced_telemetry_beta` | false | 增强遥测 beta |

**动态配置标志** (返回对象，非布尔值):
- `tengu_1p_event_batch_config`, `tengu_auto_dream_config`, `tengu_desktop_upsell`
- `tengu_event_sampling_config`, `tengu_chicago_mcp_config`, `tengu_time_based_mc_config`
- `tengu_session_memory_config`, `tengu_advisor_config`, `tengu_yolo_classifier_config`
- `tengu_file_read_limits`, `tengu_prompt_cache_sharing`, `tengu_model_ant_override`
- `tengu_mcp_disabled_commands`, `tengu_keybinding_customization_config`
- `tengu_tool_result_storage_overrides`, `tengu_mcp_validation_overrides`
- `tengu_permission_setup_config`, `tengu_bash_permission_warning_config`
- `tengu_tip_config`, `tengu_channel_allowlist`, `tengu_marketplace_plugins`

---

## 4. 主要死代码区域

当 `feature('X')` 为 `false` 时，Bun 的打包器在构建时消除受保护的代码：

### 4.1 KAIROS（最大的特性开关）

**当 `feature('KAIROS')` 为 false 时，以下被消除:**
- 整个 assistant 模式系统 (`src/assistant/`)
- BriefTool（当 KAIROS_BRIEF 也为 false 时）
- SendUserFileTool
- 通过 session-id 的会话恢复
- Assistant 激活路径
- Kairos 特定提示
- 主动模式集成
- 每日日志记忆提取
- PendingAssistantChat 结构
- 团队上下文计算
- Coordinator 模式会话委托
- Bridge 继续会话
- SleepTool 自动激活
- Kairos 通知处理

### 4.2 TRANSCRIPT_CLASSIFIER

**消除:** 自动模式权限系统、autoModeState 模块、'auto' 权限模式、AFK 模式 beta 头

### 4.3 COORDINATOR_MODE

**消除:** 整个 coordinator 模块、coordinator 会话委托、coordinator 权限处理器

### 4.4 VOICE_MODE

**消除:** 语音集成 hook、VoiceKeybindingHandler、语音设置、语音指示器、按讲键绑定

### 4.5 BRIDGE_MODE

**消除:** 远程控制 CLI 入口、bridge 系统初始化、bridge 模式设置

### 4.6 BASH_CLASSIFIER

**消除:** ML Bash 命令分类器、tree-sitter 影子评估、分类器相关权限字段

### 4.7 TEAMMEM

**消除:** 团队记忆路径、团队记忆监视器、团队记忆同步

### 4.8 AGENT_TRIGGERS

**消除:** Cron 调度模块、所有 Cron 工具、RemoteTriggerTool、/loop 技能

---

## 5. 特性开关依赖图

```
KAIROS ─────────┬── KAIROS_BRIEF (brief 模式子集)
                ├── KAIROS_CHANNELS (消息通道)
                ├── KAIROS_DREAM (dream 技能)
                ├── KAIROS_GITHUB_WEBHOOKS (SubscribePRTool)
                └── KAIROS_PUSH_NOTIFICATION (推送通知)

PROACTIVE ──────┬── (常与 KAIROS 做 OR 组合)
                └── 依赖: PROACTIVE || KAIROS 为 true

TRANSCRIPT_CLASSIFIER ──── BASH_CLASSIFIER (分类器常配对)
                          ├── TREE_SITTER_BASH_SHADOW
                          └── TREE_SITTER_BASH

BRIDGE_MODE ────┬── DAEMON (daemon+bridge)
                └── CCR_MIRROR (bridge 镜像)
                    CCR_AUTO_CONNECT

AGENT_TRIGGERS ── AGENT_TRIGGERS_REMOTE

COORDINATOR_MODE (独立，但与 KAIROS 交互)

VOICE_MODE (独立)

TEAMMEM (独立，与 EXTRACT_MEMORIES 交互)

WEB_BROWSER_TOOL (独立，增强 CHICAGO_MCP)

运行时依赖:
tengu_kairos_brief ────── 依赖: feature('KAIROS') || feature('KAIROS_BRIEF')
tengu_amber_quartz_disabled ── 依赖: feature('VOICE_MODE')
tengu_terminal_panel ── 依赖: feature('TERMINAL_PANEL')
tengu_harbor ────────── 依赖: feature('BRIDGE_MODE')
tengu_ccr_bridge ────── 依赖: feature('BRIDGE_MODE')
tengu_surreal_dali ──── 依赖: feature('AGENT_TRIGGERS_REMOTE')
tengu_lodestone_enabled ── 依赖: feature('LODESTONE')
tengu_scratch ─────────── 依赖: feature('COORDINATOR_MODE')
```

---

## 6. 环境变量覆盖

| 机制 | 适用对象 | 用途 |
|------|---------|------|
| `CLAUDE_INTERNAL_FC_OVERRIDES` (JSON) | `USER_TYPE=ant` 仅限 | 评估测试覆盖 |
| `growthBookOverrides` in global config | `USER_TYPE=ant` 仅限 | /config Gates 标签页覆盖 |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | 任何人 | 禁用快速模式 |
| `CLAUDE_CODE_ABLATION_BASELINE` | ant 仅限 | 消融基线模式 |
| `CLAUDE_CODE_COORDINATOR_MODE` | ant 仅限 | coordinator 模式环境触发 |
| `DISABLE_LOGIN_COMMAND` | 任何人 | 隐藏 /login |
| `DISABLE_LOGOUT_COMMAND` | 任何人 | 隐藏 /logout |
| `DISABLE_DOCTOR_COMMAND` | 任何人 | 隐藏 /doctor |
| `DISABLE_COMPACT` | 任何人 | 隐藏 /compact |
| `USER_TYPE=ant` | ant 仅限 | 启用 ant 专用功能 |

---

## 7. 关键观察

1. **KAIROS 是主导特性开关** —— 在 15+ 文件的 50+ 位置被引用，门控整个 assistant 模式、brief 模式、主动模式和许多子功能。

2. **PROACTIVE 和 KAIROS 常做 OR 组合** (`feature('PROACTIVE') || feature('KAIROS')`)，意味着任一标志开启即可使用主动功能。

3. **双层防御模式**: 许多功能同时有编译时 `feature()` 门和运行时 GrowthBook 门。编译时门防止代码被打包，运行时门允许在 ant 构建中进行细粒度推出。

4. **死代码消除是激进的**: `feature()` 函数为 Bun 的 tree-shaking 设计 —— 当 `feature('X')` 为 false 时，三元表达式 `feature('X') ? require('./module.js') : null` 导致 `require` 及其目标模块从不包含在 bundle 中。

5. **Statsig 迁移**: `checkStatsigFeatureGate_CACHED_MAY_BE_STALE` 函数作为从旧 Statsig 系统到 GrowthBook 的迁移桥梁，同时检查两者。仅剩 4 个 Statsig 门。

6. **安全敏感门** 使用 `checkSecurityRestrictionGate` 或 `checkGate_CACHED_OR_BLOCKING`，在认证变更后阻塞等待新鲜值，确保安全关键决策使用最新服务器值。

7. **代号约定**: 所有 GrowthBook 运行时标志使用 `tengu_` 前缀和 adjective_noun 模式（如 `tengu_amber_flint`, `tengu_cobalt_raccoon`），可能为了避免在分析/日志中泄露功能语义。