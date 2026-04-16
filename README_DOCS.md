# 专题文档维护手册 (Documentation Maintenance Guide)

本文档旨在说明如何在当前博客系统中管理和新增“产品/项目专题文档”。

## 架构说明
本系统采用“双模”设计：
1. **博客模式**：用于展示日常博文数据。
2. **文档模式**：用于展示专业、深度的系列专题（如 Claude Code 源码分析）。文档模式会自动精简布局，移除头像，并启用 300px 宽的专业树状侧边栏。

---

## 新增专题“三步走”

### 1. 准备内容文件
在 `docs/` 目录下创建新专题的文件夹，并放入 `.md` 文件。
**关键配置：** 每个文档的头部（Front Matter）必须包含：
```yaml
---
title: "页面标题"
layout: documentation    # 必须使用此布局
project_id: my_new_id    # 需与第 3 步中的 id 一致
permalink: /docs/my-folder/page-url/ # 建议指定固定链接
---
```

### 2. 配置侧边栏导航
在 `_data/` 目录下创建新的 `yml` 文件（例如 `_data/my_new_sidebar.yml`），建议格式：
```yaml
- title: 章节一：简介
  url: /docs/my-folder/page-url/
- title: 章节二：进阶
  children:
    - title: 子章节 A
      url: /docs/my-folder/sub-a/
```

### 3. 注册专题入口
在 `_data/projects.yml` 中添加该专题的元数据。添加后，首页标签和右侧边栏会自动更新。
```yaml
- name: 专题显示名称
  id: my_new_id           # 必须与第 1 步中的 project_id 一致
  description: 专题简介
  icon: fa-code-branch    # FontAwesome 图标
  sidebar_data: my_new_sidebar # 对应第 2 步的文件名（不含扩展名）
  doc_url: /docs/my-folder/intro/ # 专题入口页面
```

---

## 常用图标参考 (FontAwesome)
- `fa-robot`: AI/机器人相关
- `fa-code-branch`: 源码分析/Git
- `fa-layer-group`: 架构/框架
- `fa-book`: 文档/手册
- `fa-rocket`: 快速启动/项目

## 布局微调
- **侧边栏宽度**：如需修改 300px 的侧边栏宽度，请在 `_layouts/documentation.html` 的 CSS 中修改 `--sidebar-width` 变量。
- **首页展现**：专题的展示逻辑位于 `_layouts/home.html`。
