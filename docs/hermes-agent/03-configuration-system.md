---
title: "Step 3: 配置体系"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/03-configuration-system/
---

# Hermes-Agent 配置体系深度分析

## 1. 概述

Hermes-Agent 的配置体系是一个**多源、分层、Profile 隔离**的系统，由以下核心部分组成：

- **硬编码默认值**（`DEFAULT_CONFIG`，`hermes_cli/config.py`）
- **用户 YAML 配置**（`~/.hermes/config.yaml`）
- **环境变量文件**（`~/.hermes/.env`）
- **Shell 环境变量**（`os.environ`）
- **Profile 系统**（`HERMES_HOME` 环境变量驱动的多实例隔离）

配置加载分为**三条独立路径**，服务于不同运行模式（CLI / Gateway / 直接 import）：

| 入口 | 配置加载函数 | 位置 |
|------|------------|------|
| CLI 交互模式 | `load_cli_config()` | `cli.py:192` |
| Gateway 消息平台 | 直接 YAML 加载 + env 桥接 | `gateway/run.py:92-184` |
| 通用工具/子命令 | `load_config()` | `hermes_cli/config.py:2678` |

---

## 2. 配置层次图

```
┌──────────────────────────────────────────────────────────────────┐
│                      优先级 (低 → 高)                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① DEFAULT_CONFIG (硬编码默认值)                                  │
│     hermes_cli/config.py:341-781                                 │
│     ↓                                                            │
│  ② ~/.hermes/config.yaml (用户配置)                              │
│     deep_merge 覆盖 ① 的对应键                                   │
│     ↓                                                            │
│  ③ config → env 桥接层                                           │
│     cli.py:426-470 / gateway/run.py:107-143                     │
│     YAML 中的 terminal/auxiliary 值写入 os.environ              │
│     ↓                                                            │
│  ④ ~/.hermes/.env (用户密钥文件)                                 │
│     hermes_cli/env_loader.py:92-123                              │
│     override=True 会覆盖 ③ 中已设的同名环境变量                   │
│     ↓                                                            │
│  ⑤ Shell 环境变量 (os.environ 已有值)                            │
│     部分桥接逻辑对顶层值只填充不覆盖 (not in os.environ)          │
│     ↓                                                            │
│  ⑥ CLI 参数 / --yolo / --model 等                               │
│     运行时直接覆盖特定键值                                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**关键规则**：
- `.env` 文件使用 `override=True`（覆盖 shell 环境变量），这是有意为之——确保重启后 `.env` 中的值胜过 stale 的 shell export。
- Gateway 的桥接逻辑中顶层简单值**仅填充未设置的**环境变量（`_key not in os.environ`），但 terminal 嵌套值**直接覆盖**（config.yaml 是文档化的配置入口）。
- CLI 的 `load_cli_config()` 先读 `.env`，再做 config→env 桥接——**顺序与 Gateway 相反**，存在潜在不一致。

---

## 3. 各配置源详解

### 3.1 DEFAULT_CONFIG — 硬编码默认值

**位置**: `hermes_cli/config.py:341-781`

**当前版本**: `_config_version: 18`

**完整结构** (顶级键):

```
model                  # "" (空 = 未选择)
providers              # {} (v12+ 的 dict 格式自定义供应商)
fallback_providers     # [] 
credential_pool_strategies  # {}
toolsets               # ["hermes-cli"]
agent                  # {max_turns:90, gateway_timeout:1800, ...}
terminal               # {backend:"local", cwd:".", timeout:180, ...}
browser                # {inactivity_timeout:120, ...}
checkpoints            # {enabled:True, max_snapshots:50}
file_read_max_chars    # 100_000
compression            # {enabled:True, threshold:0.50, ...}
bedrock                # {region:"", discovery:{...}, guardrail:{...}}
smart_model_routing    # {enabled:False, ...}
auxiliary              # {vision:{}, web_extract:{}, compression:{}, ...}
display                # {compact:False, personality:"kawaii", skin:"default", ...}
dashboard              # {theme:"default"}
privacy                # {redact_pii:False}
tts                    # {provider:"edge", edge:{...}, elevenlabs:{...}, ...}
stt                    # {enabled:True, provider:"local", ...}
voice                  # {record_key:"ctrl+b", ...}
human_delay            # {mode:"off", ...}
context                # {engine:"compressor"}
memory                 # {memory_enabled:True, ...}
delegation             # {model:"", provider:"", max_iterations:50, ...}
prefill_messages_file  # ""
skills                 # {external_dirs:[]}
honcho                 # {}
timezone               # ""
discord                # {require_mention:True, ...}
whatsapp               # {}
telegram               # {channel_prompts:{}}
slack                  # {channel_prompts:{}}
mattermost             # {channel_prompts:{}}
approvals              # {mode:"manual", timeout:60}
command_allowlist      # []
quick_commands         # {}
personalities          # {}
security               # {redact_secrets:True, tirith_enabled:True, ...}
cron                   # {wrap_response:True}
logging                # {level:"INFO", max_size_mb:5, backup_count:3}
network                # {force_ipv4:False}
_config_version        # 18
```

**设计特点**:
- 采用**扁平 dict 嵌套**结构，最深 3 层（如 `bedrock.guardrail.guardrail_identifier`）
- 数值型默认值直接内联，没有 magic number
- `_config_version` 参与迁移检测，**不是**用户可配置项

### 3.2 OPTIONAL_ENV_VARS — 环境变量分类体系

**位置**: `hermes_cli/config.py:805-1670`

**分类**:

| 类别 | 数量 | 用途 | 示例 |
|------|------|------|------|
| `provider` | ~50 | LLM 供应商凭据与 URL | `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` |
| `tool` | ~20 | 工具 API 密钥 | `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY` |
| `messaging` | ~40 | 消息平台凭据 | `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN` |
| `setting` | ~6 | 运行时行为 | `SUDO_PASSWORD`, `HERMES_MAX_ITERATIONS` |

**元数据字段**:

```python
"VAR_NAME": {
    "description": str,     # 人类可读描述
    "prompt": str,          # setup 向导中的提示文本
    "url": str | None,      # 获取密钥的 URL
    "password": bool,        # True = getpass 输入（不回显）
    "tools": list[str],     # 该密钥启用的工具名列表
    "category": str,         # provider / tool / messaging / setting
    "advanced": bool,        # True = 高级选项，不主动提示配置
}
```

**补充**: `_EXTRA_ENV_VARS` (`config.py:31-56`) 是一组不通过 `OPTIONAL_ENV_VARS` 管理的环境变量名，由 setup/provider 流程直接写入 `.env`，包含平台特定配置（如 `SIGNAL_ACCOUNT`、`WEIXIN_TOKEN` 等 ~50 个）。

### 3.3 Config 迁移机制

**核心变量**: `_config_version`，当前值 `18`

**迁移函数**: `migrate_config()` (`config.py:2143-2570`)

**机制**:

1. `check_config_version()` 读取用户的 `_config_version` 与 `DEFAULT_CONFIG` 中的最新值
2. 逐版本遍历缺失字段，执行特定迁移逻辑
3. 版本迁移是无条件的——只要 `current_ver < target_ver`，对应迁移代码就会运行

**已实现的迁移路径**:

| 版本 | 迁移内容 |
|------|---------|
| <4 | `HERMES_TOOL_PROGRESS` .env → config.yaml `display.tool_progress` |
| <5 | 添加 `timezone` 字段 |
| <9 | 清除废弃的 `ANTHROPIC_TOKEN` |
| <12 | `custom_providers` 列表 → `providers` dict 格式 |
| <13 | 清除废弃的 `LLM_MODEL`/`OPENAI_MODEL` |
| <14 | 扁平 `stt.model` → provider 特定的嵌套配置 |
| <15 | 添加 `display.interim_assistant_messages` |
| <16 | `display.tool_progress_overrides` → `display.platforms` |
| <17 | `compression.summary_*` → `auxiliary.compression` |

**缺失字段自动填充**: `get_missing_config_fields()` 递归遍历 `DEFAULT_CONFIG`，将用户配置中缺失的键自动补齐并保存。

**风险点**:
- 迁移代码使用 `read_raw_config()`（无默认值合并）和 `load_config()`（有默认值合并）混合操作，语义不一致
- 版本 12 的迁移**删除了** `custom_providers` 列表（`config.pop("custom_providers", None)`），但运行时通过 `get_compatible_custom_providers()` 兼容读取——此迁移不可逆

### 3.4 load_config() — 通用配置加载

**位置**: `hermes_cli/config.py:2678-2702`

```python
def load_config() -> Dict[str, Any]:
    ensure_hermes_home()
    config_path = get_config_path()
    config = copy.deepcopy(DEFAULT_CONFIG)
    if config_path.exists():
        user_config = yaml.safe_load(f) or {}
        # 处理 legacy root-level max_turns
        config = _deep_merge(config, user_config)
    return _expand_env_vars(_normalize_root_model_keys(_normalize_max_turns_config(config)))
```

**处理管线**:

```
DEFAULT_CONFIG (deep copy)
  ↓ _deep_merge(user_config)
合并后配置
  ↓ _normalize_root_model_keys()    ← 迁移 root-level provider/base_url → model.*
  ↓ _normalize_max_turns_config()   ← 迁移 root-level max_turns → agent.max_turns
  ↓ _expand_env_vars()              ← 展开所有 ${VAR} 引用
最终配置
```

**与之配套的低开销函数**: `read_raw_config()` (`config.py:2660-2675`)——直接读取 YAML，不做合并/迁移/展开，用于迁移代码内部和"只需一个值"的场景。

### 3.5 hermes_constants.py — 核心常量与 Profile 系统

**位置**: `hermes_constants.py` (294 行)

**核心函数**:

| 函数 | 行号 | 用途 |
|------|------|------|
| `get_hermes_home()` | 11-17 | 单一真相源——读取 `HERMES_HOME` 环境变量，默认 `~/.hermes` |
| `display_hermes_home()` | 94-111 | 用户友好的显示路径（`~/` 前缀），Profile 模式下显示 `~/.hermes/profiles/<name>` |
| `get_default_hermes_root()` | 20-56 | Profile 全局根目录——用于 `profile list` 等跨 Profile 操作 |
| `get_subprocess_home()` | 114-137 | 子进程 HOME 目录——存在 `{HERMES_HOME}/home/` 时返回该路径 |
| `get_optional_skills_dir()` | 59-70 | 可选技能目录，支持 `HERMES_OPTIONAL_SKILLS` 覆盖 |
| `get_hermes_dir()` | 73-91 | 带向后兼容的子目录解析（新路径优先，旧路径存在时保持） |
| `is_termux()` | 161-168 | Termux 环境检测 |
| `is_wsl()` | 174-189 | WSL 环境检测（缓存结果） |
| `is_container()` | 195-220 | 容器环境检测（缓存结果） |
| `apply_ipv4_preference()` | 249-288 | 强制 IPv4 的 socket monkey-patch |

**模块级常量**:

```
OPENROUTER_BASE_URL  = "https://openrouter.ai/api/v1"
OPENROUTER_MODELS_URL = f"{OPENROUTER_BASE_URL}/models"
AI_GATEWAY_BASE_URL  = "https://ai-gateway.vercel.sh/v1"
VALID_REASONING_EFFORTS = ("minimal", "low", "medium", "high", "xhigh")
```

**Profile 系统流程** (`hermes_cli/main.py:83-137`):

```
_apply_profile_override():
  1. 解析 --profile/-p 命令行参数
  2. 无参数时读取 ~/.hermes/active_profile 文件
  3. 调用 resolve_profile_env(name) 解析为路径
  4. 设置 os.environ["HERMES_HOME"] = 路径
  5. 从 sys.argv 中剥离 --profile 参数
  ⚠ 必须在任何 hermes 模块导入之前执行
```

### 3.6 load_cli_config() — CLI 配置加载

**位置**: `cli.py:192-470`

**此函数是 CLI 交互模式的**独立**配置路径，与 `load_config()` 不同**:

```python
def load_cli_config() -> Dict[str, Any]:
    # 1. 硬编码 defaults dict（与 DEFAULT_CONFIG 不同！）
    defaults = {
        "model": {"default": "", "base_url": "", "provider": "auto"},
        "terminal": {"env_type": "local", "cwd": ".", ...},
        "agent": {"max_turns": 90, "personalities": {...}, ...},
        ...
    }
    
    # 2. 选择配置文件: user_config 存在则用它，否则 cli-config.yaml
    if user_config_path.exists():
        config_path = user_config_path
    else:
        config_path = project_config_path
    
    # 3. 浅合并: file_config dict 键覆盖 defaults dict 键
    #    model 键特殊处理（支持 string 和 dict 两种格式）
    
    # 4. _expand_env_vars() 展开 ${VAR} 引用
    
    # 5. config → env 桥接: terminal/auxiliary 值写入 os.environ
```

**与 `load_config()` 的关键差异**:

| 维度 | `load_cli_config()` | `load_config()` |
|------|---------------------|-----------------|
| 默认值来源 | 内联 `defaults` dict | `DEFAULT_CONFIG` 全局常量 |
| 合并策略 | 浅合并（dict 键覆盖） | `_deep_merge`（递归合并） |
| model 解析 | string/dict 双格式 | dict 为主 |
| personalities | 内联 12 种预设 | 空 dict `{}` |
| terminal.cwd | 运行时解析 `.` → `os.getcwd()` | 保持 `.` 不变 |
| env 桥接 | 包含详尽的 config→env 映射 | 不做 |
| normalize | 无 `_normalize_*` | 有 |

### 3.7 Gateway 配置加载

**位置**: `gateway/run.py:92-184`

Gateway **不走 `load_config()` 或 `load_cli_config()`**，而是直接读取 YAML 并桥接到环境变量：

```python
_config_path = _hermes_home / 'config.yaml'
_cfg = _yaml.safe_load(_f) or {}
_cfg = _expand_env_vars(_cfg)

# 顶层简单值: 仅填充未设置的 env var
for _key, _val in _cfg.items():
    if isinstance(_val, (str, int, float, bool)) and _key not in os.environ:
        os.environ[_key] = str(_val)

# Terminal: 直接覆盖 env var (config.yaml 是权威来源)
_terminal_env_map = {"backend": "TERMINAL_ENV", "cwd": "TERMINAL_CWD", ...}
for _cfg_key, _env_var in _terminal_env_map.items():
    if _cfg_key in _terminal_cfg:
        os.environ[_env_var] = str(_val)

# Auxiliary: 非 "auto" 的 provider/model/base_url/api_key 写入 env
```

**与 CLI 的差异**:
- Gateway **没有 `DEFAULT_CONFIG` 合并**——只读用户 YAML，缺失键不会回退到默认值
- 桥接策略不同：顶层值是"仅填充"（`not in os.environ`），terminal/auxiliary 是"强制覆盖"
- Gateway 先加载 `.env`（`load_hermes_dotenv`），然后 YAML 桥接覆盖——**config.yaml 覆盖 .env 中的 terminal 值**
- CLI 先做 config→env 桥接，但 `.env` 在更早的 `main.py:144` 已加载

---

## 4. .env 加载机制

### 4.1 加载流程

**核心函数**: `load_hermes_dotenv()` (`hermes_cli/env_loader.py:92-123`)

```
1. user_env = {HERMES_HOME}/.env
2. project_env = 入口调用者传入的项目根 .env

加载顺序:
  a. _sanitize_env_file_if_needed(user_env)     ← 修复损坏行
  b. load_dotenv(user_env, override=True)        ← 覆盖 shell 环境变量
  c. 如果 user_env 存在:
       load_dotenv(project_env, override=False)  ← 仅填充缺失值
     否则:
       load_dotenv(project_env, override=True)   ← 覆盖 shell

3. _sanitize_loaded_credentials()               ← 清理非 ASCII 凭据
```

### 4.2 调用点

| 入口 | 调用位置 | 参数 |
|------|---------|------|
| `hermes_cli/main.py` | 行 143-144 | `project_env=PROJECT_ROOT/.env` |
| `cli.py` | 行 74-78 | `hermes_home=_hermes_home, project_env=_project_env` |
| `gateway/run.py` | 行 86-88 | `hermes_home=_hermes_home, project_env=gateway/.../.env` |
| `run_agent.py` | 行 50-54 | `hermes_home=_hermes_home, project_env=_project_env` |
| `rl_cli.py` | 行 35-37 | 同上 |
| `acp_adapter/entry.py` | 行 45-48 | `hermes_home=hermes_home` (无 project_env) |

### 4.3 .env vs YAML 优先级

**CLI 模式下的优先级链**:

```
① DEFAULT_CONFIG (最低)
② config.yaml (deep_merge 覆盖 ①)
③ config.yaml → env 桥接 (terminal/auxiliary 值写入 os.environ)
④ .env (override=True 覆盖 ③ 中已设的 terminal_* 变量!)  ← ⚠ 潜在问题
⑤ shell 环境变量 (在 .env 之前已存在，被 .env override=True 覆盖)
⑥ CLI 参数 (最高)
```

**Gateway 模式下的优先级链**:

```
① .env (override=True 覆盖 shell)
② config.yaml → env 桥接 (terminal 等**覆盖** .env)  ← 与 CLI 顺序相反
③ shell (已被 .env 覆盖)
```

**关键差异**: Gateway 中 config.yaml 的 terminal 值**覆盖** .env 中的 `TERMINAL_*` 变量；CLI 中 .env 的 `TERMINAL_*` 值**覆盖** config.yaml 桥接的值。

### 4.4 Profile 下的 .env 处理

Profile 通过 `HERMES_HOME` 环境变量隔离——每个 Profile 的 `get_hermes_home()` 返回不同的路径：

```
~/.hermes/.env                          ← 默认 Profile
~/.hermes/profiles/coder/.env           ← coder Profile
~/.hermes/profiles/research/.env        ← research Profile
```

`load_hermes_dotenv()` 通过 `home_path = Path(hermes_home or os.getenv("HERMES_HOME", ...))` 自动感知 Profile。`save_env_value()` 和 `load_env()` 都通过 `get_env_path()` → `get_hermes_home()` 定位文件，天然 Profile 安全。

---

## 5. 配置优先级完整图

```
                    ┌─────────────────────────────────┐
                    │           来源                    │  优先级 (低→高)
                    ├─────────────────────────────────┤
                    │  ①  DEFAULT_CONFIG 硬编码         │  最低
                    │      hermes_cli/config.py:341    │
                    ├─────────────────────────────────┤
                    │  ②  config.yaml 用户值            │
                    │      deep_merge 递归覆盖 ①       │
                    ├─────────────────────────────────┤
                    │  ③  ${VAR} 展开                   │
                    │      config 值中的 ${VAR} 引用     │
                    │      在 merge 后展开              │
                    ├─────────────────────────────────┤
                    │  ④  .env 文件                     │  ← ⚠ override=True
                    │      覆盖同名 shell 环境变量      │
                    ├─────────────────────────────────┤
                    │  ⑤  shell 环境变量 (非 .env 来源)  │
                    │      仅在 .env 未设置时生效       │
                    ├─────────────────────────────────┤
                    │  ⑥  config→env 桥接              │  ← ⚠ 行为不一致
                    │      CLI: .env 之后，可能被覆盖    │
                    │      Gateway: .env 之后，覆盖 .env │
                    ├─────────────────────────────────┤
                    │  ⑦  CLI 参数                      │  最高
                    │      --model, --toolsets, --yolo  │
                    └─────────────────────────────────┘
```

---

## 6. 代码质量评估

### 6.1 问题与风险点

| # | 级别 | 位置 | 描述 |
|---|------|------|------|
| R1 | **高** | CLI vs Gateway | `load_cli_config()` 与 `load_config()` 有**独立的默认值定义**（12 种 personalities 只在 CLI `defaults` 中），同一个键可能有不同默认值 |
| R2 | **高** | Gateway `run.py` | Gateway 不走 `DEFAULT_CONFIG` 合并——缺失的 YAML 键**不会回退到默认值**（如 `compression.enabled` 未设置时，Gateway 读 None 而非 True） |
| R3 | **中** | .env 桥接顺序 | CLI 模式下 `.env` 在 config→env 桥接**之后**加载（`main.py:144` 在桥接之前），但 `cli.py:load_cli_config()` 的桥接在 `.env` **之后**——若 `cli.py` 被 gateway import，桥接的 cwd 覆盖可能失效 |
| R4 | **中** | `_deep_merge` | `load_config()` 使用递归合并，但 **list 值是完整替换**而非追加——用户配置的 `toolsets: ["extra"]` 会替换默认的 `["hermes-cli"]` 而非合并 |
| R5 | **中** | 迁移代码 | `migrate_config()` 中混用 `load_config()`（有默认值）和 `read_raw_config()`（无默认值），版本 14→16 的迁移逻辑依赖原始写入检测，但其他版本用合并后配置 |
| R6 | **低** | `_EXTRA_ENV_KEYS` | 约 50 个环境变量名硬编码在 frozenset 中，需要人工维护与 `.env` 实际使用的变量同步 |
| R7 | **低** | `load_cli_config()` | 存在 `cli-config.yaml` 回退路径（项目目录），但此文件从未被 setup 创建，实际为死代码 |
| R8 | **中** | Gateway env 桥接 | `gateway/run.py:103` 对顶层简单值使用 `not in os.environ` 守卫，但 `.env` 加载在桥接之前——这意味着 `.env` 中的值会阻止 config.yaml 的顶层值被桥接 |

### 6.2 架构优点

1. **Profile 隔离完备**: `get_hermes_home()` 全局单一定义，119+ 处引用全部走此函数
2. **.env 健壮性**: `_sanitize_env_lines()` 处理连接行损坏、非 ASCII 凭据清理、Windows 编码兼容
3. **原子写入**: `save_config()` 和 `save_env_value()` 使用 `tempfile.mkstemp` + `os.replace` 保证文件不被半写截断
4. **深层合并**: `_deep_merge()` 保持用户只覆盖子键时，其他子键保留默认值
5. **向后兼容**: 迁移路径清晰，每版本独立测试（`tests/hermes_cli/test_config.py` 中 18 个版本覆盖测试）
6. **结构验证**: `validate_config_structure()` 能检测常见的 YAML 格式错误（custom_providers 误写为 dict 等）

---

## 7. 改进建议

### 7.1 统一默认值定义 (Priority: High)

**问题**: `load_cli_config()` 中内联的 `defaults` dict 与 `DEFAULT_CONFIG` 分叉。

**建议**: 废弃 `load_cli_config()` 中的内联默认值，统一使用 `load_config()` + CLI 特定的后处理（如 personalities 注入、cwd 解析）。将 personalities 默认集移入 `DEFAULT_CONFIG.personalities`。

### 7.2 Gateway 使用 load_config() (Priority: High)

**问题**: Gateway 直接读 YAML 不合并默认值，缺失键返回 None。

**建议**: Gateway 启动时调用 `load_config()` 获取完整合并配置，用其结果驱动桥接逻辑。若需保留"不写默认值回文件"的语义，桥接时检查 `read_raw_config()` 中是否显式设置。

### 7.3 统一 .env 与 config→env 桥接顺序 (Priority: Medium)

**问题**: CLI 和 Gateway 对 `.env` 与 config→env 桥接的先后顺序相反，导致 terminal 配置的优先级不同。

**建议**: 统一为先加载 `.env`，再做 config→env 桥接，且桥接始终使用 `os.environ[key] = value`（无条件覆盖）。在文档中明确声明"config.yaml 的 terminal 值覆盖 .env"。

### 7.4 列表合并策略 (Priority: Low)

**问题**: `_deep_merge` 对 list 是完整替换，`toolsets` 等配置无法追加。

**建议**: 引入 `_merge_list` 策略参数，默认为 `replace`，可选 `append`。对 `toolsets` 键使用 `append` 模式。

### 7.5 消除重复配置加载 (Priority: Low)

**问题**: `run_agent.py:50-54` 在模块级再次调用 `load_hermes_dotenv()`，与 `hermes_cli/main.py:144` 重复。

**建议**: 在 `load_hermes_dotenv()` 中添加幂等守卫（如检查 `_LOADED` 标志集），避免重复加载和覆盖。

### 7.6 迁移代码一致性 (Priority: Low)

**问题**: 混用 `load_config()` 和 `read_raw_config()`。

**建议**: 统一迁移代码使用 `read_raw_config()` 读原始配置、修改后 `save_config()` 写回——避免默认值混入迁移逻辑。