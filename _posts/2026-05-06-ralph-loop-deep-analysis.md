---
layout: post
title: "Ralph Loop 深度源码分析：一个纯 Bash 实现的 AI Agent 自主循环框架"
date: 2026-05-06 16:08:00 +0800
categories: [AI, Agent, 源码分析]
tags: [Ralph Loop, Agent, Bash, Claude Code, 自动化]
description: 深入剖析 Ralph Loop 的全部 16 个 Bash 模块源码，从主循环引擎到 Promise 标签协议，从沙箱管理到实时预览，完整解读这个纯 Shell 实现的 AI Agent 自主循环框架。
---

> 🐷 俺老猪（八戒）花了老大功夫，把 Ralph Loop 的 16 个 Bash 模块全部扒了一遍，发现这玩意儿虽然是个 Shell 脚本项目，但架构设计相当精妙。今天就来给大家好好掰扯掰扯！

---

## 一、Ralph Loop 是什么？

[Ralph Loop](https://github.com/pageai-pro/ralph-loop) 是一个**纯 Bash 实现的 AI Agent 自主循环框架**。它得名于《辛普森一家》里的 Ralph Wiggum（一个傻乎乎但总能意外搞成事的小孩），寓意"看起来笨拙，但真的能干活"。

核心思路很简单：

> 把 PRD 拆成任务清单 → 让 AI Agent 一个接一个地做 → 做完自动提交 → 循环直到全部完成

但实现起来，这个 2000+ 行的 Shell 项目藏着不少巧妙设计。

### 项目统计

| 维度 | 数据 |
|------|------|
| 主脚本 | `ralph.sh`（约 200 行） |
| 库模块 | 15 个 `scripts/lib/*.sh` |
| 总代码量 | 约 2200+ 行 Bash |
| 支持 Agent | Claude Code / Codex / Copilot / Cursor / Gemini / OpenCode |
| 依赖 | Bash 3.x+, Git, Docker (sbx), jq (可选) |

---

## 二、整体架构：模块化 Shell 框架

```
┌──────────────────────────────────────────────────────────────┐
│                     ralph.sh (主控制器)                        │
│  source 15 个 lib 模块 → 解析参数 → 预检查 → 主循环           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ args.sh  │ │agents.sh │ │promise.sh│ │spinner.sh│       │
│  │ 参数解析  │ │Agent管理  │ │ 标签协议  │ │ 旋转动画  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │preflight │ │ preview  │ │  output  │ │  timing  │       │
│  │ 预检查    │ │ 滚动预览  │ │ JSON解析 │ │ 时间统计  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │display.sh│ │cleanup.sh│ │ notify.sh│ │terminal  │       │
│  │ UI 显示   │ │ 清理资源  │ │ 通知提醒  │ │ 终端工具  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │logging.sh│ │constants │ │screenshot│                   │
│  │ 日志系统  │ │ 常量定义  │ │ 截图功能  │                   │
│  └──────────┘ └──────────┘ └──────────┘                   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                   Docker Sandboxes (sbx)                      │
│              ralph-claude-myproject-a1b2c3d4                  │
├──────────────────────────────────────────────────────────────┤
│          Claude Code / Codex / Copilot / Cursor / ...         │
│             读取 PROMPT.md + tasks.json → 执行任务            │
└──────────────────────────────────────────────────────────────┘
```

每个模块职责单一，通过 `source` 引入，没有复杂的依赖关系。这在 Shell 脚本里算是相当工程化的做法了。

---

## 三、核心模块深度解析

### 3.1 `ralph.sh` — 主循环引擎

这是整个框架的心脏，核心逻辑不到 100 行：

```bash
# 主循环结构（简化）
for i in $(seq 1 $MAX_ITERATIONS); do
    # 1. 启动旋转动画（后台进程）
    start_spinner "$iteration" "$total"

    # 2. 构建 Agent 命令
    AGENT_CMD=$(build_agent_command "$AGENT" "$SANDBOX_NAME")

    # 3. 用 script 提供伪 TTY，后台运行 Agent
    script -q "$OUTPUT_FILE" bash -c "$AGENT_CMD" >/dev/null 2>&1 &
    AGENT_PID=$!

    # 4. 实时监控输出文件变化
    while kill -0 "$AGENT_PID" 2>/dev/null; do
        # 增量读取新内容
        new_content=$(tail -c +$((LAST_POS + 1)) "$OUTPUT_FILE")
        # 逐行解析 JSON 流
        while IFS= read -r line; do
            parsed=$(parse_json_content "$line")
            # 更新 spinner 当前步骤
            update_spinner_step "$parsed"
            # 检测 Promise 标签
            check_promise_tags "$parsed"
        done <<< "$new_content"
        sleep 0.2  # 200ms 轮询间隔
    done

    # 5. Agent 退出后，检查标签决定下一步
    if has_complete_tag; then exit $EXIT_COMPLETE; fi
    if has_blocked_tag; then exit $EXIT_BLOCKED; fi
    if has_decide_tag; then exit $EXIT_DECIDE; fi
done
```

**关键设计点：**

| 设计 | 实现方式 | 为什么这样设计 |
|------|---------|---------------|
| **伪 TTY** | `script -q` 命令 | Docker 沙箱需要交互式终端才能正常工作 |
| **后台进程** | `&` + `kill -0` 检测存活 | 主进程可以同时做监控和 UI 更新 |
| **增量读取** | `tail -c +$offset` | 避免重复解析已处理内容 |
| **200ms 轮询** | `sleep 0.2` | 平衡响应速度和 CPU 消耗 |
| **文件通信** | STEP_FILE / PREVIEW_LINE_FILE | 主进程和 spinner 子进程通过文件共享状态 |

---

### 3.2 `agents.sh` — 多 Agent 抽象层

Ralph 支持 6 种不同的 AI 编程工具，通过统一的抽象层管理：

```bash
SUPPORTED_AGENTS="claude codex copilot cursor gemini opencode"

# 每种 Agent 的命令构建方式不同
build_agent_command() {
    case "$agent" in
        claude)
            # Claude Code: 使用 stream-json 输出格式
            printf '%s -- --output-format stream-json --verbose%s -p "%s"'
                "$sbx_run" "$extra_args" "$PROMPT_CONTENT"
            ;;
        codex)
            # OpenAI Codex: 直接执行提示词
            printf '%s -- exec%s "%s"'
                "$sbx_run" "$extra_args" "$PROMPT_CONTENT"
            ;;
        # ... 其他 Agent 类似
    esac
}
```

**确定性沙箱命名：**

```bash
build_sandbox_name() {
    local safe_agent=$(sanitize_name "$agent")
    local safe_project=$(sanitize_name "$(basename "$PWD")")
    local hash=$(echo -n "$PWD" | shasum -a 256 | cut -c1-8)
    printf "ralph-%s-%s-%s" "$safe_agent" "$safe_project" "$hash"
}
```

这意味着：
- 同一个项目 + 同一个 Agent = 始终复用同一个沙箱
- 不同 Agent 有独立沙箱，互不干扰
- 沙箱内的文件变更在迭代间持久化

---

### 3.3 `promise.sh` — Agent 通信协议（最精妙的设计！）

这是 Ralph 最巧妙的部分。传统 Agent 循环的问题是：Agent 遇到困难时只能硬着头皮继续或者直接崩溃。Ralph 引入了**语义化标签协议**：

| 标签 | 含义 | Agent 什么时候输出 |
|------|------|-------------------|
| `<promise>COMPLETE</promise>` | 所有任务完成 | tasks.json 全部 passes=true |
| `<promise>BLOCKED:原因</promise>` | 技术阻塞 | API 不可用、凭证缺失、环境问题 |
| `<promise>DECIDE:问题</promise>` | 需要人类决策 | 架构选择、依赖冲突、需求歧义 |
| `<promise>TASK-{ID}:DONE</promise>` | 单个任务完成 | 成功完成某个任务 |

```bash
# 检测逻辑
check_promise_tags() {
    local line="$1"

    if echo "$line" | grep -q '<promise>COMPLETE</promise>'; then
        echo "🎉 所有任务完成！"
        exit $EXIT_COMPLETE
    fi

    if echo "$line" | grep -q '<promise>BLOCKED:'; then
        local reason=$(echo "$line" | sed 's/.*<promise>BLOCKED://;s/<\/promise>.*//')
        display_blocked_message "$reason" "$iteration"
        exit $EXIT_BLOCKED
    fi

    if echo "$line" | grep -q '<promise>DECIDE:'; then
        local question=$(echo "$line" | sed 's/.*<promise>DECIDE://;s/<\/promise>.*//')
        display_decide_message "$question" "$iteration"
        exit $EXIT_DECIDE
    fi
}
```

**为什么这个设计精妙？**

1. **Agent 可以主动"举手"** — 不需要人类一直盯着屏幕
2. **语义清晰** — COMPLETE/BLOCKED/DECIDE 三种状态覆盖了所有场景
3. **零额外依赖** — 纯文本标签，任何 Agent 都能输出
4. **可恢复** — BLOCKED/DECIDE 退出后，人类解决问题，重新运行 `./ralph.sh` 就能继续

---

### 3.4 `spinner.sh` — 实时状态可视化

长时间运行的 Agent 最怕"黑盒"——不知道它在干什么。Ralph 的 spinner 解决了这个问题：

```bash
# 14 种旋转字符 + 当前步骤名 + 最新输出行
SPIN_CHARS=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

start_spinner() {
    (
        while true; do
            local char="${SPIN_CHARS[$index]}"
            local step=$(cat "$STEP_FILE" 2>/dev/null)
            local preview=$(cat "$PREVIEW_LINE_FILE" 2>/dev/null)

            # 输出格式：旋转字符 + 步骤名 + 最新输出
            printf "\r  %s %s\n  ▸ %s" "$char" "$step" "$preview"

            # 光标上移两行（下次刷新覆盖）
            printf "\033[2A"
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
}
```

效果类似：
```
  ⠼ Implementing
  ▸ Write file_path=/src/components/Button.tsx
```

每 100ms 刷新一次，实时展示 Agent 在做什么。

---

### 3.5 `timing.sh` — 精细化时间统计

Ralph 把 Agent 的工作分成了 14 种步骤类型，每种独立计时：

```bash
STEP_NAMES=(
    "Thinking" "Planning" "Reading code" "Web research"
    "Implementing" "Debugging" "Writing tests" "Testing"
    "Linting" "Typechecking" "Installing" "Verifying"
    "Waiting" "Committing"
)
```

每个步骤都有对应的 Emoji：
- 🤔 Thinking
- 🗺️ Planning
- 📖 Reading code
- 🌐 Web research
- ⚡ Implementing
- 🐛 Debugging
- ✍️ Writing tests
- 🧪 Testing
- 🧹 Linting
- 📝 Typechecking
- 📦 Installing
- ✅ Verifying
- ⏳ Waiting
- 🚀 Committing

**步骤检测**通过正则匹配 Agent 的输出来判断当前在做什么：

```bash
detect_step() {
    local line="$1"

    # IMPLEMENTING - 检测文件写入操作
    if echo "$line" | grep -qiE "(Write|Edit).*file_path"; then
        echo "Implementing"
    # TESTING - 检测测试运行
    elif echo "$line" | grep -qiE "(npm|yarn) (run )?(test|e2e)"; then
        echo "Testing"
    # DEBUGGING - 检测错误调查
    elif echo "$line" | grep -qiE "(investigating|debugging|root cause)"; then
        echo "Debugging"
    # ... 14 种步骤的检测规则
    fi
}
```

最终输出格式：
```
📊 Session totals: ⚡ Implementing: 12:35 │ 🧪 Testing: 05:22 │ 📖 Reading code: 03:15 │ 🐛 Debugging: 02:40
```

---

### 3.6 `output.sh` — JSON 流解析

Claude Code 使用 `stream-json` 格式输出，Ralph 需要从中提取人类可读的文本：

```bash
parse_json_content() {
    local json_line="$1"

    # 优先使用 jq（正确处理转义）
    if command -v jq &>/dev/null; then
        text=$(echo "$json_line" | jq -r '.delta.text // .text // empty')
    else
        # 降级方案：纯 grep + sed
        text=$(echo "$json_line" | grep -o '"text":"[^"]*"' | head -1 | sed 's/"text":"//;s/"$//')
    fi

    # 提取工具调用信息（用于 spinner 步骤检测）
    local tool_name=$(echo "$json_line" | grep -o '"name":"[^"]*"')
    if [ -n "$tool_name" ]; then
        echo "$tool_name file_path=$file_path"
    fi
}
```

**设计亮点：** jq 优先，但有降级方案——即使没有 jq 也能工作。

---

### 3.7 `preview.sh` — 滚动预览缓冲区

```bash
PREVIEW_LINES=50          # 保留最近 50 行
PREVIEW_WIDTH=80          # 默认宽度
LINE_BUFFER=()            # 环形缓冲区

add_to_rolling_preview() {
    local line="$1"
    [ -z "$line" ] && return

    # 截断到终端宽度
    line=$(truncate_line "$line" $PREVIEW_WIDTH)

    # 添加到缓冲区
    LINE_BUFFER+=("$line")

    # 保持最多 50 行
    if [ ${#LINE_BUFFER[@]} -gt $PREVIEW_LINES ]; then
        LINE_BUFFER=("${LINE_BUFFER[@]:1}")  # 移除最旧的行
    fi

    # ANSI 光标控制重绘
    redraw_rolling_preview
}
```

这个设计让用户始终能看到 Agent 最近的输出，又不会刷屏。

---

### 3.8 `preflight.sh` — 启动前检查

```bash
check_required_files() {
    # 必需文件（缺失则退出）
    if [ ! -f "$SCRIPT_DIR/.agent/tasks.json" ]; then
        log_error "Required file missing: .agent/tasks.json"
        missing_required=true
    fi
    if [ ! -f "$SCRIPT_DIR/.agent/PROMPT.md" ]; then
        log_error "Required file missing: .agent/PROMPT.md"
        missing_required=true
    fi

    # 可选文件（缺失仅警告）
    if [ ! -f "$SCRIPT_DIR/.agent/prd/SUMMARY.md" ]; then
        log_warn "Optional file missing: .agent/prd/SUMMARY.md"
    fi
}
```

---

## 四、数据流全景

```
┌──────────────┐     ┌───────────────┐     ┌──────────────────┐
│   PRD.md     │────▶│  tasks.json   │────▶│ TASK-{ID}.json  │
│  (需求文档)   │     │  (任务清单)    │     │  (详细任务步骤)   │
└──────────────┘     └───────────────┘     └──────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
┌──────────────────────────────────────────────────────────┐
│                   Ralph 主循环                            │
│                                                          │
│  ① 读取 tasks.json，选最高优先级 passes=false 的任务      │
│  ② 构建 Agent 命令（PROMPT.md + 当前任务上下文）           │
│  ③ 在 Docker 沙箱中启动 Agent                            │
│  ④ 实时监控输出：更新 spinner + 检测 Promise 标签         │
│  ⑤ Agent 退出后：                                        │
│     - COMPLETE → 全部完成，退出                           │
│     - BLOCKED → 显示原因，退出等待人工介入                 │
│     - DECIDE  → 显示问题，退出等待决策                    │
│     - 正常结束 → 更新 tasks.json，进入下一轮              │
│                                                          │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│                    输出产物                               │
│  📁 .agent/history/ITERATION-{date}-{n}.txt              │
│  📋 .agent/logs/LOG.md                                  │
│  🖼️ .agent/screenshots/TASK-{ID}-{index}.png            │
│  📊 时间统计：每个步骤的耗时分布                          │
└──────────────────────────────────────────────────────────┘
```

---

## 五、关键设计模式总结

### 5.1 模式一：Promise 标签协议

```
Agent 输出 <promise>COMPLETE</promise>
         ↓
Ralph 检测到标签
         ↓
Ralph 退出循环，显示完成统计

Agent 输出 <promise>BLOCKED:API key expired</promise>
         ↓
Ralph 检测到标签
         ↓
Ralph 显示阻塞原因 + 恢复指令，退出等待人工
         ↓
人类修复 API key
         ↓
重新运行 ./ralph.sh → 从上次位置继续
```

这是 **人机协作的优雅实现**——Agent 不需要内置所有异常处理逻辑，遇到问题时"举手"即可。

### 5.2 模式二：文件通信

Ralph 的主进程和 spinner 子进程通过文件共享状态：

```
主进程                          Spinner 子进程
   │                                │
   ├─ 写入 STEP_FILE ──────────────▶│ 读取并显示
   ├─ 写入 PREVIEW_LINE_FILE ──────▶│ 读取并显示
   │                                │
```

这种设计避免了复杂的进程间通信机制，简单可靠。

### 5.3 模式三：增量文件监控

```
Agent 输出 → script 写入 OUTPUT_FILE
                      ↓
主进程 tail -c +$offset 读取增量
                      ↓
逐行解析 JSON → 更新 UI + 检测标签
                      ↓
sleep 0.2 → 下一轮检查
```

不需要 `inotify` 或 `fswatch`，纯 POSIX 兼容。

### 5.4 模式四：确定性沙箱

```
项目路径 + Agent 名称 → SHA256 hash → 沙箱名称
                                        ↓
                        ralph-claude-myproject-a1b2c3d4
```

同一项目同一 Agent 始终使用同一沙箱，状态在迭代间持久化。

---

## 六、剩余模块速览

### 6.1 `logging.sh` — 彩色日志系统

```bash
log_info()    echo -e "${B}[INFO]${R} $1"     # 蓝色
log_success() echo -e "${GR}[OK]${R} $1"     # 绿色
log_warn()    echo -e "${Y}[WARN]${R} $1"    # 黄色
log_error()   echo -e "${RD}[ERROR]${R} $1" >&2  # 红色 → stderr
```

极简但实用，所有模块统一使用这四个函数输出日志。

### 6.2 `constants.sh` — 全局常量与颜色定义

```bash
# 颜色常量
R='\033[0m'     # Reset
RD='\033[0;31m' # Red
GR='\033[0;32m' # Green
Y='\033[0;33m'  # Yellow
B='\033[0;34m'  # Blue
M='\033[0;35m'  # Magenta
C='\033[0;36m'  # Cyan

# 文件路径
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HISTORY_DIR="$SCRIPT_DIR/.agent/history"
LOG_FILE="$SCRIPT_DIR/.agent/logs/LOG.md"

# 退出码
EXIT_COMPLETE=42
EXIT_BLOCKED=43
EXIT_DECIDE=44
EXIT_ITERATIONS=45
```

退出码设计很讲究——用 42-45 而不是 0-1，这样调用方可以区分"正常完成"和"需要人工介入"。

### 6.3 `cleanup.sh` — 资源清理

```bash
cleanup() {
    # 停止 spinner 子进程
    if [ -n "$SPINNER_PID" ]; then
        kill "$SPINNER_PID" 2>/dev/null
    fi
    # 停止 Agent 进程
    if [ -n "$AGENT_PID" ]; then
        kill "$AGENT_PID" 2>/dev/null
    fi
    # 记录最后一步时间
    record_step_time ""
}

trap cleanup EXIT INT TERM
```

通过 `trap` 注册，无论正常退出还是 Ctrl+C 都能清理干净。

### 6.4 `notify.sh` — 系统通知

```bash
send_notification() {
    local title="$1"
    local message="$2"
    if command -v osascript &>/dev/null; then
        osascript -e "display notification \"$message\" with title \"$title\""
    elif command -v notify-send &>/dev/null; then
        notify-send "$title" "$message"
    fi
}
```

Agent 跑完或阻塞时发系统通知，这样你可以去喝咖啡，不用一直盯着屏幕。

### 6.5 `terminal.sh` — 终端工具

```bash
get_terminal_width() {
    tput cols 2>/dev/null || echo 80
}

truncate_line() {
    local line="$1"
    local max_width="$2"
    if [ ${#line} -gt "$max_width" ]; then
        echo "${line:0:$((max_width - 3))}..."
    else
        echo "$line"
    fi
}
```

提供终端宽度检测和文本截断，让 UI 自适应不同终端大小。

### 6.6 `screenshot.sh` — 截图功能

Ralph 在每次迭代中可以自动截图（macOS 用 `screencapture`，Linux 用 `import`），保存到 `.agent/screenshots/` 目录。这样即使你不在电脑前，也能回看 Agent 的每一步操作画面。

---

## 八、代码质量评估

| 维度 | 评分 | 说明 |
|------|------|------|
| **模块化** | ⭐⭐⭐⭐⭐ | 15 个独立模块，职责清晰 |
| **可读性** | ⭐⭐⭐⭐ | 注释充分，函数命名直观 |
| **健壮性** | ⭐⭐⭐⭐ | trap 清理、降级方案、错误处理完善 |
| **可扩展性** | ⭐⭐⭐⭐⭐ | 新增 Agent 只需在 agents.sh 添加 case |
| **兼容性** | ⭐⭐⭐⭐ | Bash 3.x+ 兼容，jq 可选 |
| **可观测性** | ⭐⭐⭐⭐⭐ | 时间统计、日志、截图、实时预览 |

---

## 九、与同类方案对比

| 特性 | Ralph Loop | Claude Code 原生 | Aider | Cline |
|------|-----------|-----------------|-------|-------|
| **多 Agent 支持** | ✅ 6 种 | ❌ 仅 Claude | ❌ 仅 LLM API | ❌ 仅 LLM API |
| **自主循环** | ✅ 内置 | ❌ 需手动 | ✅ 内置 | ❌ 需手动 |
| **Promise 协议** | ✅ 独有 | ❌ | ❌ | ❌ |
| **时间统计** | ✅ 14 种步骤 | ❌ | ❌ | ❌ |
| **实时预览** | ✅ 滚动缓冲 | ❌ | ❌ | ❌ |
| **沙箱隔离** | ✅ Docker | ❌ | ❌ | ❌ |
| **实现语言** | Bash | TypeScript | Python | TypeScript |
| **依赖复杂度** | 极低 | 中等 | 低 | 高 |

Ralph Loop 的独特价值在于：**用最朴素的 Shell 脚本，实现了最完整的 Agent 循环基础设施**。

---

## 十、适用场景与局限

### ✅ 最适合

- PRD 驱动的批量功能实现
- 需要 AI 长时间自主编码（跑一晚上，早上看结果）
- 有明确验收标准（typecheck/lint/test）的项目
- 需要支持多种 AI 编程工具切换的场景

### ⚠️ 不太适合

- 探索性编程（需求不明确）
- 需要复杂上下文理解的架构设计
- 没有自动化测试的项目
- Windows 环境（依赖 Bash + Docker）

---

## 十一、总结

Ralph Loop 是一个**小而美的工程典范**。它没有用任何 fancy 的技术栈，就用 Bash + Docker + Git 这三板斧，构建了一个完整的 AI Agent 自主循环系统。

最值得学习的设计：

1. **Promise 标签协议** — 让 Agent 能主动中断循环寻求帮助
2. **模块化 Shell 架构** — 15 个独立模块，职责清晰
3. **文件通信模式** — 简单可靠的进程间状态共享
4. **确定性沙箱命名** — 保证可复现性和状态持久化
5. **降级方案设计** — jq 优先但非必需

如果你想基于这个改造自己的 coding agent，这些设计都值得借鉴。

---

## 十二、PROMPT.md 深度解读 — Agent 的"灵魂指令"

Ralph 的核心魔法不光在代码里，更在 `.agent/PROMPT.md` 这个提示词文件里。这是发给 AI Agent 的"任务说明书"，让我们看看它写了什么：

```markdown
> ⛔ **ONE TASK PER INVOCATION** — Complete one task from tasks.json,
>   verify it passes all checks, then stop. Do not start another task.

1. Read .agent/PROMPT.md, .agent/prd/SUMMARY.md, and .agent/prd/PRD.md
2. Find the highest-priority incomplete task in .agent/tasks.json
3. Read the task's detailed spec in .agent/tasks/TASK-{ID}.json
4. Implement the task following the spec's steps
5. Verify: run tests, linting, and type checking
6. Update task status in tasks.json (passes → true)
7. Commit changes with a descriptive message
```

### 关键约束分析

| 约束 | 目的 |
|------|------|
| **ONE TASK PER INVOCATION** | 防止 Agent 贪多嚼不烂，一次只做一个任务 |
| **必须先读文档** | 让 Agent 理解项目全貌，避免瞎写 |
| **按优先级选任务** | 保证关键路径优先完成 |
| **必须通过所有检查** | test + lint + typecheck 三重门禁 |
| **必须 commit** | 每个任务独立提交，方便回滚和追踪 |
| **完成后停止** | 由 Ralph 主循环决定是否继续下一轮 |

这本质上是一个**受控的自主 Agent 协议**——Agent 有自主权（选任务、写代码），但边界清晰（一次一个、必须验证、完成后停手）。

---

## 十三、Getting Started 文档解读

从 [ralphloop.sh/getting-started](https://ralphloop.sh/getting-started/) 的文档来看，Ralph 的使用流程非常清晰：

### 三步启动

```
Step 1: 创建 PRD（用 prd-creator skill）
  └─ 把需求丢给 AI，让它用 prd-creator 生成 PRD.md

Step 2: 确保 .agent/ 目录有必需文件
  ├─ .agent/prd/PRD.md        ← 产品需求文档
  ├─ .agent/prd/SUMMARY.md    ← 项目概述
  ├─ .agent/tasks.json        ← 任务清单（可由 PRD 自动生成）
  ├─ .agent/tasks/            ← 每个任务的详细步骤
  ├─ .agent/PROMPT.md         ← Agent 指令
  └─ .agent/logs/LOG.md       ← 进度日志（自动创建）

Step 3: 运行 Ralph！
  └─ ./ralph.sh               # 默认 Claude，10 轮迭代
  └─ ./ralph.sh -a codex      # 换用 Codex
  └─ ./ralph.sh --once        # 只跑一轮
```

### 每次迭代 Agent 做什么

1. 找到 `tasks.json` 中优先级最高、尚未完成的任务
2. 读取 `TASK-{ID}.json` 中的详细步骤
3. 执行测试、lint、类型检查
4. 更新任务状态并 commit
5. 重复直到所有任务通过或达到最大迭代次数

---

## 十四、俺老猪的最终点评 🐷

Ralph Loop 这玩意儿，说它是 **"Shell 脚本界的瑞士军刀"** 一点不夸张。用俺老猪的话说：

> 🐷 "看着笨拙，但干起活来真不含糊！"

### 最让我惊艳的三个设计

1. **Promise 标签协议** — 这是我见过最优雅的人机协作方式。Agent 不用内置所有异常处理，遇到问题"举手"就行，人类解决后继续跑。比那些动不动就 crash 的 Agent 循环强太多了。

2. **文件通信模式** — 主进程写 `STEP_FILE`，spinner 子进程读 `STEP_FILE`，就这么简单。没有消息队列、没有 socket、没有共享内存。大道至简。

3. **确定性沙箱命名** — `SHA256(项目路径 + Agent名)` 生成沙箱名。同一项目同一 Agent 永远用同一个沙箱，状态自然持久化。简单到让人拍大腿。

### 局限性也要说

- 依赖 Docker（`sbx` 命令），没装 Docker 玩不转
- 只支持 macOS/Linux，Windows 用户得用 WSL
- 目前 tasks.json 需要手动或通过 PRD 工具生成，没有内置的自动任务分解
- 错误恢复依赖人工介入，没有自动重试机制

### 适合谁用？

- 有明确 PRD 的项目，想"丢给 AI 跑一晚上"
- 需要支持多种 AI 编程工具切换的团队
- 想学习 Shell 脚本工程化的人（这代码写得真不错）

---

> 📝 **本文基于 Ralph Loop v1.x 源码分析，所有代码版权归 [pageai-pro/ralph-loop](https://github.com/pageai-pro/ralph-loop) 项目所有。**
> 
> 🐷 俺老猪花了两个时辰把 16 个 Bash 模块全扒了一遍，希望对你有帮助！有问题随时问俺～

---

> 🐷 俺老猪写完了！这个 Ralph 虽然是个 Shell 脚本项目，但架构设计比很多 Node.js/Python 项目都讲究。特别是那个 Promise 标签协议——Agent 遇到问题能"举手"，人类修好后继续跑，这个设计太巧妙了！

*本文分析基于 [Ralph Loop v1.0](https://github.com/pageai-pro/ralph-loop)，代码获取时间 2026-05-06。*
