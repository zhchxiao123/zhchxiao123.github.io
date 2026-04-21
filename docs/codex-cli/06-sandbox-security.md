---
title: "Step 6: 沙箱与安全系统"
layout: documentation
project_id: codex-cli-source
permalink: /docs/codex-cli/06-sandbox-security/
---
# Codex CLI 沙箱与安全系统深度分析

> 分析范围: `codex-rs/`  crate 及相关文档
> 分析日期: 2026-04-21

---

## 目录

1. [系统概览](#1-系统概览)
2. [沙箱架构](#2-沙箱架构)
   - 2.1 [多平台沙箱实现](#21-多平台沙箱实现)
   - 2.2 [沙箱标签系统](#22-沙箱标签系统)
   - 2.3 [沙箱策略类型体系](#23-沙箱策略类型体系)
   - 2.4 [沙箱命令变换流程](#24-沙箱命令变换流程)
3. [权限与审批策略](#3-权限与审批策略)
   - 3.1 [审批模式 (AskForApproval)](#31-审批模式-askforapproval)
   - 3.2 [文件系统权限配置](#32-文件系统权限配置)
   - 3.3 [补丁安全评估](#33-补丁安全评估)
   - 3.4 [权限配置编译流程](#34-权限配置编译流程)
4. [执行策略详解](#4-执行策略详解)
   - 4.1 [执行策略架构](#41-执行策略架构)
   - 4.2 [规则匹配与决策流程](#42-规则匹配与决策流程)
   - 4.3 [启发式回退机制](#43-启发式回退机制)
   - 4.4 [命令解析与规范化](#44-命令解析与规范化)
   - 4.5 [策略层级叠加](#45-策略层级叠加)
5. [网络策略与审批](#5-网络策略与审批)
   - 5.1 [网络沙箱策略](#51-网络沙箱策略)
   - 5.2 [网络审批服务](#52-网络审批服务)
   - 5.3 [网络规则持久化](#53-网络规则持久化)
6. [进程安全](#6-进程安全)
   - 6.1 [进程硬化 (pre_main_hardening)](#61-进程硬化-pre_main_hardening)
   - 6.2 [命令规范化](#62-命令规范化)
   - 6.3 [Shell 提权服务](#63-shell-提权服务)
7. [安全路径：从用户命令到沙箱执行](#7-安全路径从用户命令到沙箱执行)
8. [架构图](#8-架构图)

---

## 1. 系统概览

Codex CLI 的安全体系采用**纵深防御**策略，从命令输入到最终执行构建了多层安全屏障：

```
用户命令 → 命令规范化 → 执行策略检查 → 安全评估 → 沙箱策略选择 → 进程硬化 → 沙箱内执行
                                                    ↘ 网络策略检查 → 网络代理/阻断
```

核心 crate 依赖关系：

| Crate | 职责 |
|-------|------|
| `codex-core` (core/) | 安全评估、权限配置编译、执行策略管理、网络审批 |
| `codex-sandboxing` (sandboxing/) | 跨平台沙箱命令变换（macOS Seatbelt、Linux Landlock+Bubblewrap） |
| `codex-linux-sandbox` (linux-sandbox/) | Linux 专用沙箱二进制（Landlock + seccomp + bubblewrap） |
| `codex-windows-sandbox-rs` (windows-sandbox-rs/) | Windows 限制令牌沙箱（ACL/DACL） |
| `codex-process-hardening` (process-hardening/) | 进程启动前硬化（core dump 禁用、ptrace 阻断等） |
| `codex-shell-escalation` (shell-escalation/) | Unix Shell 提权服务 |
| `codex-execpolicy` (execpolicy/) | 独立执行策略引擎（规则解析、匹配、决策） |
| `codex-protocol` | 安全类型定义（SandboxPolicy、FileSystemSandboxPolicy 等） |

---

## 2. 沙箱架构

### 2.1 多平台沙箱实现

Codex 实现了三大平台各异的沙箱机制，统一抽象为 `SandboxType` 枚举：

```
SandboxType::None          — 无沙箱（DangerFullAccess 模式）
SandboxType::MacosSeatbelt — macOS Seatbelt (sandbox-exec)
SandboxType::LinuxSeccomp  — Linux Landlock + seccomp + bubblewrap
SandboxType::WindowsRestrictedToken — Windows 限制令牌 + ACL
```

平台选择逻辑 (`manager.rs:get_platform_sandbox`):

```
macOS   → MacosSeatbelt（始终可用）
Linux   → LinuxSeccomp（始终可用）
Windows → WindowsRestrictedToken（需 windows_sandbox_enabled=true）或 None
其他    → None
```

#### 2.1.1 macOS Seatbelt 实现

**文件**: `sandboxing/src/seatbelt.rs`, `sandboxing/src/seatbelt_base_policy.sbpl`

Seatbelt 是 macOS 原生的沙箱机制，通过 `/usr/bin/sandbox-exec` 调用：

- 使用模板文件 `seatbelt_base_policy.sbpl` 和 `seatbelt_network_policy.sbpl` 生成 Seatbelt 策略
- 仅信任 `/usr/bin/sandbox-exec`（防御 PATH 注入）
- 文件系统权限映射到 Seatbelt 规则：
  - `WorkspaceWrite`：允许写入 `writable_roots` 和 CWD，只读其余可读路径
  - `ReadOnly`：全部只读
  - `DangerFullAccess`/`ExternalSandbox`：不使用 Seatbelt
- 网络代理支持：自动检测环境变量中的代理配置（`HTTP_PROXY` 等），为回环地址的代理端口放行
- Unix domain socket 策略：可限制为特定 socket 路径的访问

#### 2.1.2 Linux Landlock/Seccomp 实现

**文件**: `sandboxing/src/landlock.rs`, `linux-sandbox/src/`

Linux 沙箱采用**三级防御体系**：

1. **Landlock**（内核级文件系统限制）：通过 `landlock_restrict_self()` 系统调用限制文件系统访问
2. **seccomp**（系统调用过滤）: `no_new_privs` + seccomp-bpf 过滤器限制允许的系统调用
3. **Bubblewrap (bwrap)**：可选的文件系统命名空间隔离，提供 bind mount 和 pivot_root

启动流程 (`linux-sandbox/src/launcher.rs`):

```
命令 → codex-linux-sandbox 二进制
     → 应用 Landlock 规则
     → 设置 no_new_privs + seccomp 过滤器
     → 检测是否需要 bubblewrap
       → WSL1 环境：拒绝使用 bubblewrap
       → 需要 bwrap：优先使用系统 bwrap，回退到 vendored bwrap
     → execve 目标命令
```

策略传递方式：通过 CLI 参数序列化为 JSON：
- `--sandbox-policy` — SandboxPolicy JSON
- `--file-system-sandbox-policy` — FileSystemSandboxPolicy JSON
- `--network-sandbox-policy` — NetworkSandboxPolicy JSON
- `--sandbox-policy-cwd` — 沙箱策略的工作目录
- `--command-cwd` — 命令执行的工作目录
- `--use-legacy-landlock` — 使用旧版 Landlock（无 bwrap）
- `--allow-network-for-proxy` — 为网络代理放行

#### 2.1.3 Windows 限制令牌实现

**文件**: `windows-sandbox-rs/src/lib.rs`

Windows 沙箱采用**限制令牌 + ACL/DACL**机制：

1. **SID 和令牌管理**（`token.rs`）：
   - `create_readonly_token_with_cap` — 创建只读令牌
   - `create_workspace_write_token_with_caps_from` — 创建工作区写入令牌
   - 使用 Capability SID (CAP SID) 标识权限范围

2. **ACL/DACL 操作**（`acl.rs`）：
   - `add_allow_ace` — 添加允许访问的 ACE
   - `add_deny_write_ace` — 添加拒绝写入的 ACE
   - `revoke_ace` — 移除 ACE（清理）
   - `allow_null_device` — 允许访问 NUL 设备

3. **进程创建**（`process.rs`）：
   - `create_process_as_user` — 使用受限令牌创建进程
   - 支持 ConPTY（Windows 伪终端）

4. **桌面隔离**（`desktop.rs`）：
   - 可选私有桌面隔离（`use_private_desktop`）

5. **关键执行流程**:
```
SandboxPolicy 解析
  → ReadOnly: 创建只读令牌
  → WorkspaceWrite: 创建工作区写入令牌 + CAP SID
  → DangerFullAccess/ExternalSandbox: 拒绝（Windows 不支持）
→ 计算允许/拒绝路径 (compute_allow_paths)
→ 添加允许 ACE (add_allow_ace)
→ 添加拒绝写入 ACE (add_deny_write_ace)
→ 设置网络阻断 (apply_no_network_to_env)
→ 创建受限进程 (create_process_as_user)
→ 等待完成 / 超时处理
→ 清理 ACE (revoke_ace)
```

### 2.2 沙箱标签系统

**文件**: `core/src/sandbox_tags.rs`

沙箱标签用于遥测/指标，将沙箱类型映射为字符串：

```
DangerFullAccess    → "none"
ExternalSandbox     → "external"
WindowsRestrictedToken (elevated) → "windows_elevated"
MacosSeatbelt       → "seatbelt"
LinuxSeccomp        → "seccomp"
无平台沙箱可用       → "none"
```

### 2.3 沙箱策略类型体系

**定义于 `codex-protocol`**，核心枚举：

```rust
SandboxPolicy::DangerFullAccess                    // 完全访问，无沙箱
SandboxPolicy::ReadOnly { access, network_access } // 只读沙箱
SandboxPolicy::WorkspaceWrite {                     // 工作区写入沙箱
    writable_roots, read_only_access,
    network_access, exclude_tmpdir_env_var,
    exclude_slash_tmp
}
SandboxPolicy::ExternalSandbox { network_access }  // 外部沙箱（CI 等）
```

**`FileSystemSandboxPolicy`** 是细粒度文件系统访问控制：

```rust
FileSystemSandboxPolicy {
    kind: FileSystemSandboxKind,  // Restricted | Unrestricted | ExternalSandbox
    entries: Vec<FileSystemSandboxEntry>,  // 路径条目列表
    glob_scan_max_depth: Option<usize>,    // glob 扫描最大深度
}
FileSystemSandboxEntry {
    path: FileSystemPath,   // Path | Special | GlobPattern
    access: FileSystemAccessMode,  // None | Read | Write
}
FileSystemSpecialPath: Root | Minimal | Tmpdir | ProjectRoots | Unknown
```

**`NetworkSandboxPolicy`**: `Enabled` | `Restricted`

### 2.4 沙箱命令变换流程

**文件**: `sandboxing/src/manager.rs`

```rust
fn transform(request: SandboxTransformRequest) → Result<SandboxExecRequest, SandboxTransformError>
```

核心变换流程：

```
原始命令 (SandboxCommand)
  ↓
1. 计算有效权限 (EffectiveSandboxPermissions)
   - 合并 base policy + additional_permissions
   - 计算有效文件系统策略 (effective_file_system_sandbox_policy)
   - 计算有效网络策略 (effective_network_sandbox_policy)
  ↓
2. 根据平台选择沙箱包装
   SandboxType::None:
     → 原始命令不变
   SandboxType::MacosSeatbelt:
     → /usr/bin/sandbox-exec [seatbelt_args...] -- command
   SandboxType::LinuxSeccomp:
     → codex-linux-sandbox [policy_args...] -- command
   SandboxType::WindowsRestrictedToken:
     → 原始命令不变（沙箱在进程创建时通过令牌实现）
  ↓
3. 生成 SandboxExecRequest（包含变换后的命令和所有策略参数）
```

**`should_require_platform_sandbox`* 判定逻辑：

```
有托管网络需求 → 需要
NetworkRestricted + Restricted文件系统 + 非全盘写入 → 需要
FileSystemSandboxKind::ExternalSandbox → 不需要
FileSystemSandboxKind::Unrestricted → 不需要
```

---

## 3. 权限与审批策略

### 3.1 审批模式 (AskForApproval)

```rust
AskForApproval::OnFailure       // 失败时询问（最宽松）
AskForApproval::Never            // 从不询问
AskForApproval::OnRequest        // 每次请求都询问
AskForApproval::UnlessTrusted    // 除非信任否则询问
AskForApproval::Granular(config) // 细粒度控制
  - sandbox_approval: bool    // 是否允许沙箱审批
  - rules: bool               // 是否允许规则审批
  - skill_approval: bool      // 是否允许技能审批
  - request_permissions: bool  // 是否允许权限请求
  - mcp_elicitations: bool    // 是否允许 MCP 请求
```

**审批模式决策表**（用于 `prompt_is_rejected_by_policy`）：

| 审批模式 | 规则提示 | 沙箱提示 | 结果 |
|----------|----------|----------|------|
| Never | - | - | 拒绝 |
| OnFailure | - | - | 允许 |
| OnRequest | - | - | 允许 |
| UnlessTrusted | - | - | 允许（始终询问用户） |
| Granular(sandbox=true, rules=true) | ✔ | ✔ | 允许 |
| Granular(sandbox=false, rules=true) | ✔ | ✘ | 沙箱提示被拒 |
| Granular(sandbox=true, rules=false) | ✘ | ✔ | 规则提示被拒 |

### 3.2 文件系统权限配置

**文件**: `core/src/config/permissions.rs`

配置文件格式（TOML）中的权限配置经过编译为 `FileSystemSandboxPolicy` 和 `NetworkSandboxPolicy`：

#### 特殊路径 (`:special_path`)

| 路径 | 含义 |
|------|------|
| `:root` | 文件系统根目录 |
| `:minimal` | 最小可读路径集合 |
| `:project_roots` | 项目根目录（可嵌套子路径） |
| `:tmpdir` | 系统临时目录 |

#### 访问模式

```
None   = 完全拒绝（deny-read glob 模式）
Read   = 只读访问
Write  = 读写访问
```

#### 编译规则

1. **路径格式**:
   - 绝对路径 → `FileSystemPath::Path`
   - `:special_path` → `FileSystemPath::Special`
   - 带 glob 的 `none` 访问路径 → `FileSystemPath::GlobPattern`

2. **子路径嵌套**:
   ```toml
   [filesystem.permissions.workspace]
   ":project_roots" = { access = "write" }
   # 或嵌套子路径:
   [filesystem.permissions.workspace."project_roots"]
   "docs/**" = "read"
   "**/*.env" = "none"
   ```

3. **Glob 限制**:
   - `read`/`write` 访问只支持尾部 `/**`（子树模式）
   - `none` 访问支持完整 glob 模式
   - 非尾部 glob 的 `read`/`write` 会产生启动警告
   - 无界 `**` glob（`none` 访问）需要 `glob_scan_max_depth`

4. **向前兼容**: 未知 `:special_path` 值不会导致配置失败，而是作为警告

### 3.3 补丁安全评估

**文件**: `core/src/safety.rs`

`assess_patch_safety()` 函数决定文件补丁操作是否需要用户审批：

```
assess_patch_safety(action, policy, sandbox_policy, file_system_policy, cwd, windows_level)
  ↓
空补丁? → Reject("empty patch")
  ↓
UnlessTrusted 模式? → AskUser
  ↓
补丁是否约束在可写路径内？(is_write_patch_constrained_to_writable_paths)
  ↓ 是                                          ↓ 否
DangerFullAccess/ExternalSandbox?                rejects_sandbox_approval?
  ↓ 是                    ↓ 否                    ↓ 是        ↓ 否
AutoApprove(None)      有平台沙箱?               Reject       AskUser
                        ↓ 是        ↓ 否
                   AutoApprove     rejects_sandbox?
                   (sandbox_type)    ↓ 是     ↓ 否
                                    Reject    AskUser
```

**路径约束检查**: 对补丁中每个文件的增/删/改操作，验证目标路径和移动目标路径（如有）都在 `FileSystemSandboxPolicy.can_write_path_with_cwd` 范围内。

### 3.4 权限配置编译流程

```
PermissionsToml (TOML 配置)
  ↓ compile_permission_profile()
PermissionProfileToml
  ↓
FileSystemSandboxPolicy (restricted entries)
NetworkSandboxPolicy (Enabled/Restricted)
```

运行时必需的可读根路径（`get_readable_roots_required_for_codex_runtime`）：
- zsh 可执行文件路径
- codex arg0 wrapper 目录
- 这些路径自动添加到沙箱可读列表

---

## 4. 执行策略详解

### 4.1 执行策略架构

**核心 crate**: `codex-execpolicy`

执行策略使用 **Starlark DSL** 定义规则文件（`.rules`），存储在各配置层的 `rules/` 目录下。

**规则类型**:

| 类型 | 语法 | 作用 |
|------|------|------|
| `prefix_rule` | `prefix_rule(pattern=["cmd"], decision="allow\|prompt\|forbidden", justification="...")` | 前缀匹配 |
| `network_rule` | `network_rule(host="example.com", protocol="https", decision="allow\|forbidden")` | 网络域名控制 |
| `host_executable` | `host_executable(name="git", paths=["/usr/bin/git"])` | 主机可执行文件映射 |

**决策类型 (Decision)**:
- `Allow` — 允许执行
- `Prompt` — 需要用户审批
- `Forbidden` — 禁止执行

**规则匹配结构 (RuleMatch)**:
```rust
RuleMatch::PrefixRuleMatch {
    matched_prefix: Vec<String>,
    decision: Decision,
    resolved_program: Option<AbsolutePathBuf>,  // 绝对路径解析结果
    justification: Option<String>,
}
RuleMatch::HeuristicsRuleMatch {
    command: Vec<String>,
    decision: Decision,
}
```

### 4.2 规则匹配与决策流程

**文件**: `core/src/exec_policy.rs`

```rust
fn create_exec_approval_requirement_for_command(request) → ExecApprovalRequirement
```

```
原始命令
  ↓
命令解析 (commands_for_exec_policy)
  ↓ bash -lc 简单命令? → 解析内部命令
  ↓ bash -lc heredoc?   → 单条命令 + used_complex_parsing=true
  ↓ 其他                 → 原始命令
  ↓
多命令逐个匹配 (Policy::check_multiple_with_options)
  ↓ 对每个命令:
    → 前缀规则精确匹配 (rules_by_program HashMap)
    → 无匹配? → 主机可执行文件规则匹配 (host_executables)
    → 仍无匹配? → 启发式回退 (heuristics_fallback)
  ↓
聚合决策 (Evaluation::from_matches)
  → 取所有规则匹配中优先级最高的 Decision
  → Forbidden > Prompt > Allow
  ↓
决策结果映射:
  Forbidden → ExecApprovalRequirement::Forbidden { reason }
  Prompt    → 根据 AskForApproval 可能:
               - 禁止（Granular 时规则/沙箱审批关闭）
               - 需要审批（NeedsApproval { reason, proposed_amendment }）
  Allow     → ExecApprovalRequirement::Skip { bypass_sandbox, proposed_amendment }
```

**自动修正案 (proposed_execpolicy_amendment)**:

当命令需要审批时，系统会自动建议一个前缀规则供用户下次自动批准：
- 禁止建议的模式：`BANNED_PREFIX_SUGGESTIONS` 中的危险前缀（python, bash, sudo 等）
- 只在启发式匹配时建议（策略规则已覆盖时不建议）
- 建议的前缀必须能批准所有解析出的子命令

**bypass_sandbox 标志**:

只有当**每个子命令**都被策略规则（非启发式）明确 Allow 时才为 true。启发式 Allow 不 bypass 沙箱。

### 4.3 启发式回退机制

**文件**: `core/src/exec_policy.rs:render_decision_for_unmatched_command`

当无规则匹配命令时的决策逻辑：

```
is_known_safe_command(command)?

已知安全命令 (ls, cat, head, tail, git status, etc.)
  → Allow（跳过沙箱: 仅策略规则可 bypass）

不是已知安全命令 → command_might_be_dangerous(command)?

可能是危险的命令 (rm, python, bash, sudo, curl 等)
  → AskForApproval::Never + DangerFullAccess → Allow
  → AskForApproval::Never + 其他 → Forbidden
  → 其他模式 → Prompt

普通命令 (cargo build, npm install 等)
  → AskForApproval::Never|OnFailure → Allow（依赖沙箱保护）
  → AskForApproval::UnlessTrusted → Prompt
  → AskForApproval::OnRequest|Granular:
    → FileSystemSandboxKind::Unrestricted|ExternalSandbox → Allow
    → FileSystemSandboxKind::Restricted + 沙箱越权? → Prompt
    → FileSystemSandboxKind::Restricted + 无越权 → Allow
```

### 4.4 命令解析与规范化

**文件**: `core/src/command_canonicalization.rs`

`canonicalize_command_for_approval()` 保证跨会话的审批缓存键稳定：

1. `bash -lc "简单命令"` → 解析内部命令词法单元
2. `bash/zsh -lc "heredoc 脚本"` → `__codex_shell_script__` + 模式 + 脚本文本
3. `powershell -Command "脚本"` → `__codex_powershell_script__` + 脚本文本
4. 其他 → 原始命令不变

这使得 `bash -lc "cargo test"` 和 `/bin/bash -lc "cargo   test"` 获得相同的规范化键。

### 4.5 策略层级叠加

**文件**: `core/src/exec_policy.rs:load_exec_policy`

策略文件按优先级从低到高的顺序加载：

```
系统层 (ConfigLayerSource::System)
  → 用户层 (ConfigLayerSource::User)
    → 项目层 (ConfigLayerSource::Project)
      → 需求覆盖层 (RequirementsExecPolicy)
```

- `ignore_user_and_project_exec_policy_rules` 标志可跳过用户和项目层
- 禁用的层（untrusted）不被加载
- `requirements` 层可以叠加网络规则和主机可执行文件映射
- 后加载的层有较高优先级（可覆盖前层规则）

---

## 5. 网络策略与审批

### 5.1 网络沙箱策略

```rust
NetworkSandboxPolicy::Enabled    // 允许网络，通过代理路由
NetworkSandboxPolicy::Restricted  // 禁止网络（CODEX_SANDBOX_NETWORK_DISABLED=1）
```

网络策略编译：
- `network.enabled = Some(true)` → `Enabled`
- 其他（包括 None）→ `Restricted`

环境变量传播：
```rust
if !network_sandbox_policy.is_enabled() {
    env.insert(CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR, "1");
}
```

### 5.2 网络审批服务

**文件**: `core/src/tools/network_approval.rs`

`NetworkApprovalService` 管理运行时网络访问审批：

**审批模型**:

```
NetworkApprovalMode::Immediate  — 命令完成前等待审批
NetworkApprovalMode::Deferred   — 命令启动后等待审批
```

**审批流程**:

```
网络请求到达代理
  ↓
1. 检查 session_denied_hosts → 已拒绝? → Deny
  ↓
2. 检查 session_approved_hosts → 已批准? → Allow
  ↓
3. 首次请求该 host:port/protocol?
  → 并发请求等待 (PendingHostApproval)
  ↓
4. 检查沙箱策略是否允许审批流程
   - SandboxPolicy: ReadOnly/WorkspaceWrite → 允许
   - DangerFullAccess/ExternalSandbox → 拒绝
  ↓
5. 检查 AskForApproval 是否允许审批
   - Never → 拒绝
   - 其他 → 继续
  ↓
6. 运行权限请求钩子 (permission hooks)
   - Allow → 直接通过
   - Deny → 拒绝
  ↓
7. Guardian 审批或用户交互审批
   ↓
8. 决策结果:
   - Approved/ApprovedForSession → Allow (缓存到 session_approved_hosts)
   - NetworkPolicyAmendment(Allow) → 允许 + 持久化规则
   - NetworkPolicyAmendment(Deny) → 拒绝 + 持久化规则 + 缓存到 session_denied_hosts
   - Denied/Abort → Deny
   - TimedOut → Deny
```

### 5.3 网络规则持久化

**文件**: `core/src/network_policy_decision.rs`

用户选择 "Allow/Deny for session" 时，通过 `ExecPolicyManager::append_network_rule_and_update` 将网络规则持久化到 `.codex/rules/default.rules` 文件：

```rust
NetworkRuleProtocol::Http / Https / Socks5Tcp / Socks5Udp
Decision::Allow / Forbidden
```

**网络阻断理由分类**:

| reason | 含义 |
|-----------|------|
| `denied` | 域名被策略显式拒绝，无法从此提示批准 |
| `not_allowed` | 域名不在当前沙箱模式允许列表中 |
| `not_allowed_local` | 本地/私有网络地址被沙箱策略阻止 |
| `method_not_allowed` | 请求方法被当前网络模式阻止 |
| `proxy_disabled` | 网络代理被禁用 |

---

## 6. 进程安全

### 6.1 进程硬化 (pre_main_hardening)

**文件**: `process-hardening/src/lib.rs`

在 `main()` 之前（通过 `#[ctor::ctor]`）执行的进程硬化措施：

| 平台 | 措施 | 目的 |
|------|------|------|
| Linux/Android | `prctl(PR_SET_DUMPABLE, 0)` | 禁止 ptrace 附加和核心转储 |
| Linux/Android | `setrlimit(RLIMIT_CORE, 0)` | 禁止 core dump |
| Linux/Android | 移除 `LD_*` 环境变量 | 防止 LD_PRELOAD 攻击 |
| macOS | `ptrace(PT_DENY_ATTACH)` | 禁止调试器附加 |
| macOS | `setrlimit(RLIMIT_CORE, 0)` | 禁止 core dump |
| macOS | 移除 `DYLD_*` 环境变量 | 防止 DYLD 注入 |
| macOS | 移除 `MallocStackLogging*` / `MallocLogFile` | 防止调试信息泄露 |
| FreeBSD/OpenBSD | `setrlimit(RLIMIT_CORE, 0)` | 禁止 core dump |
| FreeBSD/OpenBSD | 移除 `LD_*` 环境变量 | 防止动态链接器注入 |
| Windows | (待实现) | — |

**关键设计**: 使用 `exit()` 而非 `panic!()` 处理硬化失败，因为这是在 `main()` 前执行，panic handler 尚未安装。

### 6.2 命令规范化

**文件**: `core/src/command_canonicalization.rs`

为了使审批缓存键跨会话稳定，命令在被审批前会经过规范化：

1. **Shell 脚本解析**:
   - `bash -lc "简单命令"` → 解析为词法单元 (`cargo`, `test`, `-p`, `codex-core`)
   - `bash/zsh -lc "heredoc 脚本"` → 规范化为 `__codex_shell_script__` + 模式 + 脚本原文
   - `powershell -Command "脚本"` → 规范化为 `__codex_powershell_script__` + 脚本原文

2. **路径无关性**: `/bin/bash -lc "cmd"` 等价于 `bash -lc "cmd"`

### 6.3 Shell 提权服务

**文件**: `shell-escalation/src/unix/`

Shell 提权 (Escalation) 是 Unix 系统上用于在沙箱外执行需要更高权限命令的机制：

```rust
trait EscalationPolicy {
    async fn determine_action(
        &self,
        file: &AbsolutePathBuf,    // 可执行文件路径
        argv: &[String],           // 命令参数
        workdir: &AbsolutePathBuf,  // 工作目录
    ) -> Result<EscalationDecision>
}
```

**核心枚举**:

- `EscalationDecision` — 提权决策（允许/拒绝/委托）
- `EscalationPermissions` — 提权权限描述
- `EscalationPolicy` — 提权策略接口
- `EscalationSession` — 管理提权会话（Unix socket 通信）
- `ExecParams` / `ExecResult` — 执行参数和结果
- `PreparedExec` — 预备执行的命令

**通信**: 通过 Unix domain socket (`ESCALATE_SOCKET_ENV_VAR`) 进行客户端-服务器通信，Codex 主进程作为服务器，沙箱内进程通过 socket 请求提权。

---

## 7. 安全路径：从用户命令到沙箱执行

以下是用户发起命令的完整安全路径：

```
1. 用户输入命令 → LLM 生成工具调用 (Bash 工具)
   │
2. 命令规范化 (canonicalize_command_for_approval)
   │  - bash/zsh -lc 脚本解析
   │  - 路径标准化
   │
3. 执行策略检查 (ExecPolicyManager::create_exec_approval_requirement_for_command)
   │  ├─ 加载规则文件 (rules/*.rules)
   │  ├─ 解析命令 (commands_for_exec_policy)
   │  ├─ 逐命令匹配 (Policy::check_multiple)
   │  │  ├─ 前缀规则匹配
   │  │  ├─ 主机可执行文件匹配
   │  │  └─ 启发式回退
   │  └─ 综合决策
   │     ├─ Forbidden → 拒绝
   │     ├─ Prompt  → AskForApproval 检查
   │     └─ Allow   → 继续执行
   │
4. 沙箱权限选择 (SandboxablePreference: Auto/Require/Forbid)
   │
5. 沙箱策略计算 (EffectiveSandboxPermissions)
   │  - 合并 base policy + additional_permissions
   │  - 计算有效文件系统策略
   │  - 计算有效网络策略
   │
6. 补丁安全检查 (assess_patch_safety) — 仅文件编辑操作
   │  - 验证补丁目标路径在可写范围内
   │  - 根据审批模式决定结果
   │
7. 审批请求 (如需用户确认)
   │  - 执行策略提示 → 用户确认
   │  - 网络审批 → 用户确认
   │  - 权限请求钩子 → 自动化确认
   │
8. 沙箱命令变换 (SandboxManager::transform)
   │  ├─ None → 原始命令
   │  ├─ macOS → sandbox-exec [seatbelt 策略] -- command
   │  ├─ Linux → codex-linux-sandbox [策略参数] -- command
   │  └─ Windows → 原始命令（令牌限制在进程创建时应用）
   │
9. 进程创建与执行
   │  ├─ 环境变量设置 (CODEX_SANDBOX_NETWORK_DISABLED=1, CODEX_SANDBOX=seatbelt)
   │  ├─ 网络代理配置（如有）
   │  └─ 进程硬化 (pre_main_hardening) — Codex 自身进程
   │
10. 沙箱内执行
   │  ├─ macOS: Seatbelt 策略强制
   │  ├─ Linux: Landlock + seccomp + bubblewrap
   │  └─ Windows: 限制令牌 + ACL
   │
11. 网络访问拦截（运行时）
   │  ├─ 代理拦截请求
   │  ├─ 域名/协议匹配 (execpolicy network_rules)
   │  ├─ 审批缓存检查
   │  └─ 用户确认（首次）
   │
12. 执行结果收集与报告
```

---

## 8. 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户输入 / LLM 输出                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                     命令规范化层                                     │
│  canonicalize_command_for_approval()                                │
│  ├─ Shell 脚本解析 (bash/zsh -lc)                                  │
│  ├─ PowerShell 脚本规范化                                           │
│  └─ 路径标准化                                                      │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    执行策略引擎层                                    │
│  ExecPolicyManager                                                  │
│  ├─ 规则加载 (rules/*.rules, Starlark DSL)                        │
│  ├─ 多层策略叠加 (System < User < Project < Requirements)          │
│  ├─ 前缀匹配 + 主机可执行文件解析                                   │
│  ├─ 启发式回退 (is_known_safe_command / command_might_be_dangerous)│
│  └─ 自动修正建议 (BANNED_PREFIX_SUGGESTIONS 过滤)                 │
└────────────────────────────┬────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
   ┌──────────▼──────────┐      ┌──────────▼──────────┐
   │  文件操作安全检查     │      │  命令执行安全检查     │
   │  assess_patch_safety │      │  ExecApprovalReq     │
   │  ├─ 路径约束验证    │      │  ├─ AskForApproval   │
   │  └─ 审批模式决策    │      │  └─ sandbox bypass    │
   └──────────┬──────────┘      └──────────┬──────────┘
              │                             │
              └──────────────┬──────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                   沙箱策略计算层                                    │
│  EffectiveSandboxPermissions                                        │
│  ├─ 合并 SandboxPolicy + PermissionProfile                        │
│  ├─ 计算 effective FileSystemSandboxPolicy                          │
│  ├─ 计算 effective NetworkSandboxPolicy                             │
│  └─ should_require_platform_sandbox() 判定                         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                   沙箱命令变换层                                    │
│  SandboxManager::transform()                                        │
│  ├─ macOS:  → /usr/bin/sandbox-exec [Seatbelt 策略] -- command    │
│  ├─ Linux:  → codex-linux-sandbox [策略JSON] -- command            │
│  └─ Windows: → 原始命令 (令牌限制在进程创建时应用)                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
   ┌──────────▼──┐  ┌───────▼──────┐  ┌───▼───────────────┐
   │ macOS Seatbelt│  │Linux Seccomp │  │Windows Restricted │
   │              │  │              │  │    Token          │
   │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────────┐ │
   │ │.sbpl 模板│ │  │ │Landlock   │ │  │ │受限令牌创建  │ │
   │ ├──────────┤ │  │ ├──────────┤ │  │ ├──────────────┤ │
   │ │网络代理  │ │  │ │seccomp-bpf│ │  │ │ACE/DACL管理  │ │
   │ ├──────────┤ │  │ ├──────────┤ │  │ ├──────────────┤ │
   │ │文件系统  │ │  │ │bubblewrap │ │  │ │进程创建      │ │
   │ │规则生成  │ │  │ │bind mount │ │  │ │(受限令牌)    │ │
   │ └──────────┘ │  │ └──────────┘ │  │ └──────────────┘ │
   └──────────────┘  └──────────────┘  └──────────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                   网络策略执行层                                    │
│  NetworkApprovalService                                            │
│  ├─ 网络代理拦截所有连接请求                                       │
│  ├─ 域名级审批（按 host:port:protocol 缓存）                      │
│  ├─ 策略规则检查 (execpolicy network_rules)                       │
│  ├─ 环境变量阻断 (CODEX_SANDBOX_NETWORK_DISABLED=1)               │
│  └─ 运行时审批持久化 (append_network_rule)                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                   进程硬化层                                        │
│  pre_main_hardening() (#[ctor::ctor])                               │
│  ├─ 禁止 ptrace/dumpable (Linux, macOS)                            │
│  ├─ 禁止 core dump (RLIMIT_CORE=0)                                │
│  ├─ 清除 LD_*/DYLD_* 环境变量                                     │
│  └─ 清除 MallocStackLogging/MallocLogFile 环境变量                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

*分析完成。本文档基于 `codex-rs/` crate 源码深度审阅生成，涵盖了沙箱架构、权限系统、执行策略、网络策略及进程安全的完整技术细节。*