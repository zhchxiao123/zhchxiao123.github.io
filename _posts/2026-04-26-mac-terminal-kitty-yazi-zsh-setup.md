---
title: 我的 Mac 终端三件套：Kitty + Yazi + Zsh，颜值与效率双起飞
date: 2026-04-26 18:20:00 +0800
description: 一套完整的 Mac 终端配置方案，包含 Kitty 终端、Yazi 文件管理器、Zsh 增强、Starship 提示符，以及 eza/bat/fd/fzf/zoxide 等效率工具的保姆级安装和使用教程
tags:
  - Mac
  - Kitty
  - Yazi
  - Zsh
  - Starship
  - 终端配置
  - 效率工具
categories:
  - 效率工具
  - 开发环境
---

## 为什么终端在 AI 时代变得前所未有地重要

![终端美化](./assets/img/mac-terminal-kitty-yazi-zsh-setup/image.png)

大模型正在重新定义软件开发的工作方式，而一个容易被忽视的事实是：**这一轮变革的主战场在终端，不在 IDE。**

Claude Code、Aider、Cursor Agent、Codex CLI —— 当下最前沿的 AI 编程工具，无一例外以命令行为核心交互界面。这不是偶然。终端拥有 IDE 永远无法匹敌的优势：它是 AI Agent 的原生操作系统 —— 无需 GUI 层的翻译与适配，指令直达内核；它是无限可组合的工作流管道 —— `git diff` 的输出可以直接喂给 AI，AI 的修改可以直接进入 `git commit`；它还是最轻量的上下文容器 —— 几十行配置就能构建一套完整的开发环境，而不是动辄数 GB 的 IDE 插件生态。

但现实是，大多数开发者的终端还停留在默认状态：白色背景、无图标、无分屏、无智能跳转。用这样的终端和 AI 协作，就像开着面包车跑 F1 —— 引擎再强，底盘拖后腿。

**你的终端就是你和 AI 之间的工作台。** 工作台越高效，AI 的产出越能被充分利用。

本文提供的是一套经过实战验证的终端配置方案，专为 AI 时代的开发者设计：

- **分屏是刚需** — 左屏跑 Claude Code，右屏跑测试/日志，AI 的输出和验证结果同屏可见
- **文件浏览要快** — AI 改了 20 个文件，你需要一眼看清改动范围，`yd` 一键定位
- **Git 集成要深** — 每次提交都有 AI 的痕迹，提示符实时显示仓库状态，`gs` 比 GUI 更快
- **视觉要统一** — 深色主题保护长时间工作的眼睛，Catppuccin Mocha 让 Kitty/Yazi/Starship/bat 一体化

> 6 个配置文件 + 1 段 Zsh 增强，统一 Catppuccin Mocha 深色主题。每个配置文件都是完整可复制的最佳实践，附带逐行注释和踩坑说明。

## 配置总览

|组件|版本|用途|配置文件|
|-|-|-|-|
|🐱 Kitty|0.46+|GPU 加速终端模拟器|`~/.config/kitty/kitty.conf`|
|📂 Yazi|26.x|超快终端文件管理器|`~/.config/yazi/yazi.toml` + `keymap.toml` + `theme.toml`|
|🐚 Zsh|系统自带|Shell 增强与别名|`~/.zshrc` 末尾追加|
|🚀 Starship|1.x|跨 Shell 自定义提示符|`~/.config/starship.toml`|
|🧰 eza|0.23+|`ls` 替代，图标 + Git 状态|通过 Zsh 别名调用|
|🦇 bat|0.26+|`cat` 替代，语法高亮 + 行号|通过 Zsh 别名调用|


辅助工具：zoxide（智能 cd）、fzf（模糊搜索）、fd（快速查找）、ripgrep（快速 grep）

---

## 一键安装

从零开始，执行以下命令即可完成全部安装：

```Bash
# 核心工具
brew install kitty yazi starship eza bat zoxide fzf fd ripgrep neovim

# Nerd Font（图标显示必需）
brew install --cask font-jetbrains-mono-nerd-font

# 创建配置目录
mkdir -p ~/.config/kitty ~/.config/yazi ~/.config/starship ~/.config/bat
```

安装完成后，把下面 6 个配置文件放到对应位置，然后在 `~/.zshrc` 末尾追加 Zsh 增强段，重启终端即可。

---

## 文件 1：~/.config/kitty/kitty.conf

```Ini
# ============================================
# 🐱 Kitty 终端配置 — Catppuccin Mocha 主题
# ============================================

# ---------- 字体 ----------
# 使用 Nerd Font 版本，图标才不会显示为方框
# 安装：brew install --cask font-jetbrains-mono-nerd-font
# ⚠️ 字体名必须和 fc-list 输出完全一致，不能用简称
font_family      JetBrainsMono Nerd Font
bold_font        JetBrainsMono Nerd Font Bold
italic_font      JetBrainsMono Nerd Font Italic
font_size        14

# ---------- 窗口 ----------
window_padding_width    8
# ⚠️ 用字符单位 (c) 而非像素，确保不同 DPI 下尺寸一致
initial_window_width    120c
initial_window_height   36c
hide_window_decorations yes
confirm_os_window_close 0
remember_window_size    yes

# ---------- 布局 ----------
# ⚠️ 必须启用 splits 布局，否则 hsplit/vsplit 行为一致
# blossom 不是有效布局名，Kitty 0.46 支持的布局：splits,stack,fat,grid,horizontal,vertical
enabled_layouts splits,stack,fat,grid,horizontal,vertical

# ---------- 分屏快捷键 ----------
# ⚠️ Kitty 的 map 行不支持行内 # 注释！注释必须写在独立行
# 否则会报错 "Failed to launch child: #"
# hsplit = 水平分割线（上下分屏，新面板在下方）
# vsplit = 垂直分割线（左右分屏，新面板在右侧）
# ⚠️ macOS 上 ctrl+shift+minus 容易被系统拦截，用 ctrl+shift+backslash 更可靠
# ⚠️ --cwd=current 让新分屏继承当前目录，否则会打开 ~
map ctrl+shift+enter       launch --location=hsplit --cwd=current
map ctrl+shift+backslash   launch --location=vsplit --cwd=current
# 关闭当前分屏面板
map ctrl+shift+w           close_window
# 分屏间移动（Vim 风格 HJKL）
map ctrl+shift+h           neighboring_window left
map ctrl+shift+j           neighboring_window down
map ctrl+shift+k           neighboring_window up
map ctrl+shift+l           neighboring_window right
# 布局
map ctrl+shift+z           toggle_layout stack
map ctrl+shift+space       next_layout
map ctrl+shift+f           toggle_fullscreen

# ---------- 标签页 ----------
map ctrl+shift+t       new_tab
map ctrl+shift+right  next_tab
map ctrl+shift+left   previous_tab
map ctrl+shift+q      close_tab

# ---------- 复制粘贴 ----------
map ctrl+shift+c       copy_to_clipboard
map ctrl+shift+v       paste_from_clipboard

# ---------- 字体缩放 ----------
map ctrl+plus          change_font_size all +2.0
map ctrl+minus         change_font_size all -2.0
map ctrl+0             change_font_size all 0

# ---------- 光标 ----------
cursor_shape           block
cursor_blink_interval  0.5

# ---------- 滚动 ----------
scrollback_lines       10000
wheel_scroll_multiplier 5.0

# ---------- 交互增强 ----------
enable_audio_bell      no
allow_remote_control   yes
url_style              curly
url_prefixes           file http https ftp ftps gemini git
open_url_with          default

# ---------- 标签栏样式 ----------
tab_bar_edge          bottom
tab_bar_style         powerline
tab_powerline_style   slanted
active_tab_font_style bold
tab_title_template    " {index}: {title} "
active_tab_foreground   #1e1e2e
active_tab_background  #89b4fa
inactive_tab_foreground   #6c7086
inactive_tab_background  #313244

# ============================================
# 🎨 Catppuccin Mocha — 完整 16 色手动指定
# 不依赖外部主题文件，复制即用
# ============================================
background            #1e1e2e
foreground            #cdd6f4
selection_background  #585b70
selection_foreground  #cdd6f4
url_color             #f5c2e7
cursor                #f5e0dc
active_border_color   #b4befe
inactive_border_color #6c7086
macos_titlebar_color  #1e1e2e

color0  #45475a
color8  #585b70
color1  #f38ba8
color9  #f38ba8
color2  #a6e3a1
color10 #a6e3a1
color3  #f9e2af
color11 #f9e2af
color4  #89b4fa
color12 #89b4fa
color5  #f5c2e7
color13 #f5c2e7
color6  #94e2d5
color14 #94e2d5
color7  #bac2de
color15 #a6adc8
```

### Kitty 踩坑清单

|问题|原因|解决|
|-|-|-|
|分屏报错 `Failed to launch child: #`|`map` 行不支持行内 `#` 注释|注释写在独立行|
|字体回退到 Menlo|字体名和 `fc-list` 输出不一致|用 `fc-list | grep JetBrains` 确认准确名称|
|hsplit/vsplit 效果一样|未启用 `splits` 布局|加 `enabled_layouts splits,stack,...`|
|`blossom` 布局报错|不是有效布局名|用 `splits,stack,fat,grid,horizontal,vertical`|
|macOS 上 `ctrl+shift+-` 不生效|系统拦截或键名识别异常|改用 `ctrl+shift+backslash`|
|分屏后目录变成 `~`|默认 `launch` 不继承当前目录|加 `--cwd=current`|
|SSH 后 vim/less 报错|远程服务器没有 Kitty terminfo|用 `infocmp` 检测后再设 `TERM`（见 Zsh 配置段）|
|修改配置后不生效|需要重载|`kitty @ load-config` 或重启 Kitty|


---

## 文件 2：~/.config/yazi/yazi.toml

```Toml
# ============================================
# 📂 Yazi 文件管理器 — 核心配置
# ============================================

[mgr]
show_hidden = true
sort_by = "alphabetical"
sort_dir_first = true
sort_reverse = false
scrolloff = 2

[preview]
max_width = 600
max_height = 900
image_quality = 75
# triangle 是速度和画质的平衡点，nearest 模糊，gaussian 慢
image_filter = "triangle"

# ---------- 打开方式 ----------
# ⚠️ Yazi 0.4+ 把 run 字段改为了 use，旧版用 run 会报 "missing field `use`"
# use = "edit" 用编辑器打开（文本文件推荐）
# use = "open" 用系统默认程序打开
# use = "reveal" 在文件管理器中显示
[open]
rules = [
  { mime = "text/*",              use = "edit" },
  { mime = "image/*",             use = "open" },
  { mime = "video/*",             use = "open" },
  { mime = "audio/*",             use = "open" },
  { mime = "application/pdf",    use = "open" },
  { name = "*",                   use = "open" },
]
```

### Yazi 踩坑清单

|问题|原因|解决|
|-|-|-|
|报错 `missing field 'use'`|Yazi 0.4+ 将 `run` 改为了 `use`|把 `run = "open"` 改为 `use = "open"`|
|报错 `invalid key-value pair`|keymap.toml 用了旧的内联表格式|改为 `[[manager.keymap]]` 数组表格式|
|图标显示方框|未安装 Nerd Font|安装 `font-jetbrains-mono-nerd-font`|
|退出后目录没变|没用 `y` 函数启动|用 `y` 代替 `yazi` 命令（见 Zsh 配置段）|
|j/k 方向反了|`arrow 1` 是下移，`arrow -1` 是上移|j→`arrow 1`，k→`arrow -1`|


---

## 文件 3：~/.config/yazi/keymap.toml

```Toml
# ============================================
# ⌨️ Yazi 快捷键配置
# ⚠️ Yazi 0.4+ 必须使用 [[manager.keymap]] 数组表格式
# 旧版内联表格式 { on = [...], run = "..." } 会报错
# ============================================

# 导航 — Vim 风格 HJKL
[[manager.keymap]]
on = [ "h" ]
run = "leave"
desc = "返回上级目录"

[[manager.keymap]]
on = [ "j" ]
run = "arrow 1"
desc = "向下移动"

[[manager.keymap]]
on = [ "k" ]
run = "arrow -1"
desc = "向上移动"

[[manager.keymap]]
on = [ "l" ]
run = "enter"
desc = "进入目录 / 打开文件"

# 智能跳转
[[manager.keymap]]
on = [ "z" ]
run = "cd"
desc = "fzf 快速跳转"

[[manager.keymap]]
on = [ "Z" ]
run = "cd --interactive"
desc = "zoxide 智能跳转"

# 标签页
[[manager.keymap]]
on = [ "t" ]
run = "tab_create"
desc = "新建标签页"

[[manager.keymap]]
on = [ "]" ]
run = "tab_switch 1"
desc = "下一个标签页"

[[manager.keymap]]
on = [ "[" ]
run = "tab_switch -1"
desc = "上一个标签页"

[[manager.keymap]]
on = [ "1" ]
run = "tab_switch 1"
desc = "切换到第 1 个标签页"

[[manager.keymap]]
on = [ "2" ]
run = "tab_switch 2"
desc = "切换到第 2 个标签页"

[[manager.keymap]]
on = [ "3" ]
run = "tab_switch 3"
desc = "切换到第 3 个标签页"

[[manager.keymap]]
on = [ "4" ]
run = "tab_switch 4"
desc = "切换到第 4 个标签页"

[[manager.keymap]]
on = [ "5" ]
run = "tab_switch 5"
desc = "切换到第 5 个标签页"

# 排序 — 逗号作为 leader key
[[manager.keymap]]
on = [ ",", "m" ]
run = "sort_by modified"
desc = "按修改时间排序"

[[manager.keymap]]
on = [ ",", "a" ]
run = "sort_by alphabetical"
desc = "按字母排序"

[[manager.keymap]]
on = [ ",", "s" ]
run = "sort_by size"
desc = "按大小排序"

[[manager.keymap]]
on = [ ",", "r" ]
run = "sort_by random"
desc = "随机排序"
```

---

## 文件 4：~/.config/yazi/theme.toml

```Toml
# Yazi 语法高亮预览使用 Catppuccin Mocha 主题
# 与 Kitty、Starship 配色保持统一
[syntect]
theme = "Catppuccin Mocha"
```

---

## 文件 5：~/.config/starship.toml

```Toml
# ============================================
# 🚀 Starship 提示符 — Catppuccin Mocha 配色
# ============================================

# 单行模式，不浪费垂直空间
add_newline = false

# 提示符格式：
# 第一行：蓝色方块 + 目录 + Git + 语言版本 + 耗时
# 第二行：➜ 输入符（成功绿、失败红）
format = """
[](#89b4fa)\
$directory\
$git_branch\
$git_status\
$nodejs\
$python\
$rust\
$cmd_duration\
$line_break\
$character"""

# 目录 — 蓝色粗体，保留最近 3 层
[directory]
style = "bold #89b4fa"
truncation_length = 3
truncate_to_repo = false

# Git 分支 — 绿色，带图标
[git_branch]
format = " [$branch]($style)"
style = "#a6e3a1"
symbol = "🌿 "

# Git 状态 — 红色，一眼看出变更
[git_status]
conflicted = "🏳"
ahead = "⇡${count}"
behind = "⇣${count}"
diverged = "⇕${count}"
untracked = "?${count}"
stashed = "📦"
modified = "!${count}"
staged = "+${count}"
renamed = "»${count}"
deleted = "✘${count}"
style = "#f38ba8"

# 语言版本 — 只在对应项目目录内才显示
[nodejs]
format = " via [⬢ $version](bold #89b4fa)"

[python]
format = " via [🐍 $version](bold #f5c2e7)"

[rust]
format = " via [🦀 $version](bold #f38ba8)"

# 命令耗时 — 灰色低调，超过 2 秒才显示
[cmd_duration]
format = " [⏱ $duration]($style)"
style = "#6c7086"

# 输入提示符 — 成功绿色、失败红色
[character]
success_symbol = "[➜](bold #a6e3a1)"
error_symbol = "[➜](bold #f38ba8)"
```

### Starship 最佳实践

- **`add_newline = false`** — 开发者屏幕纵向空间宝贵，单行模式更紧凑
- **`truncate_to_repo = false`** — 在 Git 仓库内也显示完整路径层级，避免同名目录混淆
- **语言模块只保留 Node/Python/Rust** — 按需增减，太多语言图标会让提示符很长
- **`cmd_duration`**** 默认 2 秒阈值** — 短命令不显示耗时，长命令才提醒

---

## 文件 6：~/.zshrc 末尾追加段

将以下内容追加到 `~/.zshrc` 末尾（不要替换已有内容）：

```Bash
# ============================================
# 终端三件套（Kitty + Yazi + Zsh）
# ============================================

# ---------- Yazi Shell Wrapper ----------
# 用 y 打开 Yazi，退出后自动 cd 到最后浏览的目录
# ⚠️ 必须用 y 而不是 yazi，否则退出后目录不会变
function y() {
    local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
    command yazi "$@" --cwd-file="$tmp"
    if IFS= read -r -d '' cwd < "$tmp"; then
        [ "$cwd" != "$PWD" ] && [ -d "$cwd" ] && builtin cd -- "$cwd"
    fi
    rm -f -- "$tmp"
}

# ---------- zoxide 智能跳转（替代 cd） ----------
# z foo       → 跳到最常访问的包含 "foo" 的目录
# z foo bar   → 跳到同时包含 "foo" 和 "bar" 的目录
eval "$(zoxide init zsh)"

# ---------- fzf 模糊搜索 ----------
# Tab 补全增强，Ctrl+R 搜索历史
eval "$(fzf --zsh)"

# ---------- 现代 CLI 替代 ----------
# ⚠️ 别名定义顺序很重要：ls 必须先定义，ll/la/lt 才能展开
# eza 替代 ls — 图标 + 颜色 + Git 状态
alias ls='eza --icons=auto'
alias ll='ls -la'
alias la='ls -A'
alias lt='ls --tree'
# bat 替代 cat — 语法高亮 + 行号；管道中自动降级为普通 cat
alias cat='bat'
# ripgrep 替代 grep — 默认递归，尊重 .gitignore
alias grep='rg'
# fd 替代 find — 更直觉的语法，彩色输出
alias find='fd'
# neovim 替代 vim
alias vim='nvim'
alias vi='nvim'

# ---------- 终端快捷键 ----------
alias c='clear'
alias q='exit'
alias reload='source ~/.zshrc'

# ---------- Git 浏览（Yazi + fzf） ----------
# yg: 在 Git 仓库根目录打开 Yazi（按 ,m 按修改时间排序看最近改动）
function yg() {
    local root="$(git rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$root" ]; then
        cd "$root" && y
    else
        echo "不在 Git 仓库中" && return 1
    fi
}

# yd: 从 Git 改动文件中选择，用 Yazi 打开并跳转到该文件
#   yd        → 当前未提交的改动（工作区 + 暂存区）
#   yd 3      → 最近 3 次提交的改动
#   yd HEAD~5  → 某次提交范围的改动
function yd() {
    local files
    if [ -n "$1" ] && [[ "$1" =~ ^[0-9]+$ ]]; then
        # 数字参数：最近 N 次提交的改动
        files="$(git diff --name-only HEAD~${1} HEAD 2>/dev/null)"
    elif [ -n "$1" ]; then
        # 提交范围参数
        files="$(git diff --name-only "$1" 2>/dev/null)"
    else
        # 无参数：工作区 + 暂存区改动
        files="$(git diff --name-only HEAD 2>/dev/null)"
    fi
    if [ -z "$files" ]; then
        echo "没有找到改动文件" && return 1
    fi
    local target="$(echo "$files" | fzf --prompt="改动文件> " --preview='git diff HEAD -- {} | head -80')"
    if [ -n "$target" ]; then
        local dir="$(dirname "$target")"
        [ -d "$dir" ] && cd "$dir" && y
    fi
}

# ---------- Git 快捷键 ----------
alias g='git'
alias gc='git commit'
alias gs='git status'
alias gp='git push'
alias gl='git log --oneline --graph'

# ---------- 路径跳转 ----------
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# ---------- Kitty 终端环境 ----------
# 24 位真色彩支持
export COLORTERM=truecolor
# ⚠️ SSH 到远程服务器时，如果对方没有 Kitty terminfo 就会报错
# 所以先检测再设置，找不到时回退到 xterm-256color
if infocmp xterm-kitty >/dev/null 2>&1; then
    export TERM=xterm-kitty
else
    export TERM=xterm-256color
fi

# ---------- Starship 提示符 ----------
eval "$(starship init zsh)"
```

### Zsh 最佳实践

- **别名顺序** — `ls` 先定义，`ll`/`la`/`lt` 后定义，这样才能正确展开为 `eza --icons=auto -la`
- **`eval`**** 放末尾** — `zoxide init`、`fzf --zsh`、`starship init zsh` 必须在所有别名之后，确保初始化顺序正确
- **`TERM`**** 检测** — 直接写 `TERM=xterm-kitty` 会导致 SSH 到没有 Kitty terminfo 的服务器时 vim/less 报错，必须用 `infocmp` 先检测
- **`bat`**** 自动降级** — 管道中 `bat` 自动变为普通 `cat`，所以 `something | grep foo` 这类用法不会受影响
- **`y`**** 函数** — 用临时文件传递目录，比旧版的 `YA` 环境变量方案更可靠

---

## bat 主题配置：~/.config/bat/config

```Ini
# 使用 Catppuccin Mocha 主题，与终端配色统一
# 主题列表：bat --list-themes
--theme="Catppuccin Mocha"

# 行号始终显示
--style="numbers,changes"

# 使用 --paging=auto 让短输出不分页
--paging=auto
```

安装 Catppuccin Mocha 主题：

```Bash
# bat 内置了 Catppuccin 系列，直接可用
# 如果不可用，手动安装：
mkdir -p "$(bat --config-dir)/themes"
curl -o "$(bat --config-dir)/themes/Catppuccin Mocha.tmTheme" \
  https://raw.githubusercontent.com/catppuccin/bat/main/themes/Catppuccin%20Mocha.tmTheme
bat cache --build
```

---

## 日常使用速查表

```Markdown
┌─────────────────────────────────────────────────────────────┐
│                    Kitty 快捷键                              │
├─────────────────────────────────────────────────────────────┤
│  Ctrl+Shift+Enter       水平分屏（上下分割，新面板在下方）  │
│  Ctrl+Shift+\           垂直分屏（左右分割，新面板在右侧）  │
│  Ctrl+Shift+W           关闭当前分屏面板                  │
│  Ctrl+Shift+H/J/K/L    分屏间移动                        │
│  Ctrl+Shift+Z           堆叠模式                          │
│  Ctrl+Shift+Space       切换布局                          │
│  Ctrl+Shift+F           全屏切换                          │
│  Ctrl+Shift+T           新标签页                          │
│  Ctrl+Shift+←/→         切换标签页                       │
│  Ctrl+Shift+Q           关闭标签页                       │
│  Ctrl++/-/0             字体放大/缩小/重置               │
├─────────────────────────────────────────────────────────────┤
│                    Yazi 快捷键                              │
├─────────────────────────────────────────────────────────────┤
│  H/J/K/L              返回上级/下/上/进入                   │
│  z                    fzf 模糊跳转                          │
│  Z                    zoxide 智能跳转                       │
│  t                    新标签页                              │
│  ]/[                  下一个/上一个标签页                   │
│  1-5                  切换到第 N 个标签页                   │
│  ,m / ,a / ,s         按修改时间/字母/大小排序              │
│  q                    退出（回到最后浏览的目录）             │
├─────────────────────────────────────────────────────────────┤
│                    Shell 命令与别名                          │
├─────────────────────────────────────────────────────────────┤
│  y                    打开 Yazi（退出自动 cd）               │
│  z <关键词>            zoxide 智能跳转                     │
│  ls / ll / la / lt    eza 系列（图标+颜色+Git）           │
│  cat                  bat（语法高亮+行号）                   │
│  grep                 ripgrep（递归+Git感知）               │
│  find                 fd（直觉语法+彩色）                   │
│  .. / ... / ....      上 1/2/3 级目录                      │
│  yg                   Yazi 打开 Git 仓库根目录             │
│  yd                   fzf 选 Git 改动文件 → Yazi 打开       │
│  yd 3                 最近 3 次提交的改动文件              │
│  gs / gc / gp / gl   Git 快捷操作                        │
│  reload               重载 .zshrc                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 设计哲学

1. **视觉统一** — Kitty、Yazi、Starship、bat 全部使用 Catppuccin Mocha 配色，深色背景 `#1e1e2e`，蓝/绿/粉为功能色
2. **肌肉记忆复用** — Vim 式 HJKL 导航贯穿 Kitty 分屏和 Yazi，不需要学两套键位
3. **渐进增强** — 所有别名都是对原命令的增强包装（`ls`→`eza`、`cat`→`bat`），管道场景自动降级
4. **开箱即用** — 不依赖外部主题文件，所有颜色手动指定，复制配置即可生效

---

## 完整文件清单

```Markdown
~/.config/
├── kitty/kitty.conf          # 终端模拟器配置
├── yazi/
│   ├── yazi.toml             # 文件管理器核心配置
│   ├── keymap.toml            # 快捷键配置
│   └── theme.toml             # 主题配置
├── starship.toml              # 提示符配置
└── bat/config                 # bat 主题配置

~/.zshrc                       # 末尾追加 Zsh 增强段
```

> 修改配置后：Kitty 用 `kitty @ load-config` 热重载；Zsh 用 `source ~/.zshrc`；Starship/Yazi 自动生效。