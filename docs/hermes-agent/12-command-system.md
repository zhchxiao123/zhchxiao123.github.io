---
title: "Step 12: 命令系统"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/12-command-system/
---

# 12. 命令系统

## 概述

Hermes Agent的命令系统围绕`CommandDef`数据类和`COMMAND_REGISTRY`单一真值源构建。所有命令定义、别名、网关门控、平台菜单都从注册表自动派生，确保CLI、Gateway各平台之间的一致性。

命令分发在CLI和Gateway中有两条独立路径，但共享命令解析和技能加载逻辑。终端回调系统（clarify、sudo、approval）桥接了工具层的同步接口到CLI的TUI异步UI。

---

## 关键流程

### 1. 命令注册表结构 (`hermes_cli/commands.py`)

```python
@dataclass(frozen=True)
class CommandDef:
    name: str                          # "background"
    description: str                   # "Run a prompt in the background"
    category: str                       # "Session"
    aliases: tuple[str, ...] = ()      # ("bg",)
    args_hint: str = ""                # "<prompt>"
    subcommands: tuple[str, ...] = ()  # ("connect", "disconnect", "status")
    cli_only: bool = False             # True = CLI专属
    gateway_only: bool = False         # True = Gateway专属
    gateway_config_gate: str | None = None  # "display.tool_progress_command"
```

**关键字段**：
- `gateway_config_gate`：当`cli_only=True`时，若此字段不为空，则读取config中对应的dotpath值；若真值，命令在Gateway也可用。这实现了`/verbose`命令在Gateway的条件可用性。

**注册表核心**：

```python
COMMAND_REGISTRY: list[CommandDef] = [
    CommandDef("new", "Start a new session", "Session", aliases=("reset",)),
    CommandDef("background", "Run a prompt in the background", "Session",
               aliases=("bg",), args_hint="<prompt>"),
    CommandDef("verbose", "Cycle tool progress display", "Configuration",
               cli_only=True, gateway_config_gate="display.tool_progress_command"),
    # ... 50+ more
]
```

**派生数据结构**（模块加载时计算）：

| 结构 | 来源 | 用途 |
|------|------|------|
| `_COMMAND_LOOKUP` | 所有name+aliases → CommandDef | `resolve_command()` |
| `COMMANDS` | 过滤gateway_only的扁平dict | CLI帮助/补全 |
| `COMMANDS_BY_CATEGORY` | 分类字典 | CLI帮助分类显示 |
| `SUBCOMMANDS` | 有subcommands的命令 | Tab补全 |
| `GATEWAY_KNOWN_COMMANDS` | 非cli_only或config-gated的frozenset | Gateway事件过滤 |

### 2. 命令别名解析

```python
def resolve_command(name: str) -> CommandDef | None:
    """Resolve a command name or alias to its CommandDef.
    Accepts names with or without the leading slash."""
    return _COMMAND_LOOKUP.get(name.lower().lstrip("/"))
```

**关键特性**：
- `/bg`、`/BG`、`bg`、`background`全部解析到同一个CommandDef
- 添加新别名只需修改`aliases`元组，自动传播到所有消费者

### 3. Gateway配置门控机制

```
                              ┌────────────────────────┐
                              │  COMMAND_REGISTRY      │
                              │  CommandDef(             │
                              │    "verbose",            │
                              │    cli_only=True,        │
                              │    gateway_config_gate=  │
                              │      "display.tool_     │
                              │       progress_command"  │
                              │  )                       │
                              └────────┬─────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
               CLI always         Gateway check         Telegram
               available          config.yaml          menu
                                  │                  │
                     ┌────────────┘                  │
                     │ read_raw_config()             │
                     │ → display.tool_progress_      │
                     │   command: True               │
                     │ → verbose 加入                 │
                     │   GATEWAY_KNOWN_COMMANDS       │
                     │                                │
               _is_gateway_available()          telegram_bot_commands()
               ├─ cli_only=False → True          ├─ Always include
               └─ cli_only=True, gate truthy → True   (filtered by
                   └─ False → False                _is_gateway_available)
```

**关键函数**：

```python
def _resolve_config_gates() -> set[str]:
    """读取config.yaml，返回config-gated命令中真值的canonical name集合。"""
    gated = [c for c in COMMAND_REGISTRY if c.gateway_config_gate]
    cfg = read_raw_config()
    for cmd in gated:
        val = cfg
        for key in cmd.gateway_config_gate.split("."):
            val = val.get(key) if isinstance(val, dict) else None
        if val:
            result.add(cmd.name)
    return result
```

### 4. CLI命令分发 (`cli.py` L5324)

```python
def process_command(self, command: str) -> bool:
    # 1. 解析别名
    cmd_lower = command.lower().strip()
    _cmd_def = _resolve_cmd(_base_word)
    canonical = _cmd_def.name if _cmd_def else _base_word

    # 2. 40+ elif 分支
    if canonical in ("quit", "exit", "q"): return False
    elif canonical == "help": self.show_help()
    elif canonical == "model": self._handle_model_switch(cmd_original)
    # ... 40 more
    else:
        # 3. 未匹配 → 尝试快捷命令/插件/技能/前缀匹配
        quick_commands = self.config.get("quick_commands", {})
        if base_cmd in quick_commands: ...
        elif base_cmd in _get_plugin_cmd_handler_names(): ...
        elif base_cmd in _skill_commands: ...
        else:
            # 前缀匹配 → 递归调用 process_command
            matches = [c for c in all_known if c.startswith(typed_base)]
            if len(matches) == 1:
                return self.process_command(full_cmd)  # 递归！
```

**问题**：40+个elif分支是一个维护瓶颈。虽然内部方法（`_handle_model_switch`等）已提取，但分发本身是线性链。新命令必须修改`commands.py`和`cli.py`两个文件。

### 5. Gateway命令处理 (`gateway/run.py`)

Gateway的命令处理与CLI平行但简化：

- 从消息中提取`/command`前缀
- 通过`resolve_command()`解析
- 通过`GATEWAY_KNOWN_COMMANDS`过滤不可用命令
- 每个网关平台（Telegram/Discord/Slack/Signal等）有自己的消息格式适配器

**关键区别**：
- CLI的`process_command()`直接修改`self`状态（模型、会话等）
- Gateway通过`_handle_command()`调用异步处理，返回文本响应
- `cli_only=True`的命令在Gateway不显示也不可调度（除非config-gate打开）
- `gateway_only=True`的命令（如`/approve`、`/deny`、`/sethome`）在CLI不可用

### 6. 终端回调系统 (`hermes_cli/callbacks.py`)

Three callback types bridge tool-layer synchronous interfaces to CLI's TUI：

**clarify_callback(cli, question, choices)**:
```
用户输入 → AIAgent → clarify() tool_call
                              ↓
                    clarify_callback() 被调用
                    ├─ 设置 cli._clarify_state
                    ├─ cli._app.invalidate() 触发UI刷新
                    └─ response_queue.get(timeout) 阻塞等待
                    
TUI渲染选择界面 → 用户按Enter → 响应放入queue → callback返回
```

**approval_callback(cli, command, description)**:
- `_approval_lock` 串行化并发请求（如parallel delegation）
- 最多5个选项：once / session / always / deny / view
- view选项在命令>70字符时出现，显示完整命令文本

**prompt_for_secret(cli, var_name, prompt)**:
- 无TUI时直接使用`getpass.getpass()`
- 有TUI时使用密码输入缓冲区，避免泄露到历史记录

### 7. 技能slash命令 (`agent/skill_commands.py`)

技能命令是动态的——不硬编码在`COMMAND_REGISTRY`中，而是扫描`~/.hermes/skills/`目录：

```python
def scan_skill_commands() -> Dict[str, Dict[str, Any]]:
    """扫描skills目录，生成 /command → skill_info 映射"""
    for skill_md in scan_dir.rglob("SKILL.md"):
        frontmatter, body = _parse_frontmatter(content)
        name = frontmatter.get('name', skill_md.parent.name)
        cmd_name = normalize(name)  # 空格/下划线 → 连字符
        _skill_commands[f"/{cmd_name}"] = {
            "name": name,
            "description": description,
            "skill_md_path": str(skill_md),
            "skill_dir": str(skill_md.parent),
        }
```

**重要设计**：技能命令注入为**用户消息**而非系统提示——这是为了保护prompt caching。`build_skill_invocation_message()`生成：

```
[SYSTEM: The user has invoked the "writing-plans" skill, indicating ...]
<skill content>
[Skill config (from ~/.hermes/config.yaml):
  display.tool_progress_command = True]
[This skill has supporting files you can load with the skill_view tool:]
- references/example.md
```

**`_inject_skill_config()`**解析技能frontmatter中声明的配置变量，从`config.yaml`解析其值注入消息——让技能可以声明需要哪些配置参数。

### 8. 平台菜单生成

各平台生成命令菜单的方式：

| 函数 | 平台 | 特殊处理 |
|------|------|----------|
| `gateway_help_lines()` | 所有网关 | 过滤不可用命令，生成`/command [args] -- description` |
| `telegram_bot_commands()` | Telegram | 名称限制32字符，小写+下划线，`_sanitize_telegram_name()` |
| `discord_skill_commands()` | Discord | 名称限制32字符，允许连字符 |
| `discord_skill_commands_by_category()` | Discord | 25组×25子命令限制，技能按目录分类 |
| `slack_subcommand_map()` | Slack | `/hermes bg do stuff` → `{"bg": "/bg", ...}` |
| `SlashCommandCompleter` | CLI | `/model`特殊处理（动态别名补全），`@`上下文引用，文件路径补全 |

---

## 代码质量评估

### 优势

1. **单一真值源设计**：`COMMAND_REGISTRY`是所有命令定义的唯一来源。添加命令只需修改一处，自动传播到CLI、Gateway、Telegram、Discord、Slack和自动补全。这是教科书级的DRY原则应用。

2. **Gateway配置门控**：`gateway_config_gate`巧妙地解决了"某个命令在Gateway条件可用"的需求，避免了在CLI和Gateway维护两份命令列表。

3. **技能命令的纯数据注入**：技能通过用户消息注入，不修改系统提示，保护了prompt caching的成本效率。

4. **平台适配的参数化**：`_collect_gateway_skill_entries()`抽象了Telegram/Discord共用的技能收集逻辑，`_clamp_command_names()`统一处理32字符限制和冲突解决。

### 问题与改进建议

1. **`process_command()`的40+ elif链**（`cli.py` L5324-5693）：这是最大的可维护性问题。每个新命令需要修改两处（`commands.py`和`cli.py`）。建议引入命令处理器注册：

   ```python
   # 建议架构
   class CommandHandler(ABC):
       canonical: str
       def handle(self, cli, cmd_original): ...
   
   COMMAND_HANDLERS: dict[str, CommandHandler] = {}
   
   # 注册
   @register_command("model")
   class ModelHandler(CommandHandler):
       def handle(self, cli, cmd_original):
           cli._handle_model_switch(cmd_original)
   ```

   这使`process_command()`缩减为：
   ```python
   handler = COMMAND_HANDLERS.get(canonical)
   if handler: return handler.handle(self, cmd_original)
   ```

2. **技能命令的双重解析**：`resolve_skill_command_key()`将下划线转连字符，但`_check_unavailable_skill()`（在Gateway中使用）有自己的归一化逻辑。建议统一为单一归一化函数。

3. **`_resolve_config_gates()`每次调用重新读配置文件**：对于高频命令（如/verbose在Gateway频繁使用），应缓存结果。建议在config加载时计算一次，存入模块级变量。

4. **`SlashCommandCompleter`的`_get_project_files()`**使用subprocess调用`rg`/`fd`/`find`，有5秒缓存但未处理CWD变化。在大型项目中可能造成补全延迟。建议使用异步文件监视或更大的缓存时间。

5. **命令处理器与AgentAgent的耦合**：`_handle_model_switch`等命令处理器直接修改`self.agent`的属性（`self.agent.model`、`self.agent.provider`），违反了单一职责。建议引入`SessionConfig`对象来承载可变配置状态。

6. **终端回调的同步阻塞**：`clarify_callback`和`approval_callback`使用`response_queue.get(timeout)`阻塞调用线程。在Gateway中这阻塞了事件循环线程。虽然Gateway使用单独线程池，但这增加了复杂性。建议改为async接口或使用`asyncio.Future`。