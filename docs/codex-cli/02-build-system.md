---
title: "Step 2: 构建系统与工具链"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/02-build-system/
---
# OpenAI Codex CLI — 构建系统与工具链分析

> 分析日期：2026-04-21
> 项目路径：`/Users/xiaozhongcheng/data/xiaozhongcheng2022/code/codex`

---

## 目录

1. [Cargo Workspace 配置](#1-cargo-workspace-配置)
2. [Justfile 命令体系](#2-justfile-命令体系)
3. [Bazel 构建配置](#3-bazel-构建配置)
4. [CI/CD 流程](#4-cicd-流程)
5. [编辑器/IDE 配置](#5-编辑器ide-配置)
6. [总结与架构图](#6-总结与架构图)

---

## 1. Cargo Workspace 配置

File: `codex-rs/Cargo.toml`

### 1.1 Workspace Members — 97 个 Crate

项目采用 Cargo workspace 管理 **97 个 crate**，按功能分类如下：

| 分类 | Crate 列表 | 数量 |
|------|-----------|------|
| **核心** | `core`, `cli`, `protocol`, `config`, `exec`, `exec-server`, `tui`, `tools` | 8 |
| **App Server** | `app-server`, `app-server-client`, `app-server-protocol`, `app-server-test-client` | 4 |
| **后端/模型** | `backend-client`, `model-provider`, `model-provider-info`, `models-manager`, `codex-backend-openapi-models`, `lmstudio`, `ollama` | 7 |
| **MCP** | `codex-mcp`, `mcp-server`, `rmcp-client` | 3 |
| **沙箱** | `sandboxing`, `linux-sandbox`, `process-hardening` | 3 |
| **网络/WebRTC** | `network-proxy`, `realtime-webrtc`, `responses-api-proxy`, `stdio-to-uds`, `uds` | 5 |
| **认证/安全** | `login`, `keyring-store`, `secrets`, `shell-escalation` | 4 |
| **插件/技能** | `plugin`, `core-plugins`, `core-skills`, `skills`, `hooks`, `instructions`, `connectors`, `feedback` | 8 |
| **云功能** | `cloud-requirements`, `cloud-tasks`, `cloud-tasks-client`, `cloud-tasks-mock-client`, `rollout`, `codex-api`, `codex-client` | 7 |
| **执行策略** | `execpolicy`, `execpolicy-legacy`, `shell-command`, `code-mode` | 4 |
| **特性/分析** | `features`, `analytics`, `otel` | 3 |
| **模板/V8** | `collaboration-mode-templates`, `v8-poc`, `codex-experimental-api-macros` | 3 |
| **调试** | `debug-client`, `response-debug-context` | 2 |
| **通用工具 (utils/)** | `absolute-path`, `cargo-bin`, `cache`, `image`, `json-to-toml`, `home-dir`, `pty`, `readiness`, `rustls-provider`, `string`, `cli`, `elapsed`, `sandbox-summary`, `sleep-inhibitor`, `approval-presets`, `oss`, `output-truncation`, `path-utils`, `plugins`, `fuzzy-match`, `stream-parser`, `template` | 22 |
| **其他** | `ansi-escape`, `async-utils`, `apply-patch`, `arg0`, `file-search`, `install-context`, `terminal-detection`, `test-binary-support`, `state`, `thread-store`, `git-utils`, `codex-client` | 12 |

- **Resolver**: `2` (V2 resolver，确保 feature 统一解析)
- **命名约定**: 所有 crate 名以 `codex-` 为前缀（如 `codex-core`, `codex-tui`），utils 子目录下的 crate 为 `codex-utils-*`

### 1.2 workspace.package — 统一版本管理

```toml
[workspace.package]
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"
```

- **版本 0.0.0**: workspace 级别占位，实际版本在发布时由 tag 决定（通过 CI 校验 tag 与 Cargo.toml 版本一致性）
- **Edition 2024**: 采用 Rust 2024 edition，新 crate 通过 `cargo new -w` 自动继承
- **License**: 统一 Apache-2.0

### 1.3 workspace.dependencies — 统一外部依赖版本

项目维护了 **~170 个外部依赖** 的统一版本，关键类别：

| 类别 | 代表性依赖 | 版本 |
|------|-----------|------|
| 异步运行时 | `tokio`, `tokio-stream`, `tokio-util`, `futures` | 1.x / 0.3 |
| Web 框架 | `axum`, `reqwest`, `http` | 0.8 / 0.12 / 1.3 |
| 序列化 | `serde`, `serde_json`, `toml`, `toml_edit`, `schemars` | 1.x |
| TUI | `ratatui`, `crossterm`, `ansi-to-tui` | 0.29 / 0.28 |
| 加密/签名 | `ed25519-dalek`, `rustls`, `crypto_box`, `age` | 各自最新 |
| 数据库 | `sqlx` (sqlite) | 0.8.6 |
| 可观测性 | `tracing`, `opentelemetry`, `sentry` | 0.1 / 0.31 / 0.46 |
| 进程沙箱 | `landlock`, `seccompiler` | 0.4.4 / 0.5.0 |
| 测试 | `insta`, `pretty_assertions`, `wiremock`, `assert_cmd` | 1.46 / 1.4 / 0.6 / 2 |
| V8 引擎 | `v8` | =146.4.0 |
| TypeScript 互操作 | `ts-rs` | 11 |

**特殊依赖**:
- `nucleo`: 来自 helix-editor 的 git 仓库 (rev `4253de9`)
- `runfiles`: 来自 `dzbarsky/rules_rust` fork (rev `b56cbaa`)

### 1.4 Profile 配置

| Profile | 用途 | 关键参数 |
|---------|------|---------|
| `dev` | 默认开发 | (Cargo 默认) |
| `dev-small` | CI 测试/减小体积 | `inherits = "dev"`, `opt-level = 0`, `debug = 0`, `strip = true` |
| `release` | 正式发布 | `lto = "fat"`, `strip = "symbols"`, `codegen-units = 1`, `split-debuginfo = "off"` |
| `ci-test` | CI 测试 | `inherits = "test"`, `opt-level = 0`, `debug = 1`（减小调试符号体积）|

**release profile 的优化策略**:
- **LTO fat**: 跨 crate 全局优化，牺牲编译时间换取最小二进制体积和最佳运行时性能
- **codegen-units = 1**: 单 codegen unit 禁止并行代码生成，允许 LLVM 全局优化
- **strip = "symbols"**: 去除符号表，因为二进制会打包进 TypeScript CLI
- 注释引用 issue #1411 解释 codegen-units=1 的原因

### 1.5 patch.crates-io — 四个 Fork

| 依赖 | Fork 来源 | rev | 原因分析 |
|------|----------|-----|---------|
| `crossterm` | `nornagon/crossterm` | `87db8bf` | 终端交互相关定制，可能修复了上游未合并的 bug 或添加了项目需要的特性 |
| `ratatui` | `nornagon/ratatui` | `9b2ad12` | TUI 框架定制，与 crossterm fork 配合工作，可能包含针对 Codex TUI 的特定修复 |
| `tokio-tungstenite` | `openai-oss-forks/tokio-tungstenite` | `132f5b3` | WebSocket 连接库，OpenAI 官方 fork，可能增加了代理/认证支持 |
| `tungstenite` | `openai-oss-forks/tungstenite-rs` | `9200079` | tokio-tungstenite 的底层依赖，配套 fork |

`crossterm` 和 `ratatui` 的 fork 来自同一维护者 `nornagon`，暗示这两个 fork 之间有协调的修改。`tokio-tungstenite` 和 `tungstenite` 是 OpenAI 官方 fork，二者配套使用。

还配置了 `patch."ssh://git@github.com/openai-oss-forks/tungstenite-rs.git"` 重复引用 tungstenite fork，确保 SSH 和 HTTPS 两种协议都能解析到同一 fork。

### 1.6 Lint 配置 — 严格的 Clippy 规则

项目配置了 **30 条 deny 级别的 clippy 规则**，所有规则在 Cargo workspace 和 Bazel clippy 中同步生效：

| 类别 | 规则 |
|------|------|
| **错误处理** | `unwrap_used`, `expect_used`, `manual_ok_or` |
| **代码简化** | `manual_clamp`, `manual_filter`, `manual_find`, `manual_flatten`, `manual_map`, `manual_memcpy`, `manual_non_exhaustive`, `manual_range_contains`, `manual_retain`, `manual_strip`, `manual_try_fold`, `manual_unwrap_or` |
| **冗余代码** | `redundant_clone`, `redundant_closure`, `redundant_closure_for_method_calls`, `redundant_static_lifetimes`, `needless_borrow`, `needless_borrowed_reference`, `needless_collect`, `needless_late_init`, `needless_option_as_deref`, `needless_question_mark`, `needless_update`, `unnecessary_filter_map`, `unnecessary_lazy_evaluations`, `unnecessary_sort_by`, `unnecessary_to_owned` |
| **性能** | `trivially_copy_pass_by_ref`, `identity_op` |
| **风格** | `uninlined_format_args` |

**核心设计哲学**:
- `unwrap_used` / `expect_used` 为 deny：强制使用 `?` 或显式错误处理，不允许 panic 路径
- `manual_*` 系列：强制使用标准库提供的更安全/更高效的替代方法
- `redundant_*` 系列：消除所有冗余代码

### 1.7 cargo-shear 忽略列表

```toml
[workspace.metadata.cargo-shear]
ignored = ["icu_provider", "openssl-sys", "codex-utils-readiness", "codex-utils-template", "codex-v8-poc"]
```

这些 crate 被平台特定代码引用但 cargo-shear 无法检测到，标记为误报忽略。

---

## 2. Justfile 命令体系

File: `justfile`（工作目录默认为 `codex-rs`）

### 2.1 命令总览

| 命令 | 别名 | 用途 | 详细说明 |
|------|------|------|---------|
| **构建/格式化** | | | |
| `fmt` | | 代码格式化 | `cargo fmt -- --config imports_granularity=Item` |
| `fix *args` | | Clippy 自动修复 | `cargo clippy --fix --tests --allow-dirty` |
| `clippy *args` | | Clippy 检查 | `cargo clippy --tests` |
| `install` | | 安装工具链 | 显示 active toolchain + `cargo fetch` |
| **运行** | | | |
| `codex *args` / `c` | `c` | 运行 codex CLI | `cargo run --bin codex` |
| `exec *args` | | 运行 codex exec | `cargo run --bin codex -- exec` |
| `tui-with-exec-server *args` | | 启动 exec-server 并运行 TUI | 调用 `scripts/run_tui_with_exec_server.sh` |
| `file-search *args` | | 运行文件搜索 CLI | `cargo run --bin codex-file-search` |
| `app-server-test-client *args` | | 运行 app-server 测试客户端 | 先构建 CLI，再运行测试客户端 |
| `mcp-server-run *args` | | 运行 MCP 服务器 | `cargo run -p codex-mcp-server` |
| `log *args` | | 查看 state SQLite 日志 | `cargo run -p codex-state --bin logs_client` |
| **测试** | | | |
| `test` | | 运行测试套件 | `cargo nextest run --no-fail-fast`（推荐本地用） |
| **Bazel** | | | |
| `bazel-codex *args` | | Bazel 构建运行 codex | `bazel run //codex-rs/cli:codex` |
| `bazel-test` | | Bazel 运行测试 | 排除 argument-comment-lint |
| `bazel-clippy` | | Bazel clippy 检查 | 使用远程执行 |
| `bazel-argument-comment-lint` | | Bazel 运行参数注释 lint | 需要 nightly 工具链 |
| `bazel-remote-test` | | Bazel 远程测试 | 使用 BuildBuddy RBE |
| `build-for-release` | | Bazel 发布构建 | `bazel build //codex-rs/cli:release_binaries --config=remote` |
| **锁文件** | | | |
| `bazel-lock-update` | | 更新 Bazel 锁文件 | `bazel mod deps --lockfile_mode=update` |
| `bazel-lock-check` | | 检查锁文件一致性 | 调用 `scripts/check-module-bazel-lock.sh` |
| **Schema 生成** | | | |
| `write-config-schema` | | 生成 config.toml JSON Schema | `cargo run -p codex-core --bin codex-write-config-schema` |
| `write-app-server-schema *args` | | 生成 app-server 协议 Schema | `cargo run -p codex-app-server-protocol --bin write_schema_fixtures` |
| `write-hooks-schema` | | 生成 hooks 协议 Schema | `cargo run -p codex-hooks --bin write_hooks_schema_fixtures` |
| **自定义 Lint** | | | |
| `argument-comment-lint *args` | | 运行参数注释 lint | 基于 Dylint 的自定义 lint |
| `argument-comment-lint-from-source *args` | | 从源码构建运行 lint | 调用 `tools/argument-comment-lint/run.py` |

### 2.2 关键设计决策

1. **Working Directory**: 所有命令默认在 `codex-rs/` 下执行（`set working-directory := "codex-rs"`）
2. **`[no-cd]` 标注**: Bazel 相关命令、schema 生成、lint 命令使用 `[no-cd]` 因为它们需要在项目根目录运行
3. **nextest 优先**: 测试命令使用 `cargo nextest` 而非 `cargo test`，因为更快
4. **imports_granularity=Item**: 格式化时强制每个 import 独立一行，提高可读性和 diff 友好度

---

## 3. Bazel 构建配置

### 3.1 版本与工具链

- **Bazel 版本**: 9.0.0 (`.bazelversion`)
- **Rust 工具链**:
  - 稳定版: 1.93.0（`toolchains` extension 配置）
  - Nightly: `nightly/2025-09-18`（用于 argument-comment-lint 等 Dylint 工具）
- **rules_rs**: 0.0.58（大量 Windows gnullvm 兼容性补丁）
- **rules_rust**: 通过 `rules_rs` 的 reexported extension 引入

### 3.2 MODULE.bazel — 模块依赖架构

**核心 Bazel 模块**:

| 模块 | 版本 | 作用 |
|------|------|------|
| `rules_rs` / `rules_rust` | 0.0.58 | Rust 构建规则 |
| `llvm` | 0.7.1 | LLVM/Clang 工具链（含 Windows symlink 补丁） |
| `zstd` | 1.5.7 | zstd 压缩库 |
| `bzip2` | 1.0.8 | bzip2 压缩（Windows 兼容补丁） |
| `zlib` | 1.3.1 | zlib 压缩 |
| `xz` | 5.4.5 | xz/lzma 压缩（Windows 兼容补丁） |
| `openssl` | 3.5.4 | OpenSSL（hermetic 构建） |
| `v8` | 14.6.202.9 | V8 JavaScript 引擎 |
| `libcap` | 2.27 | Linux 能力库 |
| `alsa_lib` | 1.2.9 | ALSA 音频库 |

**平台覆盖**: MODULE.bazel 中 `crate.from_cargo` 的 `platform_triples` 覆盖 10 个目标平台：

```
aarch64-unknown-linux-gnu
aarch64-unknown-linux-musl
aarch64-apple-darwin
aarch64-pc-windows-msvc
aarch64-pc-windows-gnullvm
x86_64-unknown-linux-gnu
x86_64-unknown-linux-musl
x86_64-apple-darwin
x86_64-pc-windows-msvc
x86_64-pc-windows-gnullvm
```

### 3.3 根 BUILD.bazel — 平台定义

```
平台架构:
- local_linux:  glibc 2.28 兼容 (解决 musl-built Rust 无法 dlopen proc macros 的问题)
- local_windows:  windows-gnullvm 工具链
- local_windows_msvc:  windows MSVC 工具链
- rbe:  远程执行平台 (BuildBuddy)
```

### 3.4 .bazelrc — 构建配置详解

**缓存策略**:
- 磁盘缓存: `~/.cache/bazel-disk-cache`
- 仓库缓存: `~/.cache/bazel-repo-cache`
- 远程缓存: `grpcs://remote.buildbuddy.io`（BuildBuddy）
- 远程下载器: `grpcs://remote.buildbuddy.io`

**平台特定配置**:
| 平台 | 配置 |
|------|------|
| Linux | `--host_platform=//:local_linux`，`--test_env=PATH=/usr/local/bin:...` |
| macOS | `--test_env=PATH=/opt/homebrew/bin:...` |
| Windows | `--host_platform=//:local_windows`，`--test_env=PATH/SYSTEMROOT/COMSPEC/WINDIR` |

**CI 配置**:
| Config | 描述 |
|--------|------|
| `ci` | 最小化远程下载、keep_going、verbose_failures |
| `ci-bazel` | ci + workflow=bael metadata |
| `ci-linux` | ci-bazel + remote build/test on RBE |
| `ci-macos` | ci-bazel + remote build + local test (darwin-sandbox) |
| `ci-windows` | ci-bazel + Windows 路径调整 |
| `ci-v8` | V8 专用远程执行配置 |

**Clippy 配置** (`--config=clippy`):
- 使用 `rust_clippy_aspect` aspect
- 引用 `codex-rs/clippy.toml`
- 30 个 deny 级别规则与 Cargo workspace lints 完全同步
- 这是 `.bazelrc` 中的一个关键同步点，需要手动保持一致

**Argument Comment Lint** (`--config=argument-comment-lint`):
- 使用自定义 Dylint aspect
- 需要 nightly Rust 工具链

### 3.5 Crate BUILD.bazel 示例

**codex-rs/core/BUILD.bazel**:
```python
codex_rust_crate(
    name = "core",
    crate_name = "codex_core",
    compile_data = glob(...),  # 所有源码作为编译数据
    rustc_env = {"CARGO_MANIFEST_DIR": "codex-rs/core"},  # Bazel execroot 路径修正
    integration_compile_data_extra = [...],  # 集成测试额外数据
    test_shard_counts = {"core-all-test": 8, "core-unit-tests": 8},  # 测试分片
    test_tags = ["no-sandbox"],  # 禁用 Bazel 沙箱（沙箱功能需系统支持）
    extra_binaries = [...],  # 依赖的额外二进制（linux-sandbox, rmcp 测试服务器等）
)
```

**codex-rs/tui/BUILD.bazel**:
```python
codex_rust_crate(
    name = "tui",
    crate_name = "codex_tui",
    compile_data = glob(...) + [协作模板文件],
    test_data_extra = glob([源码, 快照]),
    rustc_flags_extra = MACOS_WEBRTC_RUSTC_LINK_FLAGS,  # macOS WebRTC 链接标志
    test_shard_counts = {"tui-unit-tests": 8},
)
```

**关键设计点**:
- 使用自定义 `codex_rust_crate` 宏（定义在 `//:defs.bzl`）统一封装 crate 构建规则
- `compile_data` 使用 glob 包含所有文件，确保 `include_str!` 等 build-time 文件读取可用
- `rustc_env` 修正 `CARGO_MANIFEST_DIR` 指向 Bazel execroot 内路径
- 测试分片（shard）加速大规模测试
- `no-sandbox` tag 允许 core 测试在没有 Bazel 沙箱限制的环境下运行

### 3.6 Bazel 与 Cargo 的协作关系

```
┌─────────────────────────────────────────────────────────────────┐
│                     开发者工作流                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  cargo build │  │  cargo test  │  │  cargo clippy / fmt   │  │
│  │  (日常开发)   │  │  (本地测试)   │  │  (本地 lint/格式化)    │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         ↓                 ↓                   ↓                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Cargo (Cargo.toml + Cargo.lock)                ││
│  │  - 主力日常构建工具                                           ││
│  │  - workspace.dependencies 统一版本                            ││
│  │  - 本地开发/测试/格式化                                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     CI / 发布工作流                               │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ bazel test   │  │ bazel clippy│  │ bazel build (release) │  │
│  │ (远程测试)    │  │ (远程 lint)  │  │ (远程发布构建)          │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         ↓                 ↓                   ↓                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │           Bazel (MODULE.bazel + BUILD.bazel + .bazelrc)    ││
│  │  - CI 远程执行 (BuildBuddy RBE)                             ││
│  │  - 多平台交叉编译 (10 个 target triple)                      ││
│  │  - 发布构建 (build-for-release)                             ││
│  │  - Hermetic 工具链 (不需要系统安装)                            ││
│  │  - Clippy/自定义 Lint 统一执行                               ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**核心要点**:
- **Cargo 是日常开发的主力工具**，Bazel 是 CI/发布的主力工具
- Cargo.lock 和 MODULE.bazel.lock 是两个独立的锁文件，需要分别维护
- `cargo-shear` 确保没有无用依赖，Bazel 的 `from_cargo` 从 Cargo.lock 读取依赖信息
- release 构建同时使用两条路径：Cargo `cargo build --release`（用于 macOS/Linux/Windows 发布） 和 Bazel `bazel build //codex-rs/cli:release_binaries`（CI 验证）

---

## 4. CI/CD 流程

### 4.1 GitHub Actions 工作流总览

项目包含 **22 个 workflow 文件** + 1 个 zstd 目录：

| 工作流 | 触发条件 | 核心功能 |
|--------|---------|---------|
| **ci.yml** | PR + push main | TypeScript/Node 侧 CI：workspace manifest 验证、tui-core 边界检查、Bazel clippy lint 同步验证、npm 包 staging、Prettier |
| **rust-ci.yml** | PR + manual | **快速 PR CI**：路径检测 → cargo fmt → cargo shear → argument-comment-lint（macOS/Linux/Windows） |
| **rust-ci-full.yml** | push main + 分支含 `full-ci` + manual | **完整 CI**：cargo fmt + shear + argument-comment-lint + 多平台 clippy/build（12 个矩阵组合）+ 多平台测试（5 个矩阵组合 + nextest） |
| **bazel.yml** | PR + push main + manual | Bazel CI：多平台测试 + 多平台 clippy + release 构建验证 |
| **rust-release.yml** | push tag `rust-v*.*.*` | **发布流程**：tag 校验 → 多平台 Cargo 构建 → 代码签名 → GitHub Release → npm 发布 → WinGet → 更新 alpha 分支 |
| **rust-release-windows.yml** | workflow_call | Windows 发布子流程：MSVC 构建 → Azure Trusted Signing → zip/zst/tar.gz 打包 |
| **rust-release-prepare.yml** | schedule (每4h) + manual | 自动更新 `models.json` 并创建 PR |
| **rust-release-zsh.yml** | workflow_call | Zsh 补全脚本发布 |
| **rust-release-argument-comment-lint.yml** | workflow_call | Argument comment lint 二进制发布 |
| **rusty-v8-release.yml** | manual | 构建 musl V8 静态库并发布到 GitHub Release |
| **v8-canary.yml** | schedule + manual | V8 引擎每日构建测试 |
| **cargo-deny.yml** | PR + push main | 依赖许可证审计 |
| **codespell.yml** | PR + push main | 拼写检查 |
| **sdk.yml** | PR + push main | SDK 集成测试（Bazel 构建 + Node SDK 测试） |
| **cla.yml** | issue_comment + PR | CLA 签署检查（仅 openai 仓库） |
| **close-stale-contributor-prs.yml** | schedule | 关闭过期 PR |
| **issue-deduplicator.yml** | issues | 重复 issue 检测 |
| **issue-labeler.yml** | issues/PR | 自动标签 |
| **blob-size-policy.yml** | PR | 文件大小策略检查 |

### 4.2 PR CI 流程 (rust-ci.yml)

```
PR opened/updated
    │
    ▼
┌─────────────┐
│  changed     │ → 检测变更路径 (codex-rs/*, tools/*, .github/*)
│  detect      │
└─────┬───────┘
      │
      ├── [codex changed] ──→ general (cargo fmt --check)
      │                   ──→ cargo_shear
      │
      ├── [argument-comment-lint changed] ──→ argument_comment_lint_prebuilt (Linux/macOS/Windows)
      │
      ├── [argument-comment-lint package changed] ──→ argument_comment_lint_package (cargo test)
      │
      └──→ results (汇总，仅检查相关 job)
```

**关键设计**:
- **路径驱动**: 只运行与变更相关的检查，加速 PR 反馈
- **无变更则跳过**: 仅修改 README 等不涉及 Rust 的文件时，CI 自动通过
- **三平台 lint**: argument-comment-lint 在 Linux/macOS/Windows 上都运行

### 4.3 完整 CI 流程 (rust-ci-full.yml)

合并到 main 后自动触发，覆盖全平台：

**lint_build 矩阵 (12 组合)**:

| 平台 | Target | Profile | Runner |
|------|--------|---------|--------|
| macOS ARM64 | aarch64-apple-darwin | dev | macos-15-xlarge |
| macOS x86_64 | x86_64-apple-darwin | dev | macos-15-xlarge |
| Linux x86_64 (musl) | x86_64-unknown-linux-musl | dev | codex-linux-x64 |
| Linux x86_64 (gnu) | x86_64-unknown-linux-gnu | dev | codex-linux-x64 |
| Linux ARM64 (musl) | aarch64-unknown-linux-musl | dev | codex-linux-arm64 |
| Linux ARM64 (gnu) | aarch64-unknown-linux-gnu | dev | codex-linux-arm64 |
| Windows x86_64 | x86_64-pc-windows-msvc | dev | codex-windows-x64 |
| Windows ARM64 | aarch64-pc-windows-msvc | dev | codex-windows-arm64 |
| macOS ARM64 | aarch64-apple-darwin | release | macos-15-xlarge |
| Linux x86_64 (musl) | x86_64-unknown-linux-musl | release | codex-linux-x64 |
| Linux ARM64 (musl) | aarch64-unknown-linux-musl | release | codex-linux-arm64 |
| Windows x86_64 | x86_64-pc-windows-msvc | release | codex-windows-x64 |
| Windows ARM64 | aarch64-pc-windows-msvc | release | codex-windows-arm64 |

**tests 矩阵 (5 组合)**:

| 平台 | Target | 特殊配置 |
|------|--------|---------|
| macOS ARM64 | aarch64-apple-darwin | - |
| Linux x86_64 | x86_64-unknown-linux-gnu | Docker 远程 test env |
| Linux ARM64 | aarch64-unknown-linux-gnu | - |
| Windows x86_64 | x86_64-pc-windows-msvc | - |
| Windows ARM64 | aarch64-pc-windows-msvc | - |

**缓存策略**:
- `sccache`: 编译对象缓存（10G 上限），Linux/macOS ARM64 启用，Windows 和 macOS x86_64 cross-target 禁用
- `cargo home cache`: Cargo registry 缓存
- `cargo-chef`: release 构建前的依赖预热

**测试工具**:
- `cargo nextest`: 比 `cargo test` 更快的并行测试运行器
- `ci-test` profile: `debug = 1` 减小调试符号体积

### 4.4 Bazel CI 流程 (bazel.yml)

```
PR / push main / manual
    │
    ├── test 矩阵:
    │   ├── macOS ARM64 (aarch64-apple-darwin)
    │   ├── macOS x86_64 (x86_64-apple-darwin)
    │   ├── Linux x86_64 (gnu + musl)
    │   └── Windows (x86_64-pc-windows-gnullvm)
    │   → bazel test //... (远程执行)
    │
    ├── clippy 矩阵:
    │   ├── Linux x86_64 (gnu)
    │   ├── macOS ARM64
    │   └── Windows (gnullvm)
    │   → bazel build --config=clippy (远程执行)
    │
    └── verify-release-build 矩阵:
        ├── Linux x86_64
        ├── macOS ARM64
        └── Windows (gnullvm)
        → 编译 not(debug_assertions) 路径，确保 release 构建不会出错
```

**远程执行**:
- 使用 **BuildBuddy** RBE（Remote Build Execution）
- Linux: 全远程构建+测试
- macOS: 远程构建 + 本地测试（darwin-sandbox）
- Windows: 本地构建+测试

### 4.5 发布流程 (rust-release.yml)

```
Git Tag: rust-v*.*.*
    │
    ▼
┌──────────────────┐
│  tag-check       │ → 验证 tag 格式、tag 版本 = Cargo.toml 版本
└────────┬─────────┘
         │
    ┌────┼─────────────────────────────────────────────────┐
    │    │                                                  │
    ▼    ▼                    ▼                             ▼
┌─────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  build  │  │  build-windows      │  │  arg-comment-lint    │
│ (Cargo) │  │  (MSVC + Azure Sign)│  │  release assets      │
│ macOS   │  │  x86_64 + ARM64     │  │                      │
│ Linux   │  │  primary + helpers  │  │                      │
│ (6 target)│  │                    │  │                      │
└────┬────┘  └─────────┬──────────┘  └──────────┬───────────┘
     │                 │                        │
     └─────────┬───────┘────────────────────────┘
               │
               ▼
     ┌──────────────────┐
     │  release          │ → 下载所有 artifacts
     │                   │ → 生成 release notes
     │                   │ → npm staging (codex, proxy, sdk)
     │                   │ → install 脚本 staging
     │                   │ → 创建 GitHub Release (softprops/action-gh-release)
     │                   │ → DotSlash 发布 (codex, zsh, arg-lint)
     │                   │ → 触发 developers.openai.com 部署
     └────────┬─────────┘
              │
     ┌───────┼──────────────┐
     ▼       ▼              ▼
┌────────┐ ┌────────┐ ┌──────────────┐
│npm publish│ │winget  │ │update branch│
│(OIDC)   │ │publish │ │(latest-alpha│
│codex +  │ │        │ │  -cli)      │
│proxy +  │ │        │ │             │
│sdk      │ │        │ │             │
└────────┘ └────────┘ └──────────────┘
```

**发布平台覆盖**:

| 平台 | Target | 二进制 | 签名 | 产物格式 |
|------|--------|--------|------|---------|
| macOS ARM64 | aarch64-apple-darwin | codex, codex-responses-api-proxy | Apple notarization | .dmg, .zst, .tar.gz |
| macOS x86_64 | x86_64-apple-darwin | 同上 | 同上 | 同上 |
| Linux x86_64 (musl) | x86_64-unknown-linux-musl | 同上 | Cosign sigstore | .zst, .tar.gz |
| Linux x86_64 (gnu) | x86_64-unknown-linux-gnu | 同上 | 同上 | 同上 |
| Linux ARM64 (musl) | aarch64-unknown-linux-musl | 同上 | 同上 | 同上 |
| Linux ARM64 (gnu) | aarch64-unknown-linux-gnu | 同上 | 同上 | 同上 |
| Windows x86_64 | x86_64-pc-windows-msvc | codex + sandbox-setup + command-runner | Azure Trusted Signing | .exe, .zip, .zst, .tar.gz |
| Windows ARM64 | aarch64-pc-windows-msvc | 同上 | 同上 | 同上 |

**特殊机制**:
- **musl 构建**: 使用 Zig 作为 C 编译器（`cargo-zigbuild`），配置 UBSan wrapper
- **npm 发布**: 使用 OIDC Trusted Publishing（无需 NODE_AUTH_TOKEN）
- **WinGet**: 自动提交 PR 到 winget-pkgs 仓库
- **DotSlash**: Facebook 的多平台二进制分发工具，三个配置文件（codex, zsh, arg-lint）

### 4.6 其他 CI 工作流

| 工作流 | 触发 | 说明 |
|--------|------|------|
| `cargo-deny.yml` | PR + push main | 依赖许可证合规性检查 |
| `codespell.yml` | PR + push main | 拼写错误检测（`.codespellignore` 白名单） |
| `sdk.yml` | PR + push main | SDK 集成测试，验证 TypeScript SDK 与 Rust 后端的互操作性 |
| `rust-release-prepare.yml` | 每4小时 + manual | 自动拉取最新模型列表更新 `models.json`，创建 PR |
| `v8-canary.yml` | schedule + manual | V8 引擎每日 canary 构建测试 |
| `cla.yml` | PR + issue_comment | CLA 签署检查（仅 openai 仓库） |

---

## 5. 编辑器/IDE 配置

### 5.1 VSCode 设置 (`.vscode/settings.json`)

| 设置 | 值 | 说明 |
|------|-----|------|
| `rust-analyzer.checkOnSave` | `true` | 保存时自动检查 |
| `rust-analyzer.check.command` | `clippy` | 使用 clippy 而非 cargo check |
| `rust-analyzer.check.extraArgs` | `["--tests"]` | 检查时包含测试代码 |
| `rust-analyzer.rustfmt.extraArgs` | `["--config", "imports_granularity=Item"]` | 格式化时每个 import 独立一行 |
| `rust-analyzer.cargo.targetDir` | `${workspaceFolder}/codex-rs/target/rust-analyzer` | 独立 target 目录避免与手动构建冲突 |
| `[rust].editor.defaultFormatter` | `rust-lang.rust-analyzer` | Rust 文件默认使用 rust-analyzer 格式化 |
| `[rust].editor.formatOnSave` | `true` | 保存时自动格式化 |
| `[toml].editor.defaultFormatter` | `tamasfe.even-better-toml` | TOML 文件使用 Even Better TOML 格式化 |
| `[toml].editor.formatOnSave` | `true` | TOML 保存时格式化 |
| `evenBetterToml.formatter.reorderArrays` | `false` | 不重排数组（config.toml 中顺序有意义） |
| `evenBetterToml.formatter.reorderKeys` | `true` | 重排键名（按字母序） |

**关键设计决策**:
- **独立 target 目录**: rust-analyzer 构建到 `codex-rs/target/rust-analyzer/` 而非默认的 `target/`，避免 IDE 构建和手动 `cargo build` 互相干扰
- **imports_granularity=Item**: 与 justfile 中 `fmt` 命令保持一致

### 5.2 推荐扩展 (`.vscode/extensions.json`)

| 扩展 | ID | 用途 |
|------|-----|------|
| rust-analyzer | `rust-lang.rust-analyzer` | Rust 语言服务器 |
| Even Better TOML | `tamasfe.even-better-toml` | TOML 文件支持 |
| CodeLLDB | `vadimcn.vscode-lldb` | Rust 调试（LLDB 后端） |

### 5.3 调试配置 (`.vscode/launch.json`)

| 配置名 | 类型 | 说明 |
|--------|------|------|
| Cargo launch | `lldb` / launch | 构建 `codex-tui` 并启动调试 |
| Attach to running codex CLI | `lldb` / attach | 附加到运行中的 codex 进程（需手动选择 PID） |

---

## 6. 总结与架构图

### 6.1 构建系统全景

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OpenAI Codex CLI 构建系统                        │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     日常开发层 (Cargo)                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │  │
│  │  │cargo build│ │cargo test│ │cargo fmt │ │cargo clippy --fix │  │  │
│  │  │(编译开发) │ │(nextest) │ │(格式化)   │ │(lint 自动修复)     │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────────┘  │  │
│  │       ↕              ↕            ↕              ↕               │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │  Cargo Workspace (97 crates, Cargo.toml, Cargo.lock)       │ │  │
│  │  │  - workspace.dependencies 统一 ~170 外部依赖版本             │ │  │
│  │  │  - workspace.lints.clippy 30 条 deny 规则                   │ │  │
│  │  │  - 4 个 patch.crates-io fork (crossterm/ratatui/tungstenite)│ │  │
│  │  │  - profiles: dev, dev-small, release (fat LTO), ci-test    │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     CI/发布层 (Bazel + Cargo)                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐│  │
│  │  │Bazel test     │  │Bazel clippy │  │Bazel release build     ││  │
│  │  │(RBE 远程执行) │  │(10 平台矩阵)│  │(build-for-release)    ││  │
│  │  └──────────────┘  └──────────────┘  └────────────────────────┘│  │
│  │       ↕                  ↕                    ↕                 │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │  Bazel (MODULE.bazel + BUILD.bazel + .bazelrc)             │ │  │
│  │  │  - Bazel 9.0.0 + rules_rs 0.0.58                           │ │  │
│  │  │  - BuildBuddy RBE (远程执行/缓存)                            │ │  │
│  │  │  - Hermetic 工具链 (LLVM, macOS SDK, OpenSSL, V8)          │ │  │
│  │  │  - 10 个目标平台 (GNU/musl/MSVC/gnullvm)                   │ │  │
│  │  │  - 自定义 codex_rust_crate 宏                               │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     任务编排层 (just)                             │  │
│  │  ┌──────┐ ┌────────┐ ┌────────────────┐ ┌────────────────────┐ │  │
│  │  │  fmt │ │  test  │ │bazel-lock-check│ │write-config-schema│ │  │
│  │  │  fix │ │ clippy │ │bazel-test      │ │write-app-server-  │ │  │
│  │  └──────┘ └────────┘ └────────────────┘ │   schema          │ │  │
│  │                                          └────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     CI/CD 层 (GitHub Actions)                    │  │
│  │  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │  │
│  │  │  PR CI    │  │  Full CI     │  │  Bazel CI  │  │ Release  │ │  │
│  │  │  (fast)   │  │  (main)      │  │  (RBE)     │  │ (tag)    │ │  │
│  │  └───────────┘  └──────────────┘  └────────────┘  └──────────┘ │  │
│  │  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │  │
│  │  │cargo-deny │  │  codespell   │  │  SDK CI    │  │V8 canary │ │  │
│  │  │(license)  │  │  (spelling)  │  │            │  │          │ │  │
│  │  └───────────┘  └──────────────┘  └────────────┘  └──────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     IDE 集成层 (VSCode)                          │  │
│  │  rust-analyzer (clippy on save) + CodeLLDB + Even Better TOML  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.2 核心设计决策总结

1. **双构建系统**: Cargo 用于日常开发（快速迭代），Bazel 用于 CI/发布（远程执行、hermetic 构建、多平台交叉编译）
2. **极致的 Lint 严格性**: 30 条 deny 级 clippy 规则 + 自定义 Dylint（argument-comment-lint），cargo-shear 检测无用依赖
3. **多平台全面覆盖**: CI 测试 8 个目标平台（macOS ARM64/x86_64, Linux x86_64/ARM64 gnu/musl, Windows x86_64/ARM64 MSVC）
4. **远程执行优先**: 生产级 CI 使用 BuildBuddy RBE，Linux 全远程，macOS 远程构建+本地测试
5. **发布流程高度自动化**: tag → 多平台构建 → 代码签名（Apple/Azure/Cosign）→ GitHub Release → npm (OIDC) → WinGet → DotSlash
6. **Hermetic 构建环境**: Bazel 使用 hermetic LLVM、macOS SDK、OpenSSL、V8，不依赖系统安装
7. **4 个上游 fork**: crossterm/ratatui (TUI 定制)、tokio-tungstenite/tungstenite (WebSocket 定制)
8. **统一依赖管理**: workspace.dependencies 管理 ~170 个外部依赖版本，workspace.package 统一 edition/license
9. **发布 LTO 策略**: release profile 使用 fat LTO + codegen-units=1 + strip=symbols，牺牲编译时间换取最小体积
10. **路径驱动 CI**: PR 仅运行与变更相关的检查，完整 CI 在 main 分支触发

### 6.3 潜在风险点

| 风险 | 说明 |
|------|------|
| Clippy lint 双重维护 | Cargo workspace.lints 和 .bazelrc clippy flags 需手动同步，有 Python 脚本 `verify_bazel_clippy_lints.py` 校验 |
| 双锁文件 | Cargo.lock 和 MODULE.bazel.lock 需分别维护，依赖变更需 `bazel-lock-update` + `bazel-lock-check` |
| 4 个上游 fork | 长期维护成本，需定期与上游同步 |
| Bazel BUILD.bazel 手动维护 | 97 个 crate 的 BUILD.bazel 文件需手动编写（虽然用 codex_rust_crate 宏简化） |
| musl 构建复杂度 | 需要 Zig 交叉编译器 + UBSan wrapper + rusty_v8 musl artifact 覆盖 |