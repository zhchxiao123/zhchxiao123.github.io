---
title: "Step 2: 分层架构与依赖流向"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/02-layer-architecture/
---


> 分析日期: 2026-04-16
> 核心方法: 目录分类、依赖枚举、违规识别

---

## 1. 目录清单（src/ 下 36 个顶级目录）

| # | 目录 | 文件数（约） | 主要内容 |
|---|------|-------------|---------|
| 1 | assistant/ | ~2 | 会话历史 |
| 2 | bootstrap/ | 1 | 应用状态初始化 |
| 3 | bridge/ | ~8 | 远程桥接进程 (SDK/IPC) |
| 4 | buddy/ | ~4 | Buddy/伴游精灵功能 |
| 5 | cli/ | ~15 | CLI 命令处理器 |
| 6 | commands/ | ~60+ | 斜杠命令定义 |
| 7 | components/ | ~100+ | React/Ink UI 组件 |
| 8 | constants/ | ~6 | 全局常量 |
| 9 | context/ | ~9 | React context provider |
| 10 | coordinator/ | ~2 | Coordinator/swarm 模式逻辑 |
| 11 | entrypoints/ | ~10 | 应用入口点 |
| 12 | hooks/ | ~15 | React hooks |
| 13 | ink/ | ~60+ | Fork 的 Ink 终端渲染框架 |
| 14 | keybindings/ | ~12 | 键绑定系统 |
| 15 | memdir/ | ~8 | 记忆目录管理 |
| 16 | migrations/ | ~12 | 设置/数据迁移脚本 |
| 17 | native-ts/ | ~6 | 原生 TypeScript 模块 |
| 18 | outputStyles/ | ~2 | 输出样式加载 |
| 19 | plugins/ | ~3 | 插件注册基础设施 |
| 20 | query/ | ~5 | 查询循环编排 |
| 21 | remote/ | ~5 | 远程会话管理 (WebSocket) |
| 22 | schemas/ | ~2 | JSON/hook schema |
| 23 | screens/ | ~3 | 顶级屏幕组件 |
| 24 | server/ | ~4 | 直接连接服务器 (SDK) |
| 25 | services/ | ~50+ | 业务服务 |
| 26 | skills/ | ~8 | 技能加载/内置技能 |
| 27 | state/ | ~5 | 应用状态 store |
| 28 | tasks/ | ~15 | 任务类型 |
| 29 | tools/ | ~50+ | 工具实现 (~35 个工具 + 共享) |
| 30 | types/ | ~10 | 类型定义 |
| 31 | upstreamproxy/ | ~2 | 上游代理中继 |
| 32 | utils/ | ~100+ | 工具函数 |
| 33 | vim/ | ~5 | Vim 模式编辑器逻辑 |
| 34 | voice/ | ~2 | 语音模式切换 |

---

## 2. 层次图

```
                    +---------------------------+
                    |     传输层 (Transport)     |
                    | bridge, cli, remote,      |
                    | server, entrypoints,      |
                    | upstreamproxy             |
                    +-----------+---------------+
                                |
                    依赖于      |  依赖于
                    +-----------v-----------+   +--------------------------+
                    |   应用层 (Application) |   |   任务/Agent 层          |
                    | query, commands, tools, |   | tasks/                   |
                    | skills, coordinator     |   | (LocalAgent, Remote,    |
                    +-----------+------------+   |  Dream, Shell, Teammate)|
                                |               +------------+-------------+
                    依赖于      |                            |
                    +-----------v------------+   依赖于      |
                    |    服务层 (Service)    |<-------------+
                    | services/ (api, mcp,   |
                    | oauth, analytics, lsp,|
                    | compact, plugins, 等)  |
                    +-----------+------------+
                                |
                    依赖于      |
                    +-----------v------------+
                    |  基础设施层 (Infra)    |
                    | utils, constants,      |
                    | types, schemas, state,  |
                    | migrations, bootstrap,  |
                    | memdir, native-ts       |
                    +-----------+------------+
                                |
                    依赖于      |
                    +-----------v------------+
                    |   表现层 (Presentation)|
                    | components, hooks, ink, |
                    | screens, vim, keybinds, |
                    | voice, context, buddy   |
                    +------------------------+
```

**允许的依赖方向（自上而下）:**
```
Transport --> Application --> Service --> Infrastructure
Transport --> Task/Agent --> Service --> Infrastructure
Presentation --> Application --> Service --> Infrastructure
Application --> Task/Agent (允许，工具分派任务)
Application --> Infrastructure (允许)
Service --> Infrastructure (允许)
Infrastructure --> (无 - 叶层)
```

**特殊跨层允许路径:**
- `components/` -> `services/` (允许: UI 读取服务状态如 analytics, compact)
- `components/` -> `utils/` (允许: UI 使用工具函数)
- `components/` -> `tools/` (允许: UI 渲染工具输出)
- `components/` -> `tasks/` (允许: UI 显示任务状态)
- `components/` -> `state/` (允许: UI 读取状态 store)
- `hooks/` -> `services/` (允许: hooks 调用服务)
- `keybindings/` -> `ink/` (允许: 键绑定依赖 Ink 输入类型)
- `context/` -> `state/`, `ink/` (允许: context provider 读取状态)

---

## 3. 依赖矩阵

图例: **A** = 允许, **F** = 禁止（按整洁架构）, **V** = 代码库中发现违规

| 导入者 \ 被导入 | 表现层 | 应用层 | 服务层 | 基础设施 | 传输层 | 任务/Agent |
|-----------------|--------|--------|--------|---------|--------|------------|
| **表现层**      | A(内部) | A | A | A | F | A |
| **应用层**      | F | A(内部) | A | A | F | A |
| **服务层**      | **V** | F | A(内部) | A | F | F |
| **基础设施**    | **V** | F | **V** | A(内部) | F | **V** |
| **传输层**      | **V** | A | A | A | A(内部) | A |
| **任务/Agent**  | F | A | A | A | F | A(内部) |

---

## 4. 违规清单

### 类别 A: 服务层导入表现层 (5 处, 严重性: 高)

| 文件路径 | 导入者层 | 被导入者 | 原因 |
|---------|---------|---------|------|
| `services/mcpServerApproval.tsx` | 服务 | `components/MCPServerApprovalDialog.js` | 服务直接实例化 UI 对话框 |
| `services/mcpServerApproval.tsx` | 服务 | `components/MCPServerMultiselectDialog.js` | 服务直接实例化多选对话框 |
| `services/mcpServerApproval.tsx` | 服务 | `ink.js` (Root 类型) | 服务引用 Ink Root 类型 |
| `services/mcpServerApproval.tsx` | 服务 | `keybindings/KeybindingProviderSetup.js` | 服务依赖键绑定设置 |
| `services/notifier.ts` | 服务 | `ink/useTerminalNotification.js` (类型) | 服务引用终端通知类型 |

**根因:** MCP 服务器审批流混合了服务逻辑和 UI 渲染。审批对话框应从表现层启动，而非服务层。

### 类别 B: 基础设施导入表现层 (16 处, 严重性: 中)

| 文件路径 | 被导入者 | 原因 |
|---------|---------|------|
| `utils/exportRenderer.tsx` | `components/Messages.js` | 工具渲染组件用于导出 |
| `utils/markdown.ts` | `components/design-system/color.js` | 工具使用 UI 颜色系统 |
| `utils/completionCache.ts` | `components/design-system/color.js` | 工具使用 UI 颜色系统 |
| `utils/handlePromptSubmit.ts` | `components/MessageSelector.js` | 工具访问消息选择过滤器 |
| `utils/handlePromptSubmit.ts` | `components/Spinner/types.js` | 工具引用 spinner 类型 |
| `utils/messages.ts` | `components/Spinner.js` (类型) | 工具引用 spinner 类型 |
| `utils/terminal.ts` | `components/CtrlOToExpand.js` | 工具引用 UI 组件 |
| `utils/autoRunIssue.tsx` | `components/design-system/KeyboardShortcutHint.js` | 工具渲染键盘快捷提示 |
| `utils/preflightChecks.tsx` | `components/Spinner.js` | 工具渲染 spinner |
| `utils/treeify.ts` | `components/design-system/color.js` | 工具使用 UI 颜色系统 |
| `utils/teleport.tsx` | `components/TeleportError.js` | 工具引用传送错误 |
| `utils/autoRunIssue.tsx` | `ink.js` (Box, Text) | 工具渲染 Ink UI 元素 |
| `utils/statusNoticeDefinitions.tsx` | `ink.js` (Box, Text) | 工具渲染 Ink UI 元素 |
| `utils/preflightChecks.tsx` | `ink.js` (Box, Text) | 工具渲染 Ink UI 元素 |
| `utils/exportRenderer.tsx` | `keybindings/KeybindingContext.js` | 工具依赖键绑定上下文 |
| `utils/exportRenderer.tsx` | `keybindings/loadUserBindings.js` | 工具依赖键绑定加载 |

**根因:** 产生终端输出的 `utils/` 文件直接导入 `components/` 和 `ink/`。`design-system/color.js` 被多个工具引用用于终端颜色输出。

### 类别 C: 基础设施导入服务层 (28 处, 严重性: 高)

| 文件路径 | 被导入者 | 原因 |
|---------|---------|------|
| `utils/contextAnalysis.ts` | `services/tokenEstimation.js` | 工具调用 token 估算服务 |
| `utils/queryContext.ts` | `services/mcp/types.js` (类型) | 工具引用 MCP 连接类型 |
| `utils/imageValidation.ts` | `services/analytics/index.js` | 工具调用分析日志 |
| `utils/sideQuestion.ts` | `services/api/errorUtils.js` | 工具调用 API 错误格式化 |
| `utils/toolSearch.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| `utils/toolSearch.ts` | `services/analytics/index.js` | 工具调用分析日志 |
| `utils/gracefulShutdown.ts` | `services/analytics/datadog.js` | 工具调用分析关闭 |
| `utils/gracefulShutdown.ts` | `services/analytics/firstPartyEventLogger.js` | 工具调用分析关闭 |
| `utils/gracefulShutdown.ts` | `services/analytics/index.js` | 工具调用分析日志 |
| `utils/planModeV2.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| `utils/imagePaste.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| `utils/fastMode.ts` | `services/analytics/index.js` | 工具调用分析日志 |
| `utils/claudemd.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| `utils/managedEnv.ts` | `services/remoteManagedSettings/syncCache.js` | 工具读取托管设置缓存 |
| `utils/auth.ts` | `services/oauth/client.js` | 工具调用 OAuth 客户端 |
| `utils/auth.ts` | `services/oauth/getOauthProfile.js` | 工具调用 OAuth 配置 |
| `utils/analyzeContext.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| `utils/analyzeContext.ts` | `services/compact/autoCompact.js` | 工具调用 compact 服务 |
| `utils/analyzeContext.ts` | `services/tokenEstimation.js` | 工具调用 token 估算 |
| `utils/sideQuery.ts` | `services/analytics/index.js` | 工具调用分析 |
| `utils/sideQuery.ts` | `services/api/claude.js` | 工具调用 API 客户端 |
| `utils/queryHelpers.ts` | `services/tools/toolOrchestration.js` | 工具调用工具编排 |
| `utils/messages.ts` | `services/analytics/growthbook.js` | 工具读取特性开关 |
| ... | ... | ... |

**根因:** `utils/` 目录已成为"万能模块"，包含纯工具函数和应用逻辑。特性开关检查（`growthbook`）和分析日志（`logEvent`）散布在 utils 各处。

### 类别 D: 基础设施导入应用层 (21 处, 严重性: 中)

| 文件路径 | 被导入者 | 原因 |
|---------|---------|------|
| `utils/contextSuggestions.ts` | `tools/BashTool/toolName.js` | 工具引用工具名常量 |
| `utils/imagePaste.ts` | `tools/FileReadTool/imageProcessor.js` | 工具调用图像处理器 |
| `utils/notebook.ts` | `tools/BashTool/toolName.js` | 工具引用工具名常量 |
| `utils/notebook.ts` | `tools/BashTool/utils.js` | 工具调用 bash 工具工具函数 |
| `utils/systemPrompt.ts` | `tools/AgentTool/loadAgentsDir.js` | 工具引用 agent 定义 |
| `utils/analyzeContext.ts` | `tools/AgentTool/loadAgentsDir.js` | 工具引用 agent 定义 |
| `utils/messages.ts` | `tools/FileReadTool/FileReadTool.js` | 工具引用文件读取工具 |
| `utils/forkedAgent.ts` | `query.js` | 工具直接调用查询循环 |
| `utils/swarm/inProcessRunner.ts` | `tasks.js` | 工具调用任务框架 |
| ... | ... | ... |

**根因:** 工具名称常量散布在各个工具目录中，而非共享常量位置。`query.js` 的导入是特别严重的耦合。

### 类别 E: 传输层导入表现层 (8 处, 严重性: 低)

| 文件路径 | 被导入者 | 原因 |
|---------|---------|------|
| `cli/handlers/util.tsx` | `components/LogoV2/WelcomeV2.js` | CLI 渲染欢迎 UI |
| `cli/handlers/mcp.tsx` | `components/MCPServerDesktopImportDialog.js` | CLI 渲染 MCP 对话框 |
| `bridge/bridgeStatusUtil.ts` | `ink/stringWidth.js` | Bridge 使用 Ink 字符串宽度工具 |
| `bridge/bridgeUI.ts` | `ink/stringWidth.js` | Bridge 使用 Ink 字符串宽度工具 |

**根因:** CLI 处理器是 TSX 文件，直接渲染 UI。由于 CLI 是引导整个应用（包括 UI）的入口，这在某种程度上是预期的。

### 类别 F: 常量导入应用/服务层 (10 处, 严重性: 中)

| 文件路径 | 被导入者 | 原因 |
|---------|---------|------|
| `constants/tools.ts` | `tools/...` (20+ 工具名导入) | 常量从工具目录聚合工具名 |
| `constants/prompts.ts` | `tools/AgentTool/constants.js` | 提示常量引用工具常量 |
| `constants/prompts.ts` | `tools/FileWriteTool/prompt.js` | 提示常量引用工具提示 |
| `constants/system.ts` | `services/analytics/growthbook.js` | 系统常量读取特性开关 |

---

## 5. 违规总结

| 违规类别 | 数量 | 严重性 |
|---------|------|--------|
| 服务 -> 表现层 | 5 | **高** - 服务不应渲染 UI |
| 基础设施 -> 表现层 | 16 | **中** - 工具函数不应依赖 UI 组件 |
| 基础设施 -> 服务层 | 28 | **高** - utils 形成了触及服务的"上帝模块" |
| 基础设施 -> 应用层 | 21 | **中** - utils 导入工具/query |
| 基础设施 -> 任务/Agent | 5 | **低-中** - utils 引用任务类型/函数 |
| 传输 -> 表现层 | 8 | **低** - CLI 入口点自然引导 UI |
| 常量 -> 应用/服务层 | 10 | **中** - 常量依赖具体实现 |
| **总计** | **~93** | |

---

## 6. 关键架构问题

1. **`utils/` 是上帝模块**: 100+ 文件的 `utils/` 目录从每个其他层导入 —— 服务、工具、任务、组件、ink、键绑定、状态和查询。它充当没有明确边界的共享倾倒场。这是最大的单一架构问题。

2. **工具名称常量去中心化**: 工具名字符串定义在各个工具目录中（如 `tools/BashTool/toolName.js`）。`constants/tools.ts` 和众多工具文件都从工具层导入这些名称，形成了基础设施依赖应用层的违规。这些常量应反向流动。

3. **特性开关和分析无处不在**: `services/analytics/growthbook.js`（特性开关）和 `services/analytics/index.js`（事件日志）从几乎每个层导入，包括基础设施、表现和传输层。这是一个横切关注点，应通过注入或薄抽象提供。

4. **MCP 审批中的服务到表现层泄漏**: `services/mcpServerApproval.tsx` 是唯一直接渲染 UI 对话框的服务文件。应重构使服务返回权限请求数据结构，由表现层处理对话框。

5. **CLI 处理器具有表现层意识**: `cli/` 目录包含直接渲染组件和设置 Ink 渲染树的 TSX 文件。虽然对于入口点在某种程度上不可避免，但这将 CLI 层与表现框架紧密耦合。

---

## 7. 推荐重构优先级

1. **提取共享常量**: 将工具名常量从 `tools/*/constants.js` 移入 `constants/tools.ts`，然后工具从常量导入（逆转依赖）。

2. **拆分 `utils/` 为层**: 将纯工具函数（字符串操作、路径处理、JSON 解析）与应用逻辑（analyzeContext, messages, processUserInput, systemPrompt）分离。将应用逻辑移入应用或服务层。

3. **创建分析抽象**: 通过 `types/` 或 `constants/` 中的薄接口提供特性开关和事件日志，由服务实现，而非每个层直接从 `services/analytics/` 导入。

4. **解耦 MCP 审批**: 重构 `mcpServerApproval.tsx` 返回权限请求数据结构，由表现层消费，移除直接组件导入。

5. **将 design-system/color 移至基础设施**: `components/design-system/color.js` 模块被多个工具导入。由于它提供终端颜色代码（非 React 组件），应放在 `utils/` 或共享的 `styles/` 基础设施模块中。