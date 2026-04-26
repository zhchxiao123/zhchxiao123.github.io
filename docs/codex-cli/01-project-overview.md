---
title: "Step 1: 项目概览与顶层架构"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/01-project-overview/
---
# OpenAI Codex CLI — 项目概览与顶层架构

> 分析日期：2026-04-21

---

## 1. 项目定位

OpenAI Codex CLI 是一个**多语言协作的编码代理**（coding agent），提供终端 TUI 交互模式和非交互 `exec` 模式，通过 OpenAI Responses API 与 LLM 通信，能在沙箱环境中执行 shell 命令、编辑文件、运行 MCP 工具等。项目通过 Rust 构建高性能核心，通过 TypeScript/Node.js 进行 npm 分发，并提供 Python/TypeScript SDK 供外部集成。

---

## 2. 顶层目录结构

```
codex/                              # Monorepo 根
├── codex-rs/                       # Rust workspace — 核心引擎
│   ├── cli/                        #   CLI 入口 (codex 二进制)
│   ├── tui/                        #   Terminal UI (ratatui)
│   ├── core/                       #   核心业务逻辑 ⚠️ 膨胀中
│   ├── exec/                       #   非交互 exec 模式二进制
│   ├── app-server/                 #   App Server (HTTP/WS JSON-RPC)
│   ├── app-server-protocol/        #   v2 API 协议类型
│   ├── app-server-client/          #   App Server 客户端
│   ├── protocol/                   #   通用协议/共享类型
│   ├── config/                     #   配置加载 (config.toml)
│   ├── codex-mcp/                  #   MCP 连接管理
│   ├── mcp-server/                 #   MCP Server 二进制
│   ├── tools/                      #   内置工具定义
│   ├── sandboxing/                 #   沙箱策略 (Seatbelt/Landlock/Seccomp)
│   ├── exec-server/                #   执行服务器 (session 管理)
│   ├── model-provider/             #   模型提供者抽象
│   ├── models-manager/             #   模型列表/选择管理
│   ├── login/                      #   认证/OAuth/Login
│   ├── state/                      #   SQLite 状态存储
│   ├── otel/                       #   OpenTelemetry 遥测
│   ├── analytics/                  #   遥测/分析上报
│   ├── analytics ... (详见 §3)     #   其余 80+ workspace 成员
│   └── utils/                      #   工具库集合
│       ├── absolute-path/
│       ├── cargo-bin/
│       ├── cache/
│       ├── cli/
│       ├── elapsed/
│       ├── fuzzy-match/
│       ├── home-dir/
│       ├── image/
│       ├── json-to-toml/
│       ├── oss/
│       ├── output-truncation/
│       ├── path-utils/
│       ├── plugins/
│       ├── pty/
│       ├── readiness/
│       ├── rustls-provider/
│       ├── sandbox-summary/
│       ├── sleep-inhibitor/
│       ├── stream-parser/
│       ├── string/
│       └── template/
├── codex-cli/                      # npm 分发包装 (@openai/codex)
│   ├── bin/codex.js                #   Node.js 入口 → spawn Rust 二进制
│   ├── package.json
│   └── scripts/
├── sdk/
│   ├── typescript/                 # TypeScript SDK (@openai/codex-sdk)
│   ├── python/                     # Python SDK (codex-app-server-sdk)
│   └── python-runtime/             # Python 运行时包装 (codex-cli-bin)
├── scripts/                        # 构建/部署/调试脚本
├── docs/                            # 项目文档
│   └── plans/analysis/             #   分析文档输出位置
├── tools/                           # Bazel/CI 工具
├── third_party/                     # 第三方补丁
├── patches/                         # 补丁文件
├── package.json                     # pnpm monorepo 根配置
├── pnpm-workspace.yaml              # pnpm workspace 定义
├── justfile                         # Just 任务运行器
├── MODULE.bazel / BUILD.bazel       # Bazel 构建定义
└── AGENTS.md                        # AI 代理开发规范
```

---

## 3. Rust Workspace 成员分类

Cargo.toml 定义了 **97 个 workspace 成员**（含 22 个 `utils/` 子目录），按职责分类如下：

### 3.1 核心业务 Crates

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-cli` | `cli/` | 顶层 CLI 二进制入口，arg0 分发到 TUI/exec/app-server 子命令 |
| `codex-tui` | `tui/` | 终端 UI 界面（ratatui 渲染、聊天交互、流式输出） |
| `codex-core` | `core/` | 核心业务逻辑（会话管理、LLM 调用循环、工具调度、指令注入） |
| `codex-exec` | `exec/` | 非交互执行模式（CI/CD 集成、单次运行） |
| `codex-app-server` | `app-server/` | HTTP/WebSocket JSON-RPC 服务器，供 SDK/IDE 连接 |
| `codex-app-server-protocol` | `app-server-protocol/` | v2 API 协议类型（请求/响应/通知 + TypeScript 生成） |
| `codex-app-server-client` | `app-server-client/` | App Server 客户端库 |
| `codex-protocol` | `protocol/` | 通用协议共享类型（Session、Tool、Sandbox 等领域模型） |
| `codex-config` | `config/` | 配置文件加载、合并、验证（config.toml + config.schema.json） |
| `codex-exec-server` | `exec-server/` | 执行服务器（session 生命周期、WebSocket 通信） |

### 3.2 工具与集成 Crates

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-tools` | `tools/` | 内置工具定义（Shell、Apply Patch 等 → MCP tool schemas） |
| `codex-mcp` | `codex-mcp/` | MCP 连接管理器（管理 MCP server 生命周期与工具注册） |
| `codex-mcp-server` | `mcp-server/` | 独立 MCP Server 二进制 |
| `codex-sandboxing` | `sandboxing/` | 沙箱策略抽象（Seatbelt macOS / Landlock+Seccomp Linux / Windows） |
| `codex-shell-command` | `shell-command/` | Shell 命令构建与执行 |
| `codex-shell-escalation` | `shell-escalation/` | 升级权限执行（仅 Unix） |
| `codex-apply-patch` | `apply-patch/` | 统一 patch 应用逻辑 |
| `codex-file-search` | `file-search/` | 文件搜索工具 |
| `codex-git-utils` | `git-utils/` | Git 操作工具集 |
| `codex-code-mode` | `code-mode/` | Code Mode 特化逻辑 |
| `codex-execpolicy` | `execpolicy/` | 执行策略定义与校验 |
| `codex-model-provider` | `model-provider/` | 模型提供者 trait 抽象 |
| `codex-model-provider-info` | `model-provider-info/` | 模型元信息（名称、能力、上下文长度等） |
| `codex-models-manager` | `models-manager/` | 模型选择/切换管理 |
| `codex-rmcp-client` | `rmcp-client/` | RMCP 客户端封装 |

### 3.3 认证与基础设施 Crates

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-login` | `login/` | OAuth/Device Code/API Key 认证流程 |
| `codex-client` | `codex-client/` | HTTP 客户端基础层（rustls TLS） |
| `codex-api` | `codex-api/` | OpenAI API 调用层（SSE/WebSocket 流） |
| `codex-otel` | `otel/` | OpenTelemetry 可观测性（traces/metrics/logs） |
| `codex-analytics` | `analytics/` | 使用分析/遥测上报 |
| `codex-state` | `state/` | SQLite 持久化状态 |
| `codex-thread-store` | `thread-store/` | 会话线程存储 |
| `codex-secrets` | `secrets/` | 密钥/凭证管理 |
| `codex-keyring-store` | `keyring-store/` | OS Keyring 集成 |
| `codex-feedback` | `feedback/` | 用户反馈收集 |
| `codex-features` | `features/` | Feature flag / 特性开关 |
| `codex-rollout` | `rollout/` | 渐进发布控制 |
| `codex-backend-client` | `backend-client/` | 后端服务客户端 |

### 3.4 插件与扩展 Crates

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-plugin` | `plugin/` | 插件系统核心 |
| `codex-core-plugins` | `core-plugins/` | 核心内置插件 |
| `codex-core-skills` | `core-skills/` | 核心技能定义 |
| `codex-skills` | `skills/` | 技能系统 |
| `codex-hooks` | `hooks/` | Hook 系统（pre/post execution hooks） |
| `codex-instructions` | `instructions/` | 指令注入（系统提示词等） |
| `codex-connectors` | `connectors/` | 外部连接器 |
| `codex-collaboration-mode-templates` | `collaboration-mode-templates/` | 协作模式模板 |

### 3.5 工具库 Crates (`utils/`)

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-utils-absolute-path` | `utils/absolute-path/` | 绝对路径解析 |
| `codex-utils-cargo-bin` | `utils/cargo-bin/` | Cargo/Bazel 二进制路径解析 |
| `codex-utils-cache` | `utils/cache/` | 缓存工具 |
| `codex-utils-cli` | `utils/cli/` | CLI 公共参数定义 |
| `codex-utils-elapsed` | `utils/elapsed/` | 时间度量 |
| `codex-utils-fuzzy-match` | `utils/fuzzy-match/` | 模糊匹配 |
| `codex-utils-home-dir` | `utils/home-dir/` | Home 目录解析 |
| `codex-utils-image` | `utils/image/` | 图像处理 |
| `codex-utils-json-to-toml` | `utils/json-to-toml/` | JSON→TOML 转换 |
| `codex-utils-oss` | `utils/oss/` | OSS 相关工具 |
| `codex-utils-output-truncation` | `utils/output-truncation/` | 输出截断 |
| `codex-utils-path` | `utils/path-utils/` | 路径工具 |
| `codex-utils-plugins` | `utils/plugins/` | 插件辅助 |
| `codex-utils-pty` | `utils/pty/` | PTY 管理 |
| `codex-utils-readiness` | `utils/readiness/` | 服务就绪检测 |
| `codex-utils-rustls-provider` | `utils/rustls-provider/` | rustls TLS 提供者 |
| `codex-utils-sandbox-summary` | `utils/sandbox-summary/` | 沙箱摘要 |
| `codex-utils-sleep-inhibitor` | `utils/sleep-inhibator/` | 抑制系统睡眠 |
| `codex-utils-stream-parser` | `utils/stream-parser/` | 流式解析器 |
| `codex-utils-string` | `utils/string/` | 字符串工具 |
| `codex-utils-template` | `utils/template/` | 模板渲染 |

### 3.6 其他 Crates

| Crate 名 | 目录 | 职责 |
|---|---|---|
| `codex-arg0` | `arg0/` | arg0 分发（同一二进制，不同名称→不同行为） |
| `codex-ansi-escape` | `ansi-escape/` | ANSI 转义序列处理 |
| `codex-async-utils` | `async-utils/` | 异步工具库 |
| `codex-terminal-detection` | `terminal-detection/` | 终端能力检测 |
| `codex-install-context` | `install-context/` | 安装上下文 |
| `codex-network-proxy` | `network-proxy/` | 网络代理配置 |
| `codex-process-hardening` | `process-hardening/` | 进程加固 |
| `codex-stdio-to-uds` | `stdio-to-uds/` | stdio→Unix Domain Socket 桥接 |
| `codex-uds` | `uds/` | Unix Domain Socket 工具 |
| `codex-cloud-tasks` | `cloud-tasks/` | Cloud Tasks 集成 |
| `codex-cloud-requirements` | `cloud-requirements/` | 云需求检查 |
| `codex-cloud-tasks-client` | `cloud-tasks-client/` | Cloud Tasks 客户端 |
| `codex-cloud-tasks-mock-client` | `cloud-tasks-mock-client/` | Cloud Tasks 测试 Mock |
| `codex-v8-poc` | `v8-poc/` | V8 JS 引擎 POC |
| `codex-realtime-webrtc` | `realtime-webrtc/` | WebRTC 实时通信 |
| `codex-responses-api-proxy` | `responses-api-proxy/` | Responses API 代理 |
| `codex-response-debug-context` | `response-debug-context/` | 响应调试上下文 |
| `codex-linux-sandbox` | `linux-sandbox/` | Linux Landlock 沙箱二进制 |
| `codex-experimental-api-macros` | `codex-experimental-api-macros/` | 实验性 API 宏 |
| `codex-llmstudio` | `lmstudio/` | LM Studio 集成 |
| `codex-ollama` | `ollama/` | Ollama 集成 |
| `codex-chatgpt` *(隐含)* | — | ChatGPT 集成 (apply 命令) |
| `debug-client` | `debug-client/` | 调试客户端 |
| `app-server-test-client` | `app-server-test-client/` | App Server 测试客户端 |
| `test-binary-support` | `test-binary-support/` | 测试二进制支持 |

---

## 4. Crate 依赖关系图

### 4.1 核心依赖流（从入口到基础层）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             用户入口                                         │
│                                                                             │
│  codex.js (Node) ──spawn──► codex (Rust binary, arg0 dispatch)             │
│                                   │                                         │
│                    ┌──────────────┼──────────────┐                          │
│                    ▼              ▼              ▼                           │
│               codex-tui    codex-exec     codex-app-server                  │
│               (TUI 模式)    (非交互)      (JSON-RPC 服务)                    │
│                    │              │              │                           │
│                    └──────────────┼──────────────┘                          │
│                                   ▼                                         │
│                             codex-core                                       │
│                        (核心调度引擎)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 cli → 各子系统的依赖

```
codex-cli
├── codex-tui                    # TUI 交互模式
├── codex-exec                   # 非交互执行模式
├── codex-core                   # 核心逻辑
├── codex-app-server             # App Server 服务
├── codex-app-server-protocol    # API 协议类型
├── codex-protocol               # 通用协议类型
├── codex-config                 # 配置加载
├── codex-sandboxing             # 沙箱策略
├── codex-mcp / codex-mcp-server # MCP 集成
├── codex-login                  # 认证
├── codex-models-manager         # 模型管理
├── codex-model-provider         # 模型提供者
├── codex-features               # Feature flags
├── codex-state                  # 状态存储
├── codex-exec-server            # 执行服务
├── codex-execpolicy             # 执行策略
├── codex-api                    # API 调用层
├── codex-rmcp-client            # RMCP 客户端
├── codex-utils-*                # 工具库集合
└── codex-terminal-detection      # 终端检测
```

### 4.3 tui → 各子系统依赖

```
codex-tui
├── codex-app-server-client      # App Server 客户端
├── codex-app-server-protocol    # API 协议
├── codex-config                 # 配置
├── codex-protocol               # 协议类型
├── codex-otel                   # 遥测
├── codex-login                  # 认证
├── codex-models-manager         # 模型管理
├── codex-model-provider-info    # 模型信息
├── codex-exec-server            # 执行服务
├── codex-core-skills            # 核心技能
├── codex-connectors             # 连接器
├── codex-shell-command          # Shell 命令
├── codex-file-search            # 文件搜索
├── codex-git-utils              # Git 工具
├── codex-feedback               # 反馈
├── codex-state                  # 状态
├── codex-plugin                 # 插件
├── codex-realtime-webrtc        # WebRTC
├── codex-rollout                # 渐进发布
├── codex-features               # 特性开关
├── codex-cloud-requirements     # 云需求
├── codex-chatgpt                # ChatGPT 集成
├── codex-ansi-escape            # ANSI 处理
├── codex-utils-*                # 多个工具库
└── ratatui, crossterm, ...      # TUI 外部依赖
```

### 4.4 core → 各子系统依赖（最重，直接依赖 ~30 个内部 crate）

```
codex-core
├── codex-protocol               # 协议类型（最深基础）
├── codex-config                 # 配置加载
├── codex-tools                  # 内置工具定义
├── codex-mcp                    # MCP 管理
├── codex-sandboxing             # 沙箱策略
├── codex-api                    # API 调用
├── codex-login                  # 认证
├── codex-otel                   # 遥测
├── codex-analytics              # 分析上报
├── codex-model-provider         # 模型提供者
├── codex-model-provider-info    # 模型信息
├── codex-models-manager         # 模型管理
├── codex-exec-server            # 执行服务
├── codex-execpolicy             # 执行策略
├── codex-shell-command          # Shell 命令
├── codex-apply-patch            # Patch 应用
├── codex-code-mode              # Code Mode
├── codex-connectors             # 连接器
├── codex-core-plugins           # 核心插件
├── codex-core-skills            # 核心技能
├── codex-hooks                  # Hook 系统
├── codex-instructions           # 指令注入
├── codex-plugin                 # 插件系统
├── codex-feedback               # 反馈
├── codex-features               # 特性开关
├── codex-rollout                # 渐进发布
├── codex-state                  # 状态存储
├── codex-thread-store           # 线程存储
├── codex-git-utils              # Git 工具
├── codex-network-proxy          # 网络代理
├── codex-response-debug-context # 响应调试
├── codex-rmcp-client            # RMCP 客户端
├── codex-secrets                # 密钥管理
├── codex-terminal-detection     # 终端检测
├── codex-app-server-protocol    # API 协议
├── codex-utils-* (10+)          # cache, image, path, string, stream-parser, ...
└── reqwest, tokio, rmcp, ...    # 外部依赖
```

### 4.5 关键分层依赖流

```
                    ┌──────────────┐
                    │  codex-protocol  │  ← 最底层共享类型
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       codex-config   codex-sandboxing  codex-model-provider-info
              │            │
              ▼            ▼
       codex-execpolicy  codex-exec-server
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 codex-mcp  codex-tools  codex-shell-command
    │         │
    └────┬────┘
         ▼
     codex-core  ←── 最大的依赖聚合点
         │
    ┌────┼────┐
    ▼    ▼    ▼
  tui  exec  app-server
    │    │    │
    └────┼────┘
         ▼
      codex-cli  ← 顶层入口
```

### 4.6 App Server 相关独立流

```
codex-app-server-protocol (v2 API 类型 + ts-rs 生成)
├── codex-app-server           # 服务端实现
├── codex-app-server-client    # 客户端
├── codex-app-server-test-client
├── codex-exec                 # exec 模式客户端
├── codex-tui                  # TUI 客户端
├── codex-core                 # 核心使用
├── codex-config               # 配置使用
├── codex-login                # 认证使用
└── codex-mcp                  # MCP 使用
```

---

## 5. 多语言协作模式

### 5.1 总览

| 语言 | 范围 | 包管理 | 构建系统 |
|---|---|---|---|
| **Rust** | 核心引擎、TUI、exec、app-server、所有业务逻辑 | Cargo | Cargo + Bazel |
| **TypeScript/Node.js** | npm CLI 分发包装 + TypeScript SDK | pnpm | tsup |
| **Python** | Python SDK + CLI 运行时包装 | pip/hatch | hatchling |

### 5.2 Rust → TypeScript 分发桥梁

```
Rust 编译产物 (codex-rs/cli → codex 二进制)
       │
       ▼
codex-cli/bin/codex.js          # Node.js ESM 入口
  ├── 检测平台 (linux/darwin/win32 × x64/arm64)
  ├── 定位 vendor/<target>/codex/codex[.exe]  # 预编译 Rust 二进制
  │   └── 来自可选依赖 @openai/codex-{platform}
  │       (@openai/codex-linux-x64, -darwin-arm64, ...)
  └── child_process.spawn(binaryPath, argv)
      + 信号转发 (SIGINT/SIGTERM/SIGHUP)
```

**关键设计：**
- `@openai/codex` npm 包只包含 `bin/codex.js` + `vendor/` 目录
- 各平台预编译 Rust 二进制通过**可选依赖** `@openai/codex-{platform}` 分发
- `codex.js` 只做平台检测 + spawn，不包含任何业务逻辑
- 本地开发时直接从 `vendor/` 子目录查找

### 5.3 pnpm Workspace

```yaml
# pnpm-workspace.yaml
packages:
  - codex-cli             # @openai/codex (npm CLI)
  - codex-rs/responses-api-proxy/npm  # Responses API 代理的 npm 包
  - sdk/typescript        # @openai/codex-sdk (TypeScript SDK)
```

根 `package.json`（`codex-monorepo`）主要用于格式化/文档脚本，不包含业务代码。

### 5.4 TypeScript SDK (`sdk/typescript/`)

- **包名：** `@openai/codex-sdk`
- **功能：** 与 Codex App Server 通信的 TypeScript 客户端库
- **构建：** `tsup` → ESM 输出
- **依赖：** `@modelcontextprotocol/sdk` (MCP 支持)
- **不直接调用 Rust 二进制：** 通过 JSON-RPC/WebSocket 与 `codex-app-server` 通信

### 5.5 Python SDK (`sdk/python/`)

- **包名：** `codex-app-server-sdk`
- **功能：** Python SDK for Codex app-server v2 (JSON-RPC)
- **依赖：** `pydantic>=2.12`
- **类型生成：** 基于 app-server-protocol 的 ts-rs 生成类型，手动在 Python 中对齐

### 5.6 Python Runtime (`sdk/python-runtime/`)

- **包名：** `codex-cli-bin`
- **功能：** 将预编译 Rust 二进制打包为 Python 包（类似 Node.js 的 `@openai/codex-{platform}`）
- **构建：** 自定义 hatch hook (`hatch_build.py`) 在构建时复制二进制到 wheel

### 5.7 脚本/Shell

`scripts/` 目录包含：
- `install/` — 安装脚本
- `stage_npm_packages.py` — npm 包暂存（CI 用）
- `start-codex-exec.sh` / `run_tui_with_exec_server.sh` — 开发调试脚本
- `check_blob_size.py` — 二进制大小检查
- `check-module-bazel-lock.sh` — Bazel 锁文件检查
- `asciicheck.py` — ASCII 字符检查
- `mock_responses_websocket_server.py` — Mock WebSocket 服务

---

## 6. 主要入口点

### 6.1 Rust 二进制入口

| 二进制名 | Crate | 路径 | 用途 |
|---|---|---|---|
| `codex` | `codex-cli` | `cli/src/main.rs` | **主入口**。arg0 分发：`codex` → TUI, `codex-exec` → exec, `codex-app-server` → app-server |
| `codex-tui` | `codex-tui` | `tui/src/main.rs` | 独立 TUI 入口（通常通过 arg0 分发调用） |
| `codex-exec` | `codex-exec` | `exec/src/main.rs` | 非交互 exec 模式（也用作 `codex-linux-sandbox` 的 arg0 别名） |
| `codex-app-server` | `codex-app-server` | `app-server/src/main.rs` | JSON-RPC 服务器（stdio/ws） |
| `codex-mcp-server` | `codex-mcp-server` | `mcp-server/src/main.rs` | 独立 MCP Server |
| `codex-linux-sandbox` | — | (内嵌于 `codex-exec`) | Linux Landlock+Seccomp 沙箱执行器 |
| `codex-write-config-schema` | `codex-core` | `core/src/bin/config_schema.rs` | 输出 config.schema.json |

### 6.2 arg0 分发机制

所有二进制共享"arg0 dispatch"模式：
- 同一个 `codex` 二进制根据调用名称（`argv[0]`）分发到不同子命令
- `codex arg0` crate 实现此逻辑
- 典型：`codex` → TUI 入口，`codex-exec` → exec 入口，`codex-app-server` → server 入口
- 这减少了需要分发和安装的二进制数量

### 6.3 Node.js 入口

- **脚本：** `codex-cli/bin/codex.js`
- **调用方式：** `npx @openai/codex` 或全局安装后 `codex`
- **行为：** 检测平台 → 定位预编译 Rust 二进制 → spawn 并等待

### 6.4 App Server 协议入口

- **Transport：** `stdio://`（默认）或 `ws://IP:PORT`
- **协议：** JSON-RPC over stdio/WebSocket
- **SDK 连接：** TypeScript SDK / Python SDK 通过此协议与 server 交互

---

## 7. 构建系统

| 系统 | 用途 |
|---|---|
| **Cargo** | 主要 Rust 构建系统，workspace 管理 |
| **Bazel** | CI/发布构建（`MODULE.bazel`, `BUILD.bazel`），确保可复现构建 |
| **pnpm** | JS/TS monorepo 包管理 |
| **Just** | 任务运行器（`justfile`），统一开发命令入口 |
| **Nix** | `flake.nix` 提供可复现开发环境 |

关键 Just 命令：
- `just fmt` — Rust 格式化
- `just fix -p <project>` — Clippy 修复
- `just test` — 运行测试
- `just bazel-lock-update` — 更新 Bazel 锁文件
- `just write-config-schema` — 生成配置 schema
- `just write-app-server-schema` — 生成 API schema

---

## 8. 架构特征总结

1. **巨型 Rust workspace**：97 crate 的超大 workspace，核心逻辑高度集中在 `codex-core`（AGENTS.md 明确呼吁"抵制向 core 添加代码"）
2. **深度模块化**：大量 `utils/` 工具库避免代码重复，但增加了依赖图复杂度
3. **多模式入口**：arg0 dispatch + TUI/exec/server 三种运行模式共享核心逻辑
4. **Rust→npm 桥梁**：Node.js 包装层仅做平台检测+进程代理，业务逻辑全在 Rust
5. **JSON-RPC 外部接口**：app-server-protocol 定义 v2 API，ts-rs 生成 TypeScript 类型，Python SDK 手动对齐
6. **沙箱优先安全**：三平台沙箱（Seatbelt/Landlock+Seccomp/Windows）作为核心安全边界
7. **MCP 生态集成**：通过 rmcp crate 支持 MCP 协议，可扩展外部工具
8. **可观测性完备**：OpenTelemetry + Sentry + 自定义 analytics 组成完整遥测体系