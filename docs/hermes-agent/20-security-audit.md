---
title: "Step 20: 安全审计"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/20-security-audit/
---

# 20. Security Audit — Hermes Agent

## Overview

This document presents a comprehensive security audit of the hermes-agent project, covering its security architecture, boundary analysis, policy evaluation, vulnerability findings (sorted by severity), and improvement recommendations.

---

## 1. Security Architecture Overview

Hermes Agent operates as a **single-tenant personal AI agent** — a trusted operator delegates commands to an LLM, which then executes tools on their behalf. The core trust model assumes one trusted human per deployment. Security controls are designed to protect the **operator from LLM-initiated actions**, not from co-tenant isolation.

### Trust Boundaries

```
┌──────────────────────────────────────────────────────────────┐
│                    TRUSTED OPERATOR                          │
│  (human via CLI / Telegram / Discord / Slack / etc.)        │
└─────────────┬────────────────────────────────────┬──────────┘
              │ Approval prompt                     │ Gateway auth
              │ (dangerous commands)                 │ (session key)
              ▼                                     ▼
┌──────────────────────────┐         ┌─────────────────────────┐
│   APPROVAL SYSTEM        │         │   GATEWAY LAYER         │
│   approval.py             │         │   session context,       │
│   tirith_security.py      │         │   platform adapters      │
└─────────────┬────────────┘         └────────────┬────────────┘
              │                                    │
              ▼                                    ▼
┌──────────────────────────────────────────────────────────────┐
│                     AGENT CORE                               │
│   run_agent.py → model_tools.py → tool registry → handlers   │
└──────┬──────────┬──────────┬──────────┬─────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
  ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────────────┐
  │Terminal │ │  Web   │ │ Browser│ │ Code Exec      │
  │local/   │ │ Search │ │Tool    │ │ Sandbox        │
  │docker/  │ │Extract │ │        │ │ (stripped env) │
  │ssh/modal│ │        │ │        │ │                │
  └─────────┘ └────────┘ └────────┘ └────────────────┘
       │          │          │
       ▼          ▼          ▼
  ┌──────────────────────────────────────────────────────┐
  │            SSRF / URL SAFETY LAYER                    │
  │   url_safety.py · website_policy.py                  │
  │   (blocks private IPs, redirect validation)           │
  └──────────────────────────────────────────────────────┘
```

### Key Security Modules

| Module | File | Purpose |
|--------|------|---------|
| Dangerous command detection | `tools/approval.py` | Regex pattern matching on terminal commands |
| Pre-exec security scanning | `tools/tirith_security.py` | External binary (Tirith) for content-level threats |
| Path traversal protection | `tools/path_security.py` | `validate_within_dir()` prevents `..` and symlink escapes |
| Credential file mounting | `tools/credential_files.py` | Sandbox-safe file passthrough with containment checks |
| SSRF protection | `tools/url_safety.py` | DNS resolution + private IP blocklist |
| Website blocklist | `tools/website_policy.py` | User-managed domain blocklist (config-driven) |
| OAuth credential storage | `hermes_cli/auth.py`, `agent/credential_pool.py` | Cross-process file locking, `chmod 600` on credential files |
| Google OAuth | `agent/google_oauth.py` | PKCE flow, atomic writes, cross-process lock |
| MCP environment filtering | `tools/mcp_tool.py` | `_build_safe_env()` strips host credentials |
| OSV malware check | `tools/osv_check.py` | Pre-launch malware scan for npx/uvx packages |
| Env var passthrough | `tools/env_passthrough.py` | Allowlist-only env vars to sandboxes |

---

## 2. Security Boundary Analysis

### 2.1 Command Execution Boundary (`tools/approval.py`)

**Strengths:**
- Comprehensive 37-pattern dangerous command detection (`DANGEROUS_PATTERNS`) covering `rm -rf`, `mkfs`, `dd`, SQL `DROP/DELETE`, `chmod 777`, fork bombs, pipe-to-shell, heredoc execution, git force push, etc.
- Unicode normalization (NFKC) and ANSI stripping to prevent obfuscation bypass
- Per-session approval state with `ContextVar` for gateway thread safety
- Smart approval via auxiliary LLM (`approvals.mode: smart`) for false-positive reduction
- Blocking gateway approval queue with timeout and activity heartbeats
- Combined guard pipeline (`check_all_command_guards`) merges tirith and dangerous pattern checks into a single approval prompt, preventing bypass where only one check is shown
- Container environments (docker, modal, daytona, singularity) skip approval — sandbox is the trust boundary

**Weaknesses:**
- **P1: Regex-based detection is inherently incomplete.** Creative command chaining, shell aliases, or encoding tricks can evade pattern matching. Example: `cmd1 && cmd2` where `cmd2` is dangerous but not individually caught, or base64-decoded commands (`echo bWtmcw== | base64 -d | sh`). The approval system acknowledges this by being a "guard rail, not a sandbox."
- **P2: YOLO mode (`HERMES_YOLO_MODE` / `/yolo`) bypasses all approval prompts.** While documented as break-glass, a gateway session with YOLO enabled removes all pre-exec guards. This is by design but represents a risk if YOLO is left enabled unintentionally.
- **P2: `approvals.mode: off` in config.yaml disables all approval prompts.** Same concern as YOLO — documented but risky.
- **P3: Smart approval delegates trust to an auxiliary LLM.** The `_smart_approve()` function sends the command to an LLM for risk assessment. A compromised or misconfigured auxiliary model could auto-approve genuinely dangerous commands or deny safe ones.

### 2.2 Tirith Security Scanner (`tools/tirith_security.py`)

**Strengths:**
- External binary (SHA-256 + optional cosign provenance verification) for defense-in-depth
- Auto-install with integrity verification from GitHub releases
- Fail-open/fail-closed configurable (`security.tirith_fail_open`)
- Disk-persisted failure markers to avoid repeated network attempts
- Background thread install to avoid blocking startup

**Weaknesses:**
- **P3: Fail-open default.** `tirith_fail_open` defaults to `True`, meaning if tirith is unavailable, commands proceed. This is a pragmatic tradeoff (availability over security) but could be misconfigured.
- **P3: Auto-download from GitHub.** While SHA-256 verified and cosign-optional, the auto-install downloads a binary from the internet. Supply-chain compromise of the tirith GitHub release assets would inject a malicious binary. The cosign provenance check mitigates this partially.

### 2.3 Path Traversal Protection (`tools/path_security.py`)

**Strengths:**
- `validate_within_dir()` uses `Path.resolve()` to follow symlinks and normalize `..`
- Used consistently by credential_files.py, skills, cron tools

**Weaknesses:**
- **P3: Limited scope.** Path validation is only applied to specific trust boundaries (credential files, skills directories, cron). File read/write tools (`file_tools.py`, `file_operations.py`) do not systematically apply path validation — the terminal tool's dangerous command approval is the primary guard for arbitrary file writes.

### 2.4 SSRF Protection (`tools/url_safety.py`)

**Strengths:**
- Comprehensive IP blocking: private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback, link-local, multicast, unspecified, CGNAT (100.64.0.0/10)
- Blocked hostnames (`metadata.google.internal`, `metadata.goog`)
- Fail-closed: DNS resolution failures block the request
- IPv6-mapped IPv4 addresses checked (`::ffff:127.0.0.1`)
- Applied to web_tools, vision_tools, browser_tool

**Known Limitations (documented in code):**
- **P1: DNS rebinding (TOCTOU).** An attacker-controlled DNS server with TTL=0 can return a public IP for the pre-flight check, then a private IP for the actual connection. The code explicitly acknowledges this cannot be fixed at the pre-flight level — would require connection-level validation (e.g., egress proxy like Smokescreen).
- **P2: Third-party SDK bypass.** Web tools that use Firecrawl/Tavily delegate URL resolution to their servers, bypassing `is_safe_url()`. The redirect validation only applies to direct HTTP client calls.

### 2.5 Website Policy (`tools/website_policy.py`)

**Strengths:**
- Config-driven blocklist with wildcard subdomain support
- Shared blocklist file support
- Fail-open on config errors (prevents config typos from breaking all web tools)
- Cache with 30s TTL to avoid repeated YAML parsing

**Weaknesses:**
- **P3: Fail-open configuration.** If the config file is malformed, all requests are allowed. This is pragmatic but could hide misconfiguration.

### 2.6 Credential Security

#### Auth Store (`hermes_cli/auth.py`)

**Strengths:**
- Cross-process file locking (`fcntl`/`msvcrt`) for auth.json reads and writes
- Atomic writes via `os.replace()` with `fsync` — prevents partial/corrupt writes
- `chmod 600` on credential files after write
- `_token_fingerprint()` uses SHA-256 truncated hash for telemetry (no raw token leakage)
- Placeholder detection (`has_usable_secret`) rejects `changeme`, `your_api_key`, etc.

**Weaknesses:**
- **P2: Qwen OAuth credentials in plaintext at `~/.qwen/oauth_creds.json`.** This file is written without `chmod 600` — it uses default umask permissions. The Hermes auth.json gets `chmod 600`, but Qwen credentials are stored in a Qwen-specific file with different permissions.
- **P3: No encryption at rest.** All credential files (auth.json, google_oauth.json) store tokens in plaintext JSON. An attacker with file read access can extract all tokens.

#### OAuth Flows

- **Nous Portal**: Device code flow, agent key minting with TTL
- **OpenAI Codex**: OAuth external flow, token rotation with sync from `~/.codex/auth.json`
- **Google Gemini**: PKCE flow with S256 challenge, cross-process deduplication of refreshes, atomic credential writes
- **Qwen**: Reads from Qwen CLI's credential file

**Weaknesses:**
- **P2: `_paste_mode_login()` in `google_oauth.py` displays auth URLs in the terminal.** If the terminal is shared or logged, the URL contains the `code_challenge` parameter. While PKCE prevents code reuse, the authorization code itself is exchanged over localhost HTTP (no TLS on the callback server).

#### Credential Pool (`agent/credential_pool.py`)

**Strengths:**
- Exhaustion tracking with cooldown (1 hour for 429, auto-clear)
- Multiple strategy support (fill_first, round_robin, random, least_used)
- Cross-process lock for concurrent access
- Sync from external credential files (Claude Code, Codex CLI) to detect stale tokens

**Weaknesses:**
- **P3: Race condition window during credential rotation.** The pool reads credential state, checks multiple sources, and writes back. Between read and write, another process could rotate the same credential. The file lock mitigates this but only for auth.json operations, not for external credential files (`.claude/.credentials.json`, `.codex/auth.json`).

### 2.7 MCP Security (`tools/mcp_tool.py`)

**Strengths:**
- `_build_safe_env()` strips all host credentials — only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, and `XDG_*` are passed through
- User-specified `env` in config.yaml explicitly added (operator-chosen risk)
- OSV malware check for npx/uvx packages before spawning
- Credential redaction in error messages via `_sanitize_error()`

**Weaknesses:**
- **P2: User-specified `env` variables in MCP config can inject secrets.** If an operator configures `mcp_servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN`, this value is passed directly to the subprocess. This is documented operator choice but could be a foot-gun if the config file is shared or version-controlled.
- **P3: Sampling support allows MCP servers to request LLM completions.** The sampling configuration (`sampling.enabled`, `sampling.max_tokens_cap`, `sampling.max_rpm`, `sampling.allowed_models`) provides rate limiting, but a malicious MCP server could still exfiltrate data through LLM prompts. The `max_tool_rounds` limit (default 5) and `log_level: "info"` help mitigate this.

### 2.8 Code Execution Sandbox (`tools/code_execution_tool.py`)

**Strengths:**
- API keys/tokens stripped from environment (skill-declared `required_environment_variables` and user-configured `terminal.env_passthrough` are the only exceptions)
- Child process accesses Hermes tools via RPC (Unix domain socket or file-based), not direct API calls
- Shell quotation helpers provided (`shlex.quote` via `shell_quote()`)
- Dangerous import blocking (`_DANGEROUS_IMPORTS` in sandbox header)

**Weaknesses:**
- **P2: Local (`terminal.backend: local`) backend runs code on the host with no isolation.** The `execute_code` tool runs as the same user with the same filesystem access. Environment stripping prevents accidental key leakage but does not prevent intentional data exfiltration (e.g., `open('.env').read()` via file read in the sandbox, or `socket` to exfiltrate).
- **P3: `_DANGEROUS_IMPORTS` can be bypassed with `importlib.import_module()` or `__import__()`.** The sandbox blocks direct `import subprocess` etc., but these can be circumvented through Python's dynamic import mechanisms.

### 2.9 Environment Variable Passthrough (`tools/env_passthrough.py`)

**Strengths:**
- ContextVar-backed to prevent cross-session data bleed in gateway
- Explicit allowlist only — no implicit passthrough
- Config-driven (`terminal.env_passthrough`) plus skill-declared vars

**Weaknesses:**
- **P3: Skill-declared `required_environment_variables` are trusted.** When a skill is installed, its frontmatter declarations are automatically registered. A malicious skill could declare `required_environment_variables: [ANTHROPIC_API_KEY]` and exfiltrate the key through the sandbox environment. The Skills Guard module provides some audit capability but doesn't block this.

---

## 3. Vulnerability Findings

### P0 — Critical

No P0 (actively exploitable with default configuration) vulnerabilities were found.

### P1 — High

| # | Finding | File(s) | Description |
|---|---------|---------|-------------|
| P1-1 | **DNS Rebinding SSRF** | `tools/url_safety.py` | Pre-flight DNS check → actual connection TOCTOU. Attacker-controlled DNS with TTL=0 returns public IP for check, private IP for connection. Documented but unfixable at pre-flight level. Requires connection-level validation (egress proxy). |
| P1-2 | **Regex Evasion in Command Detection** | `tools/approval.py` | Pattern-matching approach has inherent bypass vectors: obfuscated commands (`echo cm1kZnM= | base64 -d | sh`), shell aliases, command substitution nesting (`kill $(pgrep -f hermes)` is caught, but `eval "$(curl ...)"` may not be in all contexts). The agent has access to the terminal tool, which always has approval as a guard, but regex gaps exist. |
| P1-3 | **Smart Approval LLM Delegation** | `tools/approval.py:535-584` | The `_smart_approve()` function sends the command to an auxiliary LLM for risk assessment. A compromised auxiliary model, prompt injection via command content, or misconfiguration could auto-approve dangerous commands. The LLM prompt is not authenticated, and the response parsing (`"APPROVE" in answer`) is simplistic — a model returning "APPROVE (with concerns)" would still pass. |

### P2 — Medium

| # | Finding | File(s) | Description |
|---|---------|---------|-------------|
| P2-1 | **Third-party SDK SSRF Bypass** | `tools/web_tools.py` | Firecrawl and Tavily SDKs resolve URLs on their servers, bypassing `is_safe_url()`. Redirect validation for direct calls is present, but SDK-mediated requests are outside Hermes' SSRF boundary. |
| P2-2 | **Plaintext Credential Storage** | `hermes_cli/auth.py`, `agent/google_oauth.py` | All tokens stored as plaintext JSON. No encryption at rest. An attacker with file read access (or a tool that reads `~/.hermes/auth.json`) can extract all API keys and OAuth tokens. |
| P2-3 | **Qwen OAuth Credentials Without Restrictive Permissions** | `hermes_cli/auth.py:1127-1130` | `_save_qwen_cli_tokens()` writes to `~/.qwen/oauth_creds.json` without explicit `chmod 600`. While the Qwen CLI likely manages its own permissions, Hermes writes the file without restrictive permissions. |
| P2-4 | **Local Code Execution No Isolation** | `tools/code_execution_tool.py` | On `terminal.backend: local`, the `execute_code` sandbox strips env vars but runs as the same OS user with full filesystem access. A determined sandbox escape via Python `open()` is trivial. |
| P2-5 | **MCP Config Secret Injection** | `tools/mcp_tool.py:194-210` | User-specified `env` values in MCP server config are passed directly to subprocesses. If config.yaml is shared or version-controlled, secrets embedded there leak to MCP subprocesses. |
| P2-6 | **OAuth Callback Server on HTTP** | `agent/google_oauth.py:857-858` | The OAuth callback server listens on `http://127.0.0.1:8085` (HTTP, not HTTPS). The authorization code is transmitted over plaintext localhost. On multi-user machines, other local users could sniff the code. |
| P2-7 | **YOLO Mode Bypass** | `tools/approval.py:607-608` | `HERMES_YOLO_MODE` environment variable or `/yolo` command completely disables all approval prompts. If set unintentionally (e.g., in a shared environment, or persisted in `.env`), all command guards are bypassed. |
| P2-8 | **Credential File Read in Sandbox** | `tools/credential_files.py` | Credential files are mounted into remote sandbox containers. While path traversal is blocked, the files themselves are readable by code running inside the sandbox, allowing credential extraction if the sandbox is compromised. |
| P2-9 | **Skill Environment Variable Exfiltration** | `tools/env_passthrough.py` | Skill-declared `required_environment_variables` are automatically registered. A malicious skill could declare `ANTHROPIC_API_KEY` as required, causing it to be passed through to the code execution sandbox. |

### P3 — Low

| # | Finding | File(s) | Description |
|---|---------|---------|-------------|
| P3-1 | **Tirith Fail-Open Default** | `tools/tirith_security.py:76` | `tirith_fail_open` defaults to `True`. If tirith is unavailable, timeout, or crashes, commands proceed. This is pragmatic but reduces the security boundary to the regex patterns in `approval.py` only. |
| P3-2 | **Website Policy Fail-Open** | `tools/website_policy.py:258-259` | If `config.yaml` has a malformed `security.website_blocklist`, the policy module fails open (all requests allowed) rather than failing closed. |
| P3-3 | **No Credential Encryption at Rest** | `hermes_cli/auth.py`, `agent/credential_pool.py` | Tokens stored in plaintext JSON. No system keychain integration (keyring, macOS Keychain, etc.). |
| P3-4 | **Dynamic Import Bypass in Code Sandbox** | `tools/code_execution_tool.py` | `_DANGEROUS_IMPORTS` blocks direct imports but can be bypassed via `importlib.import_module('subprocess')` or `__import__('os')`. |
| P3-5 | **Tirith Auto-Install from GitHub** | `tools/tirith_security.py:281-385` | Binary auto-downloaded from GitHub releases. SHA-256 verified, optionally cosign-verified, but a compromised release pipeline could inject malicious code. |
| P3-6 | **Credential Pool Race Window** | `agent/credential_pool.py` | Between reading and writing credential state, another process (different Hermes profile) could rotate the same credential. The cross-process lock on auth.json mitigates most cases. |
| P3-7 | **Gateway Session Key Not Auth Boundary** | `SECURITY.md:24` | Session keys are for routing, not authorization. Any authorized caller on a gateway platform has equal trust. Multi-user isolation must happen at the OS/host level. |
| P3-8 | **Symlink Handling in Skills Dir** | `tools/credential_files.py:249-289` | `_safe_skills_path()` detects symlinks and creates a sanitized copy — good. However, `iter_skills_files()` skips symlinks entirely (does not follow them), which is safe but means skill scripts referencing symlinks won't work. |
| P3-9 | **Approval Timeout Configurable** | `tools/approval.py:527-532` | The approval timeout defaults to 60 seconds (CLI) and 300 seconds (gateway). These are configurable via `approvals.timeout` and `approvals.gateway_timeout` in config.yaml. A very short timeout could cause automatic denial of approvals. |
| P3-10 | **`yaml.safe_load` used correctly** | Multiple files | All YAML parsing uses `yaml.safe_load()` (verified — no `yaml.load()` without Loader). No unsafe deserialization risk. |
| P3-11 | **No `pickle` usage** | Project-wide grep | No `pickle.loads()` or `pickle.load()` calls found in the codebase. No deserialization vulnerability. |
| P3-12 | **SQL Injection Protected** | `hermes_state.py`, plugins | All SQL uses parameterized queries (`?` placeholders). No string-concatenated SQL found. |
| P3-13 | **`_SENITIVE_WRITE_TARGET` in approval.py** | `tools/approval.py:59-70` | Writes to `~/.ssh/` and `~/.hermes/.env` are detected as sensitive. `$HOME` and `$HERMES_HOME` shell expansions are matched, but only in lower-case. `$HOME` works because the check uses `.lower()`, but this is redundant since `$HOME` is lowercase by convention. |

---

## 4. Security Policy Assessment

### 4.1 `SECURITY.md` Review

The project's `SECURITY.md` provides a clear trust model and disclosure process. Key observations:

- **Single-tenant model is explicit** and well-documented. Multi-user isolation is explicitly out of scope.
- **Out-of-scope list is well-defined** — prompt injection (without approval bypass), configuration trade-offs, and trusted state access are clearly not considered vulnerabilities.
- **Deployment hardening guidelines** are present (container backends, file permissions, network exposure), though not enforced programmatically.
- **Missing from SECURITY.md:**
  - No mention of the tirith security scanner integration.
  - No mention of the OSV malware check for MCP packages.
  - No mention of the credential file permissions (`chmod 600` practice).
  - No mention of the `env_passthrough` allowlist mechanism.
  - No CVE/CVSS scoring guidance beyond "affected component + line range."

### 4.2 Approval System Architecture

The approval system is well-architected with multiple defense layers:

1. **Regex pattern matching** (37 patterns in `DANGEROUS_PATTERNS`)
2. **Tirith binary scan** (external, content-level threats like homograph URLs, pipe-to-interpreter)
3. **Combined guard pipeline** (`check_all_command_guards`) merges both checks into a single prompt
4. **Smart approval** (auxiliary LLM risk assessment)
5. **Permanent/session allowlisting** with config persistence
6. **Container skip** (docker, modal, daytona, singularity)

The bypass possibilities (P1-2, P1-3) are inherent to the regex+LLM approach and are acknowledged in the architecture — the approval system is a guard rail, not a sandbox.

### 4.3 Gateway-Specific Security

The gateway introduces additional considerations:

- **Session keys are routing identifiers, not auth tokens.** The `HERMES_SESSION_KEY` environment variable is used for approval routing, not authorization enforcement.
- **Platform tokens (Telegram, Discord, Slack) require `acquire_scoped_lock()`** to prevent two profiles from using the same bot token — this prevents cross-profile token conflicts.
- **Background process notifications** have configurable verbosity (`display.background_process_notifications: all/result/error/off`).
- **Gateway approval** uses a blocking queue (`_ApprovalEntry` + threading.Event) with 5-minute timeout and activity heartbeats to prevent watchdog kills.

---

## 5. Improvement Recommendations

### High Priority

1. **Implement connection-level SSRF validation.** The current pre-flight DNS check is vulnerable to DNS rebinding. Options:
   - Use an HTTP client that validates IP addresses at connection time (not just at DNS resolution time).
   - Deploy an egress proxy (like Stripe's Smokescreen) for production gateway instances.
   - Add a `httpx` event hook that re-validates IP addresses after any redirect (partially done in `vision_tools.py`).

2. **Harden smart approval LLM delegation.** At minimum:
   - Parse the LLM response more strictly — require exact `"APPROVE"`, `"DENY"`, or `"ESCALATE"` (not substring matching).
   - Add a rate limit on smart approvals per session to prevent bulk auto-approval.
   - Log all smart approval decisions to `~/.hermes/approval_audit.log`.

3. **Restrict Qwen credential file permissions.** Add `os.chmod(auth_path, stat.S_IRUSR | stat.S_IWUSR)` after writing `~/.qwen/oauth_creds.json`, consistent with the practice in `auth.py:708`.

### Medium Priority

4. **Add keychain integration for credential storage.** Use `keyring` library (or platform-native keychain) to store high-value tokens (OAuth refresh tokens, API keys) instead of plaintext JSON files. This would mitigate P2-2 and P3-3.

5. **Enforce container backend for gateway deployments.** When `HERMES_GATEWAY_SESSION` is set, warn if `terminal.backend` is `local`. Suggest `docker` or `modal` for untrusted workloads.

6. **Add skill environment variable audit.** When a skill declares `required_environment_variables`, cross-check against a deny list of known secrets (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.) and warn the user before passing them through. This mitigates P2-9.

7. **Use HTTPS for OAuth callback server.** Generate a self-signed TLS certificate for the localhost callback server, or use PKCE-only without a callback server (device code flow for headless environments, which is already implemented).

### Low Priority

8. **Default tirith to fail-closed.** Change `tirith_fail_open` default to `False` in production configs. Keep `True` as an explicit opt-in for development.

9. **Add an approval audit log.** Persist all approval decisions (approve/deny/smart-approved/yolo) with timestamp, session key, command hash, and outcome. This would help with post-incident analysis.

10. **Block dynamic imports in code sandbox.** Add `importlib` and `__import__` to `_DANGEROUS_IMPORTS` in the code execution sandbox, or use a more robust sandboxing mechanism (e.g., RestrictedPython) for enhanced isolation.

11. **Update SECURITY.md** to document:
    - Tirith integration and OSV malware checking
    - Credential file permissions practice
    - `env_passthrough` allowlist mechanism
    - Smart approval delegation to auxiliary LLM
    - DNS rebinding limitation and mitigation recommendations

---

## 6. Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| P0 (Critical) | 0 | — |
| P1 (High) | 3 | DNS rebinding SSRF, regex evasion, LLM delegation trust |
| P2 (Medium) | 9 | Plaintext credentials, no isolation on local, MCP config secrets, OAuth HTTP callback |
| P3 (Low) | 13 | Defaults, fail-open policies, race conditions, minor bypass vectors |

The project demonstrates **mature security engineering** for a personal AI agent:

- **Defense in depth** with multiple overlapping guards (regex patterns, external scanner, approval prompts, container isolation).
- **Consistent fail-closed** approach in URL safety and path security.
- **Well-structured credential management** with file locking, atomic writes, and permission enforcement.
- **Clear threat model** (single trusted operator, protection from LLM actions not from co-tenants).

The main areas for improvement are **SSRF connection-level validation** (the documented but unpatched DNS rebinding vulnerability), **credential encryption at rest**, and **stricter smart approval parsing**. These are the highest-impact improvements to pursue.