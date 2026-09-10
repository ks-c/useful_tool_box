# Useful Tool Box — 实用工具集

> 学术与办公辅助工具的集合仓库。每个工具独立成目录，按需取用。

| # | 工具 | 目录 | 类型 | 技术栈 | 运行方式 |
|---|------|------|------|--------|----------|
| 1 | [HTML 可视化编辑器](#1-html-可视化编辑器-html-visual-editor) | `html-visual-editor/` | 网页编辑器 | 原生 HTML/CSS/JS（零依赖） | 双击 `index.html` 或 `node serve.js`（免后端） |
| 2 | [Excel 智能去重工具](#2-excel-智能去重工具-excel-dedupe) | `excel-dedupe/` | 桌面小程序 | Python + tkinter + pandas | `python dedupe.py` |
| 3 | [SPSS 变量标签提取器](#3-spss-变量标签提取器-sav_reader) | `sav_reader/` | 在线网页工具 | 原生 HTML/JS（浏览器内解析） | [GitHub Pages 在线使用](https://ks-c.github.io/useful_tool_box/sav_reader/) |
| 4 | [歌曲批量下载器](#4-歌曲批量下载器-song_download) | `song_download/` | 桌面小程序 | Python + tkinter + spotdl | `python song_downloader_gui.py` |

---

## 1. HTML 可视化编辑器 — `html-visual-editor/`

加载本地 HTML 页面，在浏览器中直接可视化地修改**文字、颜色、字体、背景、边框、位置**；除编辑点外，页面的**结构、布局、CSS、图片、动画全部保持原样**。

**核心特性**

- **文字**：点击页面文字即可像 Word 一样直接输入修改（自动全选、输入即替换），粘贴自动转纯文本；结构保护——检测到元素插入自动回滚，杜绝结构破坏
- **样式选项卡**（顶栏功能区，选中元素后激活）：
  - 字体：文字色、字号、字重（1–1000 自定义数值）、行高、字距、字体（内置 40+ 常见中文字体，支持自定义）、斜体
  - 背景：背景色、透明度、阴影
  - 边框：边框色、宽度、样式（实线/虚线/点线/双线）、圆角
- **位置**：X/Y 坐标精确输入，或开启「拖拽」模式按住元素直接拖动（按住 Shift 锁定横向/竖向；绝对定位模式下自动原位转换、可撤销）
- **格式刷**：吸取选中元素的样式，点击目标元素一键应用
- **结构导航**：父级 / 子级逐层浏览并选中元素
- **编辑模式静默**：编辑过程中超链接不跳转、按钮不运行，交互元素只选中不误触
- **撤销/重做**：全部修改（含重置、绝对定位转换）均可撤销
- **导出**：下载修改后的完整 HTML（相对资源引用自动还原）、保存回原文件、导出 JSON 修改记录

**快速开始**

```bash
# 方式一：免后端，直接双击 html-visual-editor/index.html（Chrome/Edge）
# 方式二：可选静态服务器
node html-visual-editor/serve.js        # http://127.0.0.1:8123
```

详细说明见 [html-visual-editor/README.md](html-visual-editor/README.md)。

---

## 2. Excel 智能去重工具 — `excel-dedupe/`

一款专为办公人群设计的 Excel 重复数据清理桌面小程序（v2.1），告别手动筛选与复杂公式。

**核心功能**

- 直观的图形界面（tkinter），无需编程知识即可上手
- 两种去重模式：
  - **合并列模式**：多列同时满足才判定为重复（如"省份 + 城市"）
  - **不合并（单列）模式**：按单列唯一标识去重（如身份证号、订单编号）
- 智能列名读取：选择文件后自动列出全部列标题，下拉选择避免手误
- 详细的重复项报告：删除前清晰列出所有重复数据，便于核对录入错误
- 绝对安全：原文件不被修改，结果输出为「原文件名_去重后.xlsx」新文件
- 跨平台：Windows / macOS / Linux，仅需 Python 环境

**运行方式**

```bash
pip install pandas
python excel-dedupe/dedupe.py
```

详细说明见 [excel-dedupe/readme.md](excel-dedupe/readme.md)。

---

## 3. SPSS 变量标签提取器 — `sav_reader/`

基于原生解析的 SPSS（.sav）**变量与赋值信息提取**网页工具，无需安装 SPSS 或任何专业软件，浏览器内即可完成解析。

**核心功能**

- 浏览器内原生解析 .sav 文件（无需上传服务器，本地完成）
- 提取并展示变量信息与赋值标签，快速定位赋值编码含义
- 适合学术调研数据的快速查阅与核对

**使用方式**

- 在线体验：[https://ks-c.github.io/useful_tool_box/sav_reader/](https://ks-c.github.io/useful_tool_box/sav_reader/)
- 或本地直接打开 `sav_reader/index.html`

---

## 4. 歌曲批量下载器 — `song_download/`

基于命令行音乐下载工具 [spotdl](https://github.com/spotDL/spotify-downloader) 的图形化（GUI）批量歌曲下载器，为不熟悉命令行的用户提供简单直观的操作界面。

**核心功能**

- 图形化界面（tkinter），无需记忆命令
- 批量下载：粘贴歌单（格式：`歌名 + 歌手`，每行一首），全自动处理
- 自定义保存路径
- 实时日志：下载进度、成功/失败状态一目了然
- 独立线程下载，界面不卡死；任务结束列出失败歌曲及原因

**环境要求与运行**

```bash
pip install spotdl          # 核心依赖（需先按官方文档安装 FFmpeg）
python song_download/song_downloader_gui.py
```

详细说明见 [song_download/readme.md](song_download/readme.md)。

---

## 仓库结构

```
useful_tool_box/
├── index.html              # 门户首页（工具列表）
├── README.md               # 本总览文档
├── html-visual-editor/     # 工具1：HTML 可视化编辑器
├── excel-dedupe/           # 工具2：Excel 智能去重
├── sav_reader/             # 工具3：SPSS 变量标签提取器（GitHub Pages）
├── song_download/          # 工具4：歌曲批量下载器
└── payment.jpg             # 赞赏码
```

## 贡献与说明

- 每个工具目录内均有独立的使用文档，按需查阅
- 欢迎提交 Issue 或 Pull Request 完善工具
- 各工具均采用 **MIT 许可证**，可自由使用、分享与修改
