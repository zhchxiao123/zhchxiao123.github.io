# 一个脚本搞定 Claude Code 模型管理与切换

你有没有发现：**现在写代码，几乎不用手写了**？

大模型发展太快了，各种 AI 编程工具眼花缭乱。我现在的主力开发工具就是 **Claude Code**，简单需求让它直接上，复杂项目它帮我搭框架、想方案、Debug。

但问题来了——

**不同项目，适合用不同的模型。**

| 场景 | 适合的模型 |
|------|-----------|
| 简单注释、格式调整 | 便宜快速的模型就够了 |
| 复杂架构设计、代码重构 | 必须上旗舰级模型 |
| 调试 Bug、排查问题 | 需要强推理能力 |
| 日常 CRUD 小功能 | 本地 Ollama 完全能搞定 |

但是当前Claude并没有办法像opencode一样方便的切换模型，比较麻烦。于是我自己写了个工具：**Claude Launcher**，兼顾模型管理与切换。

简单来说，安装就一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/zhchxiao123/claude-launcher/main/install.sh | bash
```

---

## 🏆 核心功能一览

| 功能 | 说明 |
|------|------|
| **一键安装** | `curl -fsSL ... \| bash`，自动检测依赖 |
| **交互式菜单** | 上下选择，回车启动，无需记命令 |
| **预设管理** | list / add / edit / remove 全支持 |
| **项目级配置** | 支持 `CLAUDE_LAUNCHER_CONFIG=./my.json` |
| **零依赖** | 只需 bash + jq（或 python3） |

---

## 🤔 它到底干了什么？

就是一个**交互式终端菜单**，帮你管理 Claude Code 的模型预设配置文件。

你配置好预设后，运行 `claude-launcher`，选哪个就启动哪个 Claude Code，**环境变量自动注入**，无需手动 export。

---

## 🏗️ 工作原理

```
presets.json  →  claude-launcher  →  Claude Code (env vars)
   ↑
   └── 你配置的：API端点 / Token / 模型名
```

配置示例：

```json
{
  "presets": [
    {
      "name": "MiniMax M2.7 高速",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-xxxxx",
        "ANTHROPIC_MODEL": "MiniMax-M2.7",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
      }
    }
  ]
}
```

---

## 🧪 实战演练

### 安装（一行命令）

```bash
curl -fsSL https://raw.githubusercontent.com/zhchxiao123/claude-launcher/main/install.sh | bash
```

安装脚本会自动检测缺失的 `jq`，并帮你用 Homebrew / apt / yum 等一键安装。

### 启动菜单

```bash
claude-launcher
```

```
┌─────────────────────────────────┐
│      Claude Launcher 1.0.0      │
│                                 │
│   1) Anthropic (Native)        │
│   2) minimax-m2.7-highspeed    │
│   3) ollama-glm-5.1            │
│   4) ollama-kimi-k2.6          │
│   5) deepseek-v4-pro-1m        │
│   6) official-deepseek-v4-pro  │
│                                 │
│   q) Quit                       │
│                                 │
│   Enter choice [1-6]: _        │
└─────────────────────────────────┘
```

选哪个按回车，直接用那个模型启动 Claude Code。

### 管理预设

```bash
# 进入模型管理
claude-launcher models

Model Management

  1) List
  2) Add
  3) Edit
  4) Remove
  q) Back

Choice: 
```

---

## 总结

Claude Launcher 解决的是一个很具体的问题：**不同项目需要不同模型，手动切换太麻烦**。

一行安装，一键选择，3 秒启动。适合：

- 🤖 经常在多个模型之间切换的开发者
- 💰 想用性价比方案的团队
- 🔬 需要对比不同模型效果的研究者

---

**项目地址**：https://github.com/zhchxiao123/claude-launcher

**安装命令**：
```bash
curl -fsSL https://raw.githubusercontent.com/zhchxiao123/claude-launcher/main/install.sh | bash
```

---

*觉得有用？点个赞让更多人看到 💪*
