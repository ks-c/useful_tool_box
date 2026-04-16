# 歌曲批量下载器 (song-Downloader-GUI)

[![Python](https://img.shields.io/badge/Python-3.7%2B-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于强大的命令行音乐下载工具 [spotdl](https://github.com/spotDL/spotify-downloader) 开发的图形化（GUI）批量歌曲下载器。本项目旨在为不熟悉命令行的用户提供一个简单直观的操作界面，只需复制粘贴歌单即可完成批量下载。

## ✨ 主要特性

- **图形化界面**: 简洁直观，无需记忆任何命令。
- **批量下载**: 支持一次性输入多首歌曲（格式：`歌名 + 歌手`），实现全自动下载。
- **自定义保存路径**: 自由选择你希望保存下载歌曲的文件夹。
- **实时日志**: 在界面中实时显示下载进度、成功或失败状态。
- **防止界面卡死**: 下载过程在独立线程中运行，保证了用户界面的流畅响应。
- **错误报告**: 下载任务结束后，会清晰地列出所有下载失败的歌曲及可能原因。

## 📸 界面截图

*(请将此处的 `screenshot.png` 替换为您自己的应用截图)*
<img width="1002" height="790" alt="image" src="https://github.com/user-attachments/assets/8fcf6953-ec80-4dba-90c8-0be1ba411449" />


## 🔧 环境要求

在运行此程序前，请确保你的电脑已经安装了以下环境：

1.  **Python 3**: 建议使用 Python 3.7 或更高版本。
2.  **spotdl**: 本程序的核心依赖。
    -   `spotdl` 依赖 **FFmpeg** 来处理音频数据。请先根据 [spotdl官方文档的指引](https://github.com/spotDL/spotify-downloader) 安装 FFmpeg。
    -   然后通过 pip 安装 `spotdl`：
        ```bash
        pip install spotdl
        ```

## 🚀 安装与使用

1.  **克隆或下载仓库**
    ```bash
    git clone [https://github.com/your-username/spot-downloader-gui.git](https://github.com/your-username/spot-downloader-gui.git)
    cd spot-downloader-gui
    ```
    *(请将 `your-username/spot-downloader-gui.git` 替换为您自己的仓库地址)*

    更建议直接复制到vscode中直接运行

3.  **安装依赖**
    如上所述，确保 `spotdl` 已经安装。本程序仅使用 Python 内置库，无需额外安装其他 Python 包。
    ```bash
    pip install spotdl
    ```

4.  **运行程序**
    将项目中的代码保存为 `main.py` (或其他 `.py` 文件)，然后运行：
    ```bash
    python main.py
    ```

5.  **使用步骤**
    a. 程序启动后，在顶部的输入框中粘贴你的歌单。请确保格式为 **`歌名 + 歌手`**，每行一首。
    b. 点击 **“选择下载文件夹”** 按钮，选择一个用于存放下载歌曲的目录。
    c. 点击 **“开始下载”** 按钮。
    d. 程序下方的“下载日志”区域会实时显示每一首歌曲的下载状态。
    e. 等待所有任务处理完毕。

## ⚙️ 技术实现

- **图形界面 (UI)**: 使用 Python 内置的 `tkinter` 库构建，轻量且跨平台。
- **核心下载逻辑**: 通过 Python 的 `subprocess` 模块调用已安装在系统环境中的 `spotdl` 命令行工具。
- **并发处理**: 利用 `threading` 模块将耗时的下载任务放入后台线程执行，避免了图形界面的冻结。
- **线程安全UI更新**: 使用 `queue` 模块在下载线程和主GUI线程之间安全地传递状态消息，以更新日志。

## 🤝 如何贡献

欢迎提交问题 (Issue) 或拉取请求 (Pull Request)！如果你有任何改进建议或发现了 Bug，请随时提出。

1.  Fork 本仓库
2.  创建你的分支 (`git checkout -b feature/AmazingFeature`)
3.  提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4.  推送到分支 (`git push origin feature/AmazingFeature`)
5.  打开一个 Pull Request

## 📄 许可证

该项目采用 MIT 许可证。详情请见 `LICENSE` 文件。
