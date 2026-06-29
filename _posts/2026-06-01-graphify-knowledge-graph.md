---
title: "Graphify：将任意文件夹变成可查询知识图谱，Token 消耗降低 71.5 倍"
date: 2026-06-01 18:00:18 +0800
categories: [工具, AI]
tags: [Graphify, 知识图谱, RAG, AI编程, Token优化]
description: "Graphify 将任意文件夹转换为可查询知识图谱，每次查询 Token 消耗可降低 71.5 倍。支持代码、文档、论文、图片、视频等多种格式。"
pin: false
---


## 一、项目概述

### 1.1 项目简介

**Graphify** 是一个 AI 编码助手技能（skill），由 Safi Shamsi 开发，GitHub 星标数持续增长。它能将任意文件夹（代码、文档、论文、图片、视频）转换为可查询的知识图谱，帮助 AI 助手更快理解代码库结构。

> 🔥 **核心亮点**：与直接读取原始文件相比，每次查询 Token 消耗可降低 **71.5 倍**！

### 1.2 项目背景

受到 Andrej Karpathy 的 `/raw` 文件夹工作流启发（将论文、推文、截图、笔记存入原始文件夹，然后用 LLM 编译成 wiki），Graphify 应运而生。它解决了传统 RAG 方案的痛点：

| 痛点 | Graphify 方案 |
| --------- | ----------- |
| 上下文窗口有限 | 构建持久化知识图谱 |
| 暴力文本匹配效率低 | 图拓扑结构发现语义关联 |
| 缺乏全局系统级认知 | 跨文件隐性关系捕捉 |

### 1.3 目标用户

- **AI 编程助手用户**：Claude Code、Codex、Cursor、OpenCode 等
- **代码理解需求者**：需要快速理解陌生代码库的开发者
- **知识管理爱好者**：希望将笔记、论文、截图统一图谱化管理
- **团队协作场景**：需要共享代码结构认知的团队

---

## 二、技术栈分析

### 2.1 编程语言分布

| 语言 | 行数 | 占比 | 用途 |
| ----------- | -------- | ---- | ---------------- |
| Python | ~10,000+ | ~75% | 核心逻辑、CLI、图构建 |
| JavaScript | ~3,000+ | ~22% | OpenCode 插件、技能模板 |
| Markdown/配置 | ~500 | ~3% | 文档、技能说明 |

### 2.2 核心依赖库

```python
# pyproject.toml 核心依赖
dependencies = [
    "networkx",                    # 图数据结构
    "tree-sitter>=0.23.0",        # AST 解析引擎
    "tree-sitter-python",          # Python AST
    "tree-sitter-javascript",      # JavaScript AST
    "tree-sitter-typescript",      # TypeScript AST
    "tree-sitter-go",              # Go AST
    "tree-sitter-rust",            # Rust AST
    "tree-sitter-java",            # Java AST
    "tree-sitter-c",               # C AST
    "tree-sitter-cpp",             # C++ AST
    # ... 更多语言支持
]
```

### 2.3 可选依赖（按功能模块）

| 扩展 | 依赖包 | 功能 |
| -------- | -------------------------- | ------------- |
| `mcp` | `mcp` | MCP 服务器支持 |
| `neo4j` | `neo4j` | Neo4j 图数据库导出 |
| `pdf` | `pypdf`, `html2text` | PDF 解析 |
| `video` | `faster-whisper`, `yt-dlp` | 视频转录 |
| `leiden` | `graspologic` | Leiden 社区检测算法 |
| `watch` | `watchdog` | 文件监控 |
| `office` | `python-docx`, `openpyxl` | Office 文档解析 |

### 2.4 支持的编程语言（25+ 种）

```
Python, JavaScript, TypeScript, Go, Rust, Java, C, C++,
Ruby, C#, Kotlin, Scala, PHP, Swift, Lua, Zig, PowerShell,
Elixir, Objective-C, Julia, Verilog, SystemVerilog, Vue,
Svelte, Dart
```

---

## 三、项目架构

### 3.1 核心处理流程

```
[detect()] --> [extract()] --> [build_graph()] --> [cluster()]
                                                        |
                                                        v
[export()]  <-- [report()]  <-- [analyze()]  <-- [（合并）]
```

### 3.2 核心模块职责

| 模块 | 函数 | 输入 → 输出 | 关键特性 |
| --------------- | --------------------- | ----------------------- | ------------------------ |
| `detect.py` | `collect_files(root)` | 目录 → [Path] | .graphifyignore 支持 |
| `extract.py` | `extract(path)` | 文件路径 → {nodes, edges} | tree-sitter AST + LLM 语义 |
| `build.py` | `build_graph()` | 提取结果 → nx.Graph | 节点去重三层机制 |
| `cluster.py` | `cluster(G)` | 图 → 带社区标签的图 | Leiden 算法 |
| `analyze.py` | `analyze(G)` | 图 → 分析结果 | God nodes 发现 |
| `report.py` | `render_report()` | 图+分析 → Markdown | 人类可读报告 |
| `export.py` | `export()` | 图 → HTML/JSON/维基 | 多格式导出 |
| `transcribe.py` | `transcribe()` | 视频 → 文本 | Whisper 本地转录 |

### 3.3 两阶段提取策略

**第一阶段：确定性 AST 提取**

- tree-sitter 解析代码文件
- 提取：类、函数、导入、调用图、docstring、注释
- 无需 LLM，100% 确定性和可复现性
- 覆盖：25+ 编程语言

**第二阶段：LLM 语义提取**

- Claude 子代理并行处理文档、论文、图片
- 提取：概念、关系、设计动机
- 视频/音频：faster-whisper 本地转录
- 缓存机制：SHA256 哈希，重复运行只处理变更文件

### 3.4 目录结构

```
graphify/
├── __init__.py          # 包入口
├── __main__.py          # CLI 入口 (1371 行)
├── extract.py           # 核心提取逻辑 (3277 行，最大模块)
├── export.py            # 导出功能 (1014 行)
├── detect.py            # 文件检测 (510 行)
├── analyze.py           # 图分析 (540 行)
├── cluster.py           # 社区检测 (137 行)
├── transcribe.py        # 视频转录 (182 行)
├── build.py             # 图构建 (107 行)
├── report.py            # 报告生成 (175 行)
├── wiki.py              # 维基站生成 (214 行)
├── serve.py             # MCP 服务器 (373 行)
├── cache.py             # 缓存管理 (169 行)
├── security.py          # 安全验证 (203 行)
├── hooks.py             # PreToolUse 钩子 (220 行)
└── watch.py             # 文件监控 (200 行)
```

---

## 四、创新特性

### 4.1 图拓扑聚类（无 Embeddings）

**关键创新**：采用纯图拓扑结构的 Leiden 社区发现算法，**完全不需要 Embeddings 和向量数据库**。

聚类基于边密度，而非语义相似度。Claude 提取的 `semantically_similar_to` 边（标记 INFERRED）直接影响社区检测，无需额外向量计算。

### 4.2 关系置信度标签

| 标签 | 含义 | 示例 |
| ----------- | ---------- | --------------------------------- |
| `EXTRACTED` | 源文件明确声明 | import requests → imports 关系 |
| `INFERRED` | 合理推断（含置信度） | 共现上下文 → semantically_similar_to |
| `AMBIGUOUS` | 不确定（需人工复核） | 在 GRAPH_REPORT.md 中标记 |

### 4.3 多模态支持

| 模态 | 处理方式 | 工具 |
| ------- | --------------- | -------------- |
| 代码 | tree-sitter AST | 确定性解析 |
| 文档/PDF | LLM 提取 | Claude |
| 图片/截图 | Vision API | Claude vision |
| 视频/音频 | Whisper 转录 | faster-whisper |
| 白板图/流程图 | Vision API | Claude vision |

### 4.4 输出格式

```
graphify-out/
├── graph.html       # 可交互图谱 - 浏览器打开，节点可点击、搜索、过滤
├── GRAPH_REPORT.md  # God nodes、意外连接、建议提问
├── graph.json       # 持久化图谱 - 数周后可查询，无需重新读取原始文件
├── wiki/            # 维基站（可选）
└── cache/           # SHA256 缓存 - 重复运行只处理变更文件
```

---

## 五、多平台支持

### 5.1 支持的平台（14+ 个）

| 平台 | 安装命令 | 特殊机制 |
| ------------------ | ----------------------------------- | ----------------------- |
| Claude Code | `graphify install` | PreToolUse hook + CLAUDE.md |
| Codex | `graphify install --platform codex` | PreToolUse hook + AGENTS.md |
| OpenCode | `graphify opencode install` | plugin + AGENTS.md |
| Cursor | `graphify cursor install` | Always-on rules |
| Gemini CLI | `graphify gemini install` | BeforeTool hook |
| VS Code Copilot | `graphify vscode install` | copilot-instructions.md |
| Aider | `graphify install --platform aider` | AGENTS.md |
| OpenClaw | `graphify install --platform claw` | AGENTS.md |
| Factory Droid | `graphify install --platform droid` | Task tool |
| Trae | `graphify install --platform trae` | Agent tool |
| Hermes | `graphify hermes install` | AGENTS.md |
| Kiro | `graphify kiro install` | steering file |
| Google Antigravity | `graphify antigravity install` | rules + workflows |
| GitHub Copilot CLI | `graphify copilot install` | global skill |

### 5.2 Always-on vs 显式触发

| 模式 | 机制 | 用途 |
| ------------------- | --------------------------- | ---- |
| Always-on hook | 每次工具调用前注入 GRAPH_REPORT.md | 日常导航 |
| `/graphify query` | 遍历 graph.json hop-by-hop | 精确问答 |
| `/graphify explain` | 追踪节点间路径 | 关系追溯 |
| `/graphify path` | 边级别详情（含置信度） | 深度分析 |

---

## 六、真实案例分析

### 6.1 httpx 代码库分析

对 **httpx** 库进行图谱构建：

```
Corpus: 6 files · ~2,047 words
图谱: 144 nodes · 330 edges · 6 communities detected
提取质量: 53% EXTRACTED · 47% INFERRED · 0% AMBIGUOUS
```

God Nodes（核心抽象）：

| 排名 | 节点 | 边数 |
| --- | ------------- | -------- |
| 1 | Client | 26 edges |
| 2 | AsyncClient | 25 edges |
| 3 | Response | 24 edges |
| 4 | Request | 21 edges |
| 5 | BaseClient | 18 edges |

意外发现的关系：

```
Timeout --uses--> URL        [INFERRED]
Timeout --uses--> Headers    [INFERRED]
Timeout --uses--> Cookies    [INFERRED]
```

### 6.2 Karpathy 代码仓库分析

```
Corpus: 49 files · ~92,616 words
图谱: 285 nodes · 340 edges · 53 communities detected
提取质量: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS
Token 消耗: 6,000 input · 3,500 output
```

---

## 七、使用场景

### 7.1 典型工作流

```bash
# 1. 安装
pip install graphifyy && graphify install

# 2. 在 AI 编码助手中执行
/graphify .

# 3. 查看输出
open graphify-out/graph.html      # 交互图谱
cat graphify-out/GRAPH_REPORT.md  # 分析报告

# 4. 持续更新
graphify update .                  # 增量更新
graphify watch .                   # 文件监控自动重建

# 5. 团队共享（提交到 git）
git add graphify-out/
git commit -m "Update knowledge graph"
```

### 7.2 团队协作建议

推荐工作流：

1. 一人运行 `/graphify .` 构建初始图谱，提交
2. 其他成员 pull 后 AI 助手立即获得上下文
3. 安装 post-commit hook：`graphify hook install`
4. 代码变更自动重建（AST 部分，无需 LLM）
5. 文档/论文变更后手动 `/graphify --update`

---

## 八、性能与优化

### 8.1 Token 节省

| 指标 | 数值 |
| ---------- | ------------- |
| Token 节省倍数 | **71.5x** |
| 原理 | 图查询 vs 全量文件读取 |

### 8.2 缓存机制

SHA256 哈希缓存策略：

- 首次运行：完整处理
- 后续运行：只处理变更文件
- 缓存文件：graphify-out/cache/

### 8.3 并行处理

- **AST 提取**：多语言并行
- **语义提取**：Claude 子代理并行
- **社区检测**：NetworkX 内置优化

---

## 九、与其他方案对比

### 9.1 方案对比表

| 维度 | Graphify | 传统 RAG | Neo4j + LLM |
| --------- | ----------- | ------------- | ------------ |
| 索引方式 | 图拓扑 | 向量 Embeddings | 图数据库 |
| 无需 LLM 提取 | ✅ AST | ❌ 全文向量化 | ❌ 配置 |
| 跨文件关系 | ✅ 显式图边 | ❌ 隐式相似度 | ✅ 原生支持 |
| 社区发现 | ✅ Leiden | ❌ 需要额外组件 | ❌ 需要插件 |
| 部署复杂度 | 低（纯 Python） | 中（向量数据库） | 高（Neo4j 服务器） |
| Token 效率 | 高（子图查询） | 中（Top-K 检索） | 高（子图查询） |
| 多模态 | ✅ 原生 | ❌ 需额外处理 | ❌ 需额外处理 |
| 持久化 | ✅ JSON | ❌ 每次重建 | ✅ 数据库 |

### 9.2 核心优势

1. **确定性优先**：AST 提取保证 100% 可复现
2. **透明可追溯**：EXTRACTED/INFERRED/AMBIGUOUS 标签
3. **轻量部署**：无需外部服务，纯本地运行
4. **多模态统一**：代码、文档、图片、视频一网打尽
5. **平台无关**：支持 14+ AI 编码助手

---

## 十、安全设计

### 10.1 安全机制

| 机制 | 实现 |
| ------ | -------------------------------------------------------- |
| URL 验证 | 只允许 http/https，阻止 file:// 重定向 |
| 内容获取 | 大小限制 + 超时控制 |
| 图路径验证 | 必须解析到 graphify-out/ 内 |
| 节点标签 | 控制字符剥离、256 字符上限、HTML 转义 |

---

## 十一、发展现状与未来

### 11.1 版本轨迹（截至 v0.4.23）

- **最新版本**：v0.4.23 (2026-04-18)
- **累计提交**：145+ commits
- **活跃开发**：几乎每天都有更新
- **国际支持**：中、英、日、韩四国语言 README

### 11.2 近期亮点更新

| 版本 | 日期 | 亮点 |
| ------- | ----- | ------------------------ |
| v0.4.23 | 04-18 | Go stdlib 导入修复、HTML 文件支持 |
| v0.4.21 | 04-17 | MDX 支持、跨文件调用扩展 |
| v0.4.20 | 04-17 | JS/MJS 导入修复 |
| v0.4.19 | 04-17 | Kiro 支持、Leiden 性能优化 |
| v0.4.15 | 04-15 | VS Code Copilot Chat 支持 |
| v0.4.13 | 04-14 | Verilog/SystemVerilog 支持 |
| v0.4.10 | 04-13 | Dart/Flutter、Blade 模板支持 |

### 11.3 生态扩展方向

- 更多语言支持（如 COBOL、Fortran）
- 更深度的大模型集成
- 可视化增强（3D 图谱）
- 云端协作模式

---

## 十二、总结与建议

### 12.1 项目优势

| 优势 | 说明 |
| ------------ | -------------------- |
| 🚀 **革命性效率** | 71.5x Token 节省 |
| 🔧 **工程化完善** | 完善的测试覆盖、安全机制、缓存策略 |
| 🌐 **多模态统一** | 代码、文档、图片、视频一站式处理 |
| 🤖 **AI 原生** | 专为 AI 编码助手设计 |
| 📊 **图拓扑优先** | 拒绝黑盒 Embeddings |
| 🔄 **增量更新** | SHA256 缓存 + watch 模式 |

### 12.2 适用场景

- ✅ 理解陌生代码库
- ✅ 大型遗留代码重构
- ✅ 团队知识共享
- ✅ 个人知识管理（Karpathy 风格）
- ✅ AI 编程助手增强
- ⚠️ 实时性要求极高的场景（需额外优化）

### 12.3 可改进之处

| 方向 | 建议 |
| --- | ---------- |
| 可视化 | 3D 图谱、多层钻取 |
| 协作 | 冲突解决、多人编辑 |
| 性能 | 更大规模代码库优化 |
| AI | 更智能的关系推断 |

---

## 参考资料

1. **GitHub 仓库**：https://github.com/safishamsi/graphify
2. **Medium 文章**：How to Use Graphify: Turn Any Folder Into a Knowledge Graph
3. **PyPI 包**：`pip install graphifyy`
4. **codeKK 介绍**：https://p.codekk.com/detail/python/safishamsi/graphify
5. **CSDN 中文介绍**：还在让大模型"暴读"源码? Graphify: 用知识图谱硬生生砍掉 71.5 倍 Token 开销!
