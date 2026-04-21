---
title: "Step 9: SDK 与 CLI 分发"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/09-sdk-cli-distribution/
---
# OpenAI Codex CLI — SDK 与 CLI 分发架构深度分析

## 1. 分发架构总览

```
                          ┌─────────────────────────────────────────────┐
                          │            GitHub Monorepo (codex)           │
                          └─────────────────┬───────────────────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
            ┌───────▼──────┐      ┌────────▼────────┐     ┌───────▼────────┐
            │  codex-rs/   │      │   codex-cli/     │     │    sdk/        │
            │  (Rust 核心) │      │  (npm 分发包)    │     │ (SDK 层)      │
            └───────┬──────┘      └────────┬─────────┘     └───────┬────────┘
                    │                      │                       │
            ┌───────▼──────┐      ┌───────▼──────────┐   ┌────────▼────────┐
            │ cargo build   │      │  bin/codex.js    │   │ typescript/     │
            │ → codex 二进制│      │  (平台路由)      │   │   → @openai/    │
            │               │      │                  │   │     codex-sdk   │
            └───────┬──────┘      └───────┬──────────┘   └────────┬────────┘
                    │                      │                        │
                    │              ┌───────▼──────────┐    ┌───────▼────────┐
                    │              │ vendor/<target>/ │    │ exec 找到      │
                    │              │   codex/codex    │    │ codex 二进制   │
                    │              │   path/rg        │    │ → spawn exec   │
                    │              └───────▲──────────┘    └───────▲────────┘
                    │                      │                        │
                    └──────────────────────┼────────────────────────┘
                                           │
                              ┌─────────────▼──────────────┐
                              │ 6 个平台特定 npm 包          │
                              │ @openai/codex-linux-x64    │
                              │ @openai/codex-linux-arm64  │
                              │ @openai/codex-darwin-x64   │
                              │ @openai/codex-darwin-arm64 │
                              │ @openai/codex-win32-x64    │
                              │ @openai/codex-win32-arm64  │
                              └────────────────────────────┘
```

### 核心设计理念

Codex 项目采用 **Rust 编译原生二进制 + 轻量 JS/Python 封装层** 的分发策略。Rust 代码编译为各平台的静态链接二进制（musl/gnu/msvc），通过 npm optional dependencies 和 Python wheel 实现跨平台分发。用户安装 `@openai/codex` 时，npm 自动拉取对应平台的二进制包，JS 入口脚本负责路由到正确的二进制并 spawn 执行。

---

## 2. CLI 分发包装：npm 包体系

### 2.1 包结构

| 包名 | 类型 | 内容 | 发布版本格式 |
|------|------|------|-------------|
| `@openai/codex` | 主包 | `bin/codex.js` 入口 | `x.y.z` |
| `@openai/codex-linux-x64` | 平台子包 | `vendor/x86_64-unknown-linux-musl/` | `x.y.z-linux-x64` |
| `@openai/codex-linux-arm64` | 平台子包 | `vendor/aarch64-unknown-linux-musl/` | `x.y.z-linux-arm64` |
| `@openai/codex-darwin-x64` | 平台子包 | `vendor/x86_64-apple-darwin/` | `x.y.z-darwin-x64` |
| `@openai/codex-darwin-arm64` | 平台子包 | `vendor/aarch64-apple-darwin/` | `x.y.z-darwin-arm64` |
| `@openai/codex-win32-x64` | 平台子包 | `vendor/x86_64-pc-windows-msvc/` | `x.y.z-win32-x64` |
| `@openai/codex-win32-arm64` | 平台子包 | `vendor/aarch64-pc-windows-msvc/` | `x.y.z-win32-arm64` |
| `@openai/codex-sdk` | TS SDK | `dist/` (ESM) | `x.y.z` |

### 2.2 bin/codex.js 入口脚本详解

**文件**: `codex-cli/bin/codex.js` (229 行)

这是整个 CLI 分发的核心路由层，流程如下：

```
1. 检测平台: process.platform + process.arch → targetTriple
   linux/x64       → x86_64-unknown-linux-musl
   linux/arm64     → aarch64-unknown-linux-musl
   darwin/x64      → x86_64-apple-darwin
   darwin/arm64    → aarch64-apple-darwin
   win32/x64       → x86_64-pc-windows-msvc
   win32/arm64     → aarch64-pc-windows-msvc

2. 定位二进制:
   a. 尝试 require.resolve("@openai/codex-<platform>/package.json")
      → 找到平台子包 vendor/ 目录
   b. 若失败，回退到本地 vendor/ 目录 (开发模式)
   c. 均失败 → 抛出错误，提示重新安装

3. 构建执行环境:
   - 更新 PATH: 加入 vendor/<target>/path/ (含 rg)
   - 设置 CODEX_MANAGED_BY_NPM/BUN 环境变量

4. spawn 异步执行 Rust 二进制:
   - stdio: "inherit" (直通)
   - 转发 SIGINT/SIGTERM/SIGHUP 信号
   - 镜像子进程退出状态
```

关键设计决策：
- **异步 spawn**（非 `spawnSync`）：让 Node 响应 Ctrl-C 等信号，转发给子进程
- **信号转发**：注册 SIGINT/SIGTERM/SIGHUP 处理器，确保父子进程同步退出
- **退出码镜像**：子进程因信号退出时，父进程使用 `process.kill(pid, signal)` 重发信号，确保 shell 获得正确的退出码（128+n）

### 2.3 平台子包的 vendor 目录结构

```
vendor/
├── x86_64-unknown-linux-musl/
│   ├── codex/
│   │   └── codex              # Rust 主二进制
│   └── path/
│       └── rg                 # ripgrep
├── aarch64-apple-darwin/
│   ├── codex/
│   │   └── codex
│   └── path/
│       └── rg
├── x86_64-pc-windows-msvc/
│   ├── codex/
│   │   ├── codex.exe
│   │   ├── codex-windows-sandbox-setup.exe
│   │   └── codex-command-runner.exe
│   └── path/
│       └── rg.exe
└── ...
```

每个平台包含：
- `codex/`: Rust 编译的 `codex` 二进制（+ Windows 特有的 sandbox/command-runner 辅助二进制）
- `path/`: ripgrep (`rg`) 二进制，用于 Codex 的文件搜索功能

### 2.4 npm 包安装流程

```
用户执行 npm install -g @openai/codex
    │
    ▼
npm 解析 @openai/codex 的 package.json
    │
    ├─ 下载主包 (bin/codex.js)
    │
    └─ 解析 optionalDependencies:
         @openai/codex-linux-x64:  "npm:@openai/codex@x.y.z-linux-x64"
         @openai/codex-darwin-arm64: "npm:@openai/codex@x.y.z-darwin-arm64"
         ... (6 个平台)
            │
            ▼
       npm 根据当前 os/cpu 匹配平台包
       (平台子包的 package.json 含 os/cpu 字段过滤)
            │
            ▼
       仅下载匹配当前平台的子包
       → 内含 vendor/<target>/codex/codex 二进制
```

**关键机制**：平台子包使用 `os` 和 `cpu` 字段限制安装，确保只下载匹配平台的二进制：

```json
{
  "name": "@openai/codex",
  "version": "0.1.0-linux-x64",
  "os": ["linux"],
  "cpu": ["x64"],
  "files": ["vendor"]
}
```

### 2.5 Docker 容器构建

**文件**: `codex-cli/Dockerfile`

```dockerfile
FROM node:24-slim

# 安装开发工具 (git, curl, jq, rg, zsh 等)
RUN apt-get update && apt-get install -y ...

# 以非 root 用户运行
USER node

# 安装预构建的 codex npm 包
COPY dist/codex.tgz codex.tgz
RUN npm install -g codex.tgz

# 容器内禁用沙箱 (已有容器隔离)
ENV CODEX_UNSAFE_ALLOW_NO_SANDBOX=1

# 防火墙脚本
COPY scripts/init_firewall.sh /usr/local/bin/
```

设计要点：
- 基于 `node:24-slim` 最小镜像
- 安装预打包的 `codex.tgz`（非从源码构建）
- 设置 `CODEX_UNSAFE_ALLOW_NO_SANDBOX=1` 因为容器自身已提供隔离
- 包含防火墙初始化脚本

---

## 3. Rust CLI 入口：子命令分发体系

### 3.1 架构概览

**文件**: `codex-rs/cli/src/main.rs`

CLI 使用 `clap` 的 derive 模式构建多层子命令系统：

```
codex [OPTIONS] [PROMPT]          → 交互式 TUI (默认)
codex exec [OPTIONS] [CMD]        → 非交互式执行
codex review [OPTIONS]            → 代码审查 (别名到 exec)
codex login [子命令]              → 认证管理
codex logout                      → 登出
codex mcp [子命令]                → MCP 服务器管理
codex mcp-server                  → 作为 MCP 服务器运行 (stdio)
codex plugin marketplace [子命令] → 插件市场管理
codex app-server [子命令]         → 应用服务器
codex app [PATH]                  → 桌面应用 (仅 macOS/Windows)
codex completion [SHELL]         → Shell 补全
codex sandbox [子命令]           → 沙箱工具
codex debug [子命令]             → 调试工具
codex apply                      → 应用最新 diff
codex resume [SESSION_ID]        → 恢复会话
codex fork [SESSION_ID]          → 分叉会话
codex cloud [子命令]             → Codex Cloud 任务
codex responses                  → 内部: 原始 Responses API
codex features [子命令]          → Feature flag 管理
codex exec-server                → 独立 exec-server 服务
```

### 3.2 默认行为：交互式 TUI

当无子命令时，`cli_main()` 直接调用 `run_interactive_tui()`，启动 `codex-tui` 的 TUI 应用。所有 `TuiCli` 的参数（model, sandbox, approval-policy 等）直接传入 TUI 模块。

### 3.3 子命令与核心 crate 的关系

| 子命令 | 委托到 | 通信方式 |
|--------|--------|---------|
| (默认) | `codex-tui` | 直接调用 |
| `exec` | `codex-exec` | 直接调用 |
| `review` | `codex-exec` | 转换为 `exec --command review` |
| `app-server` | `codex-app-server` | WebSocket/stdio 传输 |
| `mcp-server` | `codex-mcp-server` | stdio MCP 协议 |
| `sandbox` | `codex-sandboxing` | 平台特定沙箱 |
| `login/logout` | `codex-login`/`codex-cli` | 本地文件/浏览器 |
| `mcp` | `codex-mcp`/`codex-config` | 配置文件读写 |

### 3.4 远程模式 (`--remote`)

CLI 支持 `--remote ws://host:port` 参数，将 TUI 连接到远程 app-server 实例，而非本地启动。此模式仅适用于交互式命令（exec/resume/fork），对其他子命令会显式拒绝。

### 3.5 Feature Flag 系统

```rust
struct FeatureToggles {
    enable: Vec<String>,   // --enable <FEATURE>
    disable: Vec<String>,  // --disable <FEATURE>
}
```

Feature flag 通过 `features.<name>=true/false` 映射为 config override，贯穿所有子命令。

---

## 4. TypeScript SDK

**路径**: `sdk/typescript/`
**包名**: `@openai/codex-sdk`

### 4.1 构建配置

- **构建工具**: tsup (ESM only)
- **目标**: Node.js 18+
- **输出**: `dist/index.js` + `dist/index.d.ts`
- **TypeScript**: strict 模式, ES2022 target

### 4.2 核心架构

```
                    Codex (入口类)
                     │
            ┌────────┼────────┐
            │        │        │
      startThread  resumeThread  CodexOptions
            │        │
            ▼        ▼
         Thread (会话线程)
         │
    ┌────┼────────┐
    │    │        │
   run  runStreamed  resume
    │    │
    ▼    ▼
  Turn  AsyncGenerator<ThreadEvent>
```

### 4.3 与 Rust 二进制的交互方式

**TypeScript SDK 通过 `codex exec --experimental-json` 子命令与 Rust 二进制交互**，而非 JSON-RPC。

具体流程：

```
CodexExec.findCodexPath()
    → 通过 require.resolve 定位 @openai/codex-<platform> 包
    → 解析 vendor/<target>/codex/codex 二进制路径

Thread.run() / runStreamed()
    → CodexExec.run(args)
        → spawn(codex_path, ["exec", "--experimental-json", ...])
        → stdin 写入用户 prompt
        → stdout 逐行读取 JSONL 事件流
        → 解析为 ThreadEvent
```

**exec 子命令参数映射**：

| SDK 选项 | CLI 参数 |
|-----------|---------|
| `model` | `--model <model>` |
| `sandboxMode` | `--sandbox <mode>` |
| `workingDirectory` | `--cd <dir>` |
| `additionalDirectories` | `--add-dir <dir>` (repeatable) |
| `outputSchema` | `--output-schema <file>` (临时 JSON 文件) |
| `modelReasoningEffort` | `--config model_reasoning_effort="..."` |
| `networkAccessEnabled` | `--config sandbox_workspace_write.network_access=...` |
| `webSearchMode` | `--config web_search="..."` |
| `approvalPolicy` | `--config approval_policy="..."` |
| `threadId` | `resume <threadId>` (子命令) |
| `apiKey` | 环境变量 `CODEX_API_KEY` |
| `config` | 多个 `--config key=value` (嵌套展平为 TOML) |

### 4.4 事件流协议

`codex exec --experimental-json` 在 stdout 输出 JSONL 格式的事件流：

```typescript
type ThreadEvent =
  | ThreadStartedEvent    // { type: "thread.started", thread_id: string }
  | TurnStartedEvent      // { type: "turn.started" }
  | TurnCompletedEvent    // { type: "turn.completed", usage: Usage }
  | TurnFailedEvent       // { type: "turn.failed", error: ThreadError }
  | ItemStartedEvent      // { type: "item.started", item: ThreadItem }
  | ItemUpdatedEvent      // { type: "item.updated", item: ThreadItem }
  | ItemCompletedEvent    // { type: "item.completed", item: ThreadItem }
  | ThreadErrorEvent      // { type: "error", message: string }
```

### 4.5 ThreadItem 类型

```typescript
type ThreadItem =
  | AgentMessageItem      // { type: "agent_message", text: string }
  | ReasoningItem         // { type: "reasoning", text: string }
  | CommandExecutionItem  // { type: "command_execution", command, aggregated_output, exit_code?, status }
  | FileChangeItem        // { type: "file_change", changes: FileUpdateChange[], status }
  | McpToolCallItem       // { type: "mcp_tool_call", server, tool, arguments, result?, error?, status }
  | WebSearchItem         // { type: "web_search", query }
  | TodoListItem          // { type: "todo_list", items: TodoItem[] }
  | ErrorItem             // { type: "error", message }
```

---

## 5. Python SDK

### 5.1 双包架构

Python SDK 分为两个独立包：

| 包名 | PyPI 名 | 角色 |
|------|---------|------|
| `sdk/python/` | `codex-app-server-sdk` | 纯 Python SDK，提供 `Codex` 类和 JSON-RPC v2 客户端 |
| `sdk/python-runtime/` | `codex-cli-bin` | 平台特定的 Python wheel，内含 codex Rust 二进制 |

**关键设计**：SDK 依赖运行时包获取二进制，但 `codex-cli-bin` 是 wheel-only（故意不发布 sdist），每个平台有独立的 wheel。

### 5.2 Python SDK 与 Rust 的交互方式

**Python SDK 使用 `codex app-server` 的 JSON-RPC v2 over stdio 协议**，而非 `exec` 模式。

```python
# sdk/python/src/codex_app_server/client.py
class AppServerClient:
    def start(self):
        codex_bin = _resolve_codex_bin(self.config)
        # → defaults to codex_cli_bin.bundled_codex_path()
        # → 或 AppServerConfig.codex_bin 显式指定

        self._proc = subprocess.Popen(
            [str(codex_bin), "app-server", "--listen", "stdio://", ...],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            ...
        )
        # 通过 stdin/stdout 进行 JSON-RPC 2.0 通信
```

通信协议：

```
Python SDK                    Rust app-server
    │                              │
    │─── initialize ──────────────▶│
    │◀── InitializeResponse ──────│
    │                              │
    │─── thread/start ───────────▶│
    │◀── ThreadStartResponse ─────│
    │                              │
    │─── turn/start ─────────────▶│
    │◀── TurnStartResponse ────────│
    │◀── TurnCompletedNotif ──────│  (通知)
    │                              │
    │─── turn/interrupt ─────────▶│  (可选)
    │                              │
```

### 5.3 codex-cli-bin 运行时包

**文件**: `sdk/python-runtime/src/codex_cli_bin/__init__.py`

```python
def bundled_codex_path() -> Path:
    exe = "codex.exe" if os.name == "nt" else "codex"
    path = Path(__file__).resolve().parent / "bin" / exe
    if not path.is_file():
        raise FileNotFoundError(...)
    return path
```

运行时包在构建时将 codex 二进制放入 `src/codex_cli_bin/bin/`，通过 `hatch_build.py` 自定义 hook 标记为非纯 Python wheel（`pure_python = False`, `infer_tag = True`），使 hatchling 生成平台特定的 wheel 标签。

### 5.4 TS SDK vs Python SDK 交互协议对比

| 维度 | TypeScript SDK | Python SDK |
|------|---------------|------------|
| 传输协议 | `codex exec --experimental-json` | `codex app-server --listen stdio://` |
| 数据格式 | JSONL (stdout 逐行) | JSON-RPC 2.0 (双向) |
| 通信模型 | 单向流 (stdin prompt → stdout events) | 双向请求/响应 + 通知 |
| 流式支持 | `runStreamed()` 返回 AsyncGenerator | 通过 notification callback |
| 会话恢复 | 通过 `resume <threadId>` | 通过 `thread/resume` RPC |
| 中断/转向 | 不支持 | `turn/steer` RPC |
| 二进制定位 | npm require.resolve | codex-cli-bin 或显式路径 |

---

## 6. 跨平台构建与发布流程

### 6.1 构建矩阵

**文件**: `.github/workflows/rust-release.yml`

| Runner | Target | 产物 |
|--------|--------|------|
| `macos-15-xlarge` | `aarch64-apple-darwin` | codex + dmg |
| `macos-15-xlarge` | `x86_64-apple-darwin` | codex + dmg |
| `ubuntu-24.04` | `x86_64-unknown-linux-musl` | codex (静态链接) |
| `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | codex (动态链接) |
| `ubuntu-24.04-arm` | `aarch64-unknown-linux-musl` | codex (静态链接) |
| `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | codex (动态链接) |
| Windows (独立工作流) | `x86_64-pc-windows-msvc` | codex.exe + sandbox 辅助 |
| Windows (独立工作流) | `aarch64-pc-windows-msvc` | codex.exe + sandbox 辅助 |

### 6.2 触发机制

```bash
git tag -a rust-v0.1.0 -m "Release 0.1.0"
git push origin rust-v0.1.0
```

工作流由 `rust-v*.*.*` 格式的 tag 触发。

### 6.3 构建产物处理

```
Rust 编译 (cargo build --target <target> --release --bin codex --bin codex-responses-api-proxy)
    │
    ├─ macOS: Apple 代码签名 + 公证 + DMG 打包
    ├─ Linux: Cosign 签名 + sigstore
    └─ Windows: 独立工作流处理
    │
    ▼
Stage 产物到 dist/<target>/
    │
    ▼
压缩: zstd -19 (主) + tar.gz (兼容)
    │
    ▼
上传为 GitHub Actions artifact
```

### 6.4 npm 包暂存与发布

**核心脚本**: `scripts/stage_npm_packages.py`
**底层脚本**: `codex-cli/scripts/build_npm_package.py` + `codex-cli/scripts/install_native_deps.py`

```
stage_npm_packages.py
    │
    ├─ 1. 从 GitHub Actions 下载原生二进制 (gh run download)
    │     → 通过 install_native_deps.py
    │     → 下载 codex, rg, codex-windows-sandbox-setup, codex-command-runner
    │     → 解压 .zst 归档到临时 vendor/ 目录
    │
    ├─ 2. 展开包列表:
    │     "codex" → ["codex", "codex-linux-x64", ..., "codex-darwin-arm64", ...]
    │
    ├─ 3. 对每个包调用 build_npm_package.py:
    │     ├─ codex (主包): 拷贝 bin/codex.js, 设置 optionalDependencies
    │     ├─ 平台子包: 生成含 os/cpu 限制的 package.json, 拷贝 vendor/
    │     ├─ codex-responses-api-proxy: 拷贝 bin/codex-responses-api-proxy.js + vendor/
    │     └─ codex-sdk: pnpm build + 拷贝 dist/
    │
    └─ 4. npm pack → .tgz 输出到 dist/npm/
```

### 6.5 发布到 npm

```yaml
# rust-release.yml → publish-npm job
- 使用 OIDC (npm trusted publishing) 认证
- Node 24 (npm >= 11.5.1)
- 从 GitHub Release 下载 .tgz
- 按文件名模式分类:
    codex-npm-<version>.tgz              → npm publish (latest/alpha tag)
    codex-npm-linux-x64-<version>.tgz    → npm publish --tag linux-x64
    codex-npm-darwin-arm64-<version>.tgz → npm publish --tag darwin-arm64
    codex-responses-api-proxy-npm-<version>.tgz → npm publish
    codex-sdk-npm-<version>.tgz          → npm publish
```

### 6.6 其他发布目标

| 目标 | 触发条件 | 方式 |
|------|---------|------|
| GitHub Release | 每个 rust-v tag | softprops/action-gh-release |
| DotSlash 发布 | 每个 tag | facebook/dotslash-publish-release |
| WinGet | 仅稳定版 (无 `-` 后缀) | vedantmgoyal9/winget-releaser |
| developers.openai.com | 仅稳定版 | Vercel deploy hook |
| latest-alpha-cli 分支 | 所有版本 | 更新分支引用到当前 SHA |

---

## 7. 项目根配置与 Monorepo 管理

### 7.1 pnpm Workspace

**文件**: `pnpm-workspace.yaml`

```yaml
packages:
  - codex-cli
  - codex-rs/responses-api-proxy/npm
  - sdk/typescript
```

workspace 仅包含 3 个 JavaScript/TypeScript 包。Rust 部分通过 Cargo workspace 管理，Python SDK 独立管理。

### 7.2 根 package.json

- **名称**: `codex-monorepo`（private）
- **引擎**: Node >= 22, pnpm >= 10.29.3
- **用途**: 仓库级的格式化脚本 (prettier) 和依赖版本锁定 (resolutions/overrides)
- **安全**: 严格模式（`blockExoticSubdeps`, `strictDepBuilds`, `minimumReleaseAge: 10080`）

---

## 8. ripgrep (rg) 的分发

Codex CLI 捆绑 ripgrep 二进制用于文件搜索功能，分发方式特殊：

1. **DotSlash manifest**: `codex-cli/bin/rg` 是一个 DotSlash 清单文件，声明了各平台的 rg 下载 URL、哈希、格式
2. **install_native_deps.py** 在构建时解析 manifest，并行下载各平台 rg 并解压到 `vendor/<target>/path/`
3. **codex.js** 在运行时将 `vendor/<target>/path/` 加入 PATH 环境变量
4. 支持 zstd、tar.gz、zip 三种归档格式的自动解压

---

## 9. 跨平台兼容性策略总结

### 9.1 二进制层

| 平台 | ABI | 沙箱机制 | 特殊处理 |
|------|-----|---------|---------|
| macOS arm64/x64 | Mach-O | Seatbelt (sandbox-exec) | Apple 代码签名 + 公证 |
| Linux x64/arm64 | ELF (musl 静态 + gnu 动态) | bubblewrap (Landlock) | Cosign 签名 |
| Windows x64/arm64 | PE (MSVC) | Restricted token | sandbox-setup.exe + command-runner.exe |

### 9.2 分发层

- **npm**: 平台子包使用 `optionalDependencies` + `os`/`cpu` 字段过滤，版本后缀区分平台 (`x.y.z-linux-x64`)
- **Python**: wheel-only 运行时包，hatch 自定义 hook 设置平台标签
- **Docker**: 预打包 tgz 安装，禁用沙箱

### 9.3 回退与容错

- **codex.js**: 平台子包安装失败时回退到本地 `vendor/` 目录
- **Python SDK**: `AppServerConfig.codex_bin` 显式覆盖
- **TS SDK**: `CodexOptions.codexPathOverride` 显式覆盖
- **安装建议**: 失败时检测包管理器 (npm/bun)，提供对应的重装命令

### 9.4 信号处理

- Node.js 入口脚本注册 SIGINT/SIGTERM/SIGHUP 处理器
- 将信号转发给 Rust 子进程
- 子进程退出时代码/信号镜像回父进程，确保 CI/CD 管道获得正确的退出状态