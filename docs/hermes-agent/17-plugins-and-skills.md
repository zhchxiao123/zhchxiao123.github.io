---
title: "Step 17: 插件与技能系统"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/17-plugins-and-skills/
---

# 插件与技能系统深度分析

## 1. 概述

Hermes 的插件和技能系统是 Agent 可扩展性的核心。**插件系统**（Context Engine 和 Memory Provider）提供运行时可插拔的上下文增强和记忆管理，使用动态导入和收集器模式注册。**技能系统**（Skills）提供三层分层管理（内置/Hub/用户层），每个技能定义在标准格式的 `SKILL.md` 中，通过安全守卫（Skills Guard）进行安装前扫描，通过技能管理器进行 CRUD 操作。

**关键文件清单：**

| 文件 | 行数 | 职责 |
|------|------|------|
| `plugins/__init__.py` | ~50 | 插件入口：导出 Context Engine 和 Memory Provider |
| `plugins/context_engine/__init__.py` | ~200 | 上下文引擎：_EngineCollector 注册表 |
| `plugins/memory/__init__.py` | ~300 | 记忆提供者：_ProviderCollector 注册表 |
| `plugins/memory/<provider>/` | 各 ~100-500 | 8 个内置 Memory Provider |
| `tools/skills_tool.py` | ~400 | 技能工具：Agent 面向的技能查询 |
| `tools/skills_hub.py` | ~3050 | 技能市场：搜索、安装、更新 |
| `tools/skill_manager_tool.py` | ~600 | 技能管理器：CRUD 操作 |
| `tools/skills_guard.py` | ~930 | 安全守卫：安装前扫描 |
| `tools/skills_sync.py` | ~250 | 技能同步：Manifest 种子与 MD5 追踪 |
| `hermes_cli/skills_config.py` | ~200 | CLI 技能配置（启用/禁用） |
| `hermes_cli/skills_hub.py` | ~350 | CLI 技能市场交互 |

---

## 2. 插件系统

### 2.1 Context Engine 插件

上下文引擎在运行时为 Agent 提供动态上下文增强。通过 `_EngineCollector` 模式实现单活动引擎：

```python
class _EngineCollector:
    """Collects context engines and allows selecting one as active."""
    _engines: Dict[str, Type[ContextEngine]] = {}
    _active: str = None

    @classmethod
    def register(cls, name: str, engine_cls: Type[ContextEngine]):
        cls._engines[name] = engine_cls

    @classmethod
    def set_active(cls, name: str):
        if name not in cls._engines:
            raise ValueError(f"Unknown engine: {name}")
        cls._active = name

    @classmethod
    def get_active(cls) -> Optional[ContextEngine]:
        if cls._active and cls._active in cls._engines:
            return cls._engines[cls._active]()
        return None
```

选择通过 `context.engine` 配置项：

```yaml
context:
  engine: honcho  # 或 mem0, holographic 等
```

引擎接口（`ContextEngine` ABC）通常提供：
- `query(query: str) -> List[ContextSnippet]` — 查询相关上下文
- `add_documents(docs: List[Document])` — 添加文档到引擎
- `reset()` — 重置引擎状态

### 2.2 Memory Provider 插件

记忆提供者使用类似的 `_ProviderCollector` 模式，也保证单活动：

```python
class _ProviderCollector:
    _providers: Dict[str, Type[MemoryProvider]] = {}
    _active: str = None
```

Provider 发现流程：

1. **扫描内置目录**：`plugins/memory/<name>/` — 每个 Provider 作为子目录
2. **扫描用户目录**：`$HERMES_HOME/plugins/<name>/` — 用户安装的 Provider
3. **动态导入**：加载 `<name>/__init__.py`，调用 `register(ctx)` 函数
4. **回退发现**：如果 `register()` 不存在，扫描 `MemoryProvider.__subclasses__()`

内置的 8 个 Memory Provider：

| Provider | 描述 |
|----------|------|
| `honcho` | 基于 Honcho 的对话记忆 |
| `mem0` | Mem0 增强记忆 |
| `holographic` | 全息知识图谱记忆 |
| `byterover` | ByteRover 记忆搜索 |
| `hindsight` | 回溯式记忆管理 |
| `openviking` | OpenViking 记忆引擎 |
| `retaindb` | 基于 RetainDB 的持久记忆 |
| `supermemory` | SuperMemory 记忆系统 |

### 2.3 动态导入机制

插件系统的核心是 `importlib.util.spec_from_file_location` 动态导入：

```python
def _load_plugin(plugin_dir: Path, plugin_name: str):
    init_file = plugin_dir / "__init__.py"
    if not init_file.exists():
        return None

    spec = importlib.util.spec_from_file_location(
        f"hermes_plugin_{plugin_name}",
        str(init_file)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if hasattr(module, "register"):
        module.register(_provider_collector)
    else:
        # Fallback: scan subclasses
        for cls in MemoryProvider.__subclasses__():
            if cls.__module__ == module.__name__:
                _provider_collector.register(plugin_name, cls)
```

这种设计允许用户通过简单的文件放置安装插件（Drop-in），无需修改核心代码。

---

## 3. 技能系统

### 3.1 三层技能架构

```
~/.hermes/skills/
├── builtin/           ← 第一层：内置技能（随版本更新）
│   ├── code_review/   ← 由 skills_sync 从仓库种子
│   └── ...
├── hub/               ← 第二层：Hub 安装技能
│   ├── web_research/  ← 从 agentskills.io 等注册表安装
│   └── ...
└── user/              ← 第三层：用户创建技能（通过 skill_manager_tool 或手动）
    ├── my_workflow/
    └── ...
```

层级优先级：`user > hub > builtin`。用户编辑过的内置技能不会被同步覆盖（MD5 检测）。

### 3.2 SKILL.md 格式

技能通过 `SKILL.md` 定义，使用 YAML frontmatter + Markdown 正文的标准格式：

```markdown
---
name: web_research
description: Deep web research with multi-source synthesis
version: 1.2.0
platforms:
  - cli
  - telegram
  - discord
prerequisites:
  - python-package: beautifulsoup4
  - env-var: SERP_API_KEY
required_environment_variables:
  - SERP_API_KEY
setup:
  collect_secrets:
    - env_var: SERP_API_KEY
      description: "SerpApi API key for web search"
      password: true
---

# Web Research Skill

## Instructions
...skill content in Markdown...
```

`setup.collect_secrets` 字段允许技能声明需要收集的环境变量，安装时 CLI 会提示用户输入。

### 3.3 技能查询：渐进式披露

`skills_tool.py` 提供两层 Agent 面向的查询：

```python
@registry.register(...)
def skills_list(args, **kw):
    """列出所有技能的元数据（名称、描述、类别）"""
    # 返回：name, description, category, installed, enabled

@registry.register(...)
def skill_view(args, **kw):
    """查看技能完整内容和要求"""
    # 返回：完整 SKILL.md 内容 + 链接文件 + 环境要求
```

设计哲学：Agent 首次调用 `skills_list` 了解选项，选择后调用 `skill_view` 获取完整指令。避免将所有技能内容塞入系统提示词。

### 3.4 技能市场（Skills Hub）

`skills_hub.py`（约 3050 行）是系统中最复杂的文件之一，实现多源技能注册表：

| 源类型 | 类 | 说明 |
|--------|-----|------|
| GitHub | `GitHubSource` | PAT / gh CLI / GitHub App 认证，支持私有仓库 |
| Well-Known | `WellKnownSkillSource` | `.well-known/agent-skills.json` 发现 |
| Skills.sh | `SkillsShSource` | skills.sh API 注册表 |
| Optional | `OptionalSkillSource` | 用户自定义注册表 URL |

核心流程：

1. **搜索** `search(query)` — 在所有源中并行搜索，返回去重结果
2. **获取** `fetch(source, skill_name)` — 下载技能到 `$HERMES_HOME/skills/hub/`
3. **检查** `inspect(skill_name)` — 查看技能详情但不安装
4. **缓存** — 搜索结果缓存到 `$HERMES_HOME/skills/.hub_cache/`，TTL 5 分钟
5. **速率限制** — 内置令牌桶，默认每分钟 30 次请求

GitHub 认证支持三种方式（按优先级）：
1. `GITHUB_PERSONAL_ACCESS_TOKEN` 环境变量
2. `gh auth token` CLI 命令输出
3. GitHub App installation token（需要 `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`）

### 3.5 安全守卫（Skills Guard）

`skills_guard.py`（约 930 行）在安装前对技能内容进行安全扫描，这是系统安全的关键防线。

**扫描引擎**：基于正则表达式的模式匹配，包含 80+ 条 `THREAT_PATTERNS`，覆盖 13 个威胁类别：

| 类别 | 模式数 | 示例威胁 |
|------|--------|----------|
| Exfiltration | 8 | `requests.post(os.environ...)`, 数据外泄 |
| Injection | 12 | prompt 注入、system prompt 覆盖 |
| Destructive | 8 | `rm -rf /`, 文件系统破坏 |
| Persistence | 7 | 修改 `.bashrc`, crontab 注入 |
| Network | 6 | 开放监听端口、SSH 隧道 |
| Obfuscation | 6 | base64 解码执行、eval 混淆 |
| Execution | 8 | `subprocess.call(shell=True)`, 任意执行 |
| Traversal | 6 | `../../etc/passwd`, 路径遍历 |
| Mining | 4 | 加密货币挖矿脚本 |
| Supply Chain | 5 | 依赖混淆、pip index 注入 |
| Privilege Escalation | 5 | `sudo` 使用、setuid |
| Credential Exposure | 5 | 硬编码密钥、token 泄露 |
| Other | 6 | 资源滥用、反模式 |

**信任级别与安装策略矩阵**：

| 信任级别 | 说明 | 安装策略 |
|----------|------|----------|
| `builtin` | 官方内置技能 | 自动安装，跳过扫描 |
| `trusted` | 已验证社区技能 | 静默扫描，仅阻止高危 |
| `community` | 未知来源技能 | 扫描后需要用户确认 |

```python
INSTALL_POLICY = {
    "builtin":   {"auto_install": True,  "scan_level": "none"},
    "trusted":   {"auto_install": True,  "scan_level": "high"},
    "community": {"auto_install": False, "scan_level": "all"},
}
```

扫描结果返回 `GuardResult`：
```python
class GuardResult:
    threats: List[Threat]        # 发现的威胁列表
    risk_level: RiskLevel        # high / medium / low / safe
    can_install: bool           # 是否允许安装
    warnings: List[str]         # 警告信息
    blocked: bool               # 是否被阻止
```

### 3.6 技能同步

`skills_sync.py` 负责将仓库中的内置技能种子到用户目录：

1. **Manifest 追踪**：`~/.hermes/skills/.bundled_manifest` 记录每个内置技能的源 MD5
2. **智能同步**：如果用户未修改（MD5 匹配），更新到最新版本；如果用户已修改（MD5 不匹配），跳过更新
3. **首次安装**：Manifest 不存在时，全量种子所有内置技能

```python
def sync_bundled_skills():
    manifest = load_manifest()
    for skill_dir in BUNDLED_SKILLS_DIR.iterdir():
        skill_md = skill_dir / "SKILL.md"
        current_hash = md5(skill_md.read_text())
        if skill_dir.name in manifest:
            if manifest[skill_dir.name]["hash"] != current_hash:
                # 源文件更新了，检查用户是否也修改了
                user_hash = md5((user_skill_dir / "SKILL.md").read_text())
                if user_hash == manifest[skill_dir.name]["user_hash"]:
                    # 用户未修改，可以更新
                    copy_with_overwrite(skill_dir, user_skill_dir)
                else:
                    # 用户已修改，跳过
                    logger.info(f"Skipping {skill_dir.name}: user has local modifications")
        else:
            # 新技能，种子到用户目录
            copy_skill(skill_dir, user_skill_dir)
```

### 3.7 技能管理器

`skill_manager_tool.py` 提供 Agent 面向的 CRUD 操作：

| 操作 | 说明 |
|------|------|
| `create` | 创建新技能（从名称和描述） |
| `edit` | 编辑技能内容（全量替换） |
| `patch` | 精确修补技能内容（搜索替换） |
| `delete` | 删除技能 |
| `write_file` | 向技能写入附加文件 |
| `remove_file` | 从技能中删除附加文件 |

关键设计：
- **原子写入**：所有文件写入使用写临时文件 + `os.replace()` 模式
- **安全扫描**：每次 `write_file` 和 `edit/patch` 操作前都运行 `SkillsGuard.scan()`
- **模糊匹配**：`patch` 操作对搜索字符串使用 `difflib.get_close_matches()` 容忍微小编辑差异

---

## 4. 代码质量评估

### 4.1 优点

1. **渐进式披露设计**：`skills_list` → `skill_view` 的两步查询避免了将所有技能内容塞入上下文，节省 token 开销。

2. **安全守卫全面**：80+ 条威胁模式覆盖 13 个类别，信任级别与安装策略矩阵分离了安全和便利。社区技能必须通过扫描，内置技能快速跳过。

3. **智能同步**：MD5 检测用户修改，避免覆盖用户编辑。这是用户友好的关键设计。

4. **多源注册表**：Skills Hub 支持 GitHub、Well-Known、Skills.sh 和自定义源，搜索结果自动去重，有缓存和速率限制。

5. **原子写入**：所有关键文件操作（技能、作业、配置）使用写临时文件 + `os.replace()`。

### 4.2 不足与风险

1. **`skills_hub.py` 过于庞大**：3050 行单文件，包含认证、源管理、搜索、缓存、安装、更新等全部逻辑。应拆分为 `auth.py`、`sources.py`、`registry.py`、`cache.py` 等模块。

2. **正则安全扫描的局限性**：80+ 条正则模式无法检测语义层面的恶意代码（如通过合法 API 组合实现的数据外泄）。建议增加可选的 LLM 辅助安全审查层。

3. **Collector 模式的单例限制**：`_EngineCollector` 和 `_ProviderCollector` 使用类变量存储状态，意味着同一进程只能有一个活动引擎/提供者。不支持多引擎编排或 A/B 测试场景。

4. **动态导入无沙箱**：`importlib` 直接在主进程中执行插件代码，恶意插件可以执行任意代码。安全守卫仅在安装时扫描，不阻止运行时行为。

5. **技能管理器的 patch 依赖模糊匹配**：`difflib.get_close_matches()` 可能匹配到错误位置，导致语义不同的编辑。虽然方便，但在 Agent 自动化上下文中可能引入静默错误。

6. **缓存失效策略简单**：技能搜索缓存只有 5 分钟 TTL，没有主动失效机制。如果用户在 Hub 上更新了技能，本地缓存可能在 5 分钟内返回过时结果。

7. **Provider 发现回退不透明**：`MemoryProvider.__subclasses__()` 的回退发现依赖于 Python 的子类追踪机制，在新实例中可能无法发现通过动态导入添加的子类（取决于导入顺序）。

---

## 5. 改进建议

### 5.1 高优先级

1. **拆分 `skills_hub.py`**：将 3050 行的 God Object 拆分为：
   - `skills_hub/auth.py` — GitHub 认证逻辑
   - `skills_hub/sources.py` — 源注册和管理
   - `skills_hub/search.py` — 搜索、缓存、去重
   - `skills_hub/install.py` — 安装、更新、验证
   - `skills_hub/__init__.py` — 公共 API 入口

2. **插件沙箱**：为 `MemoryProvider` 插件添加子进程隔离，使用 `multiprocessing.Process` 或 `subprocess` 运行插件代码。至少在首次加载时添加运行时监控。

3. **Skills Guard 增加 LLM 辅助审查**：对 `community` 信任级别的技能，增加可选的 LLM 语义审查步骤：
   ```python
   if trust_level == "community" and config.get("skills.llm_review", False):
       review = auxiliary_client.analyze_security(skill_content)
       result.warnings.extend(review.findings)
   ```

### 5.2 中优先级

4. **多引擎编排**：将 `_EngineCollector` 的单 active 引擎改为有序列表，支持：
   - 顺序查询（fallback 链）
   - 并行查询 + 合并
   - 基于查询类型的路由

5. **主动缓存失效**：在 `fetch()` 完成后自动清除搜索缓存中的对应条目，避免安装后搜索结果仍指向旧版本。

6. **Patch 操作增加确认**：当模糊匹配返回多个候选时，返回所有候选和相似度得分，让调用者确认而不是自动选择最高分的。对 Agent 工具来说，可以返回匹配详情让模型决策。

### 5.3 低优先级

7. **技能版本管理**：在 Manifest 中记录技能版本（不仅 MD5），支持版本比较和变更日志展示。

8. **插件健康检查**：为每个 MemoryProvider 添加 `health_check()` 方法，在启动时验证连接和配置，失败时自动切换到下一个可用 Provider。

9. **技能依赖声明**：在 SKILL.md frontmatter 中添加 `depends_on` 字段，安装时自动解析并安装依赖技能。