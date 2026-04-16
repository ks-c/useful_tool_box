# -*- coding: utf-8 -*-
"""
Created on Wed Sep 24 20:23:17 2025

@author: lenovo
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import subprocess
import threading
import queue

class SongDownloaderApp:
    def __init__(self, root):
        self.root = root
        self.root.title("歌曲批量下载器 (基于 spotdl)")
        self.root.geometry("800x600")

        self.download_path = ""
        self.status_queue = queue.Queue()

        # --- UI 布局 ---
        main_frame = ttk.Frame(root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 1. 输入区域
        input_frame = ttk.LabelFrame(main_frame, text="输入歌单 (格式: 歌名 + 歌手，每行一首)", padding="10")
        input_frame.pack(fill=tk.X, pady=5)
        
        self.song_input = scrolledtext.ScrolledText(input_frame, height=10, wrap=tk.WORD, font=("微软雅黑", 10))
        self.song_input.pack(fill=tk.X, expand=True)
        self.song_input.insert(tk.END, "爱，很简单 + 陶喆\nLover + Taylor Swift\n我们的歌 + 王力宏")

        # 2. 设置与操作区域
        settings_frame = ttk.Frame(main_frame, padding="5")
        settings_frame.pack(fill=tk.X)

        self.folder_button = ttk.Button(settings_frame, text="选择下载文件夹", command=self.select_folder)
        self.folder_button.pack(side=tk.LEFT, padx=5)

        self.path_label = ttk.Label(settings_frame, text="请先选择一个文件夹...", width=60, relief="sunken")
        self.path_label.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)

        self.download_button = ttk.Button(settings_frame, text="开始下载", command=self.start_download_thread)
        self.download_button.pack(side=tk.LEFT, padx=5)

        # 3. 状态与日志区域
        status_frame = ttk.LabelFrame(main_frame, text="下载日志", padding="10")
        status_frame.pack(fill=tk.BOTH, expand=True, pady=5)

        self.status_area = scrolledtext.ScrolledText(status_frame, state='disabled', wrap=tk.WORD, font=("微软雅黑", 9))
        self.status_area.pack(fill=tk.BOTH, expand=True)

    def select_folder(self):
        """弹出对话框让用户选择文件夹"""
        path = filedialog.askdirectory()
        if path:
            self.download_path = path
            self.path_label.config(text=f"将下载到: {self.download_path}")

    def update_status(self, message):
        """向状态区域添加日志信息"""
        self.status_area.config(state='normal')
        self.status_area.insert(tk.END, message + "\n")
        self.status_area.config(state='disabled')
        self.status_area.see(tk.END) # 自动滚动到底部

    def parse_input_to_songs(self):
        """解析文本框中的输入，转换成歌曲列表格式"""
        raw_text = self.song_input.get("1.0", tk.END)
        lines = [line.strip() for line in raw_text.split('\n') if line.strip()]
        song_list = []
        for i, line in enumerate(lines):
            if '+' in line:
                parts = [p.strip() for p in line.split('+', 1)]
                if len(parts) == 2 and parts[0] and parts[1]:
                    song_list.append({"序号": str(i + 1), "歌名": parts[0], "歌手": parts[1]})
        return song_list

    def start_download_thread(self):
        """点击“开始下载”按钮后触发，启动一个新线程来处理下载任务"""
        if not self.download_path:
            messagebox.showerror("错误", "请先选择一个下载文件夹！")
            return

        songs_to_download = self.parse_input_to_songs()
        if not songs_to_download:
            messagebox.showwarning("提示", "未检测到有效歌曲输入，请检查格式是否为 '歌名 + 歌手'。")
            return
        
        # 禁用按钮防止重复点击
        self.download_button.config(state='disabled')
        self.folder_button.config(state='disabled')

        # 清空日志
        self.status_area.config(state='normal')
        self.status_area.delete('1.0', tk.END)
        self.status_area.config(state='disabled')
        
        # 创建并启动下载线程
        thread = threading.Thread(target=self.download_logic, args=(songs_to_download, self.download_path), daemon=True)
        thread.start()
        
        # 开始轮询队列以更新UI
        self.root.after(100, self.process_queue)

    def process_queue(self):
        """定时检查队列中是否有新消息，并更新UI"""
        try:
            message = self.status_queue.get_nowait()
            self.update_status(message)
            # 如果收到任务结束的信号，就停止轮询
            if "--- 所有下载任务已处理完毕 ---" in message:
                self.download_button.config(state='normal')
                self.folder_button.config(state='normal')
            else:
                self.root.after(100, self.process_queue)
        except queue.Empty:
            self.root.after(100, self.process_queue)

    def download_logic(self, song_list, download_dir):
        """
        实际的下载逻辑，运行在独立的线程中，以防UI卡死
        """
        self.status_queue.put(f"--- 准备下载 {len(song_list)} 首歌曲到 '{download_dir}' ---")
        failed_downloads = []

        for song_info in song_list:
            song_name = song_info.get("歌名")
            artist = song_info.get("歌手")
            song_index = song_info.get("序号", "00").zfill(2)

            query = f"{song_name} by {artist}"
            # 注意：spotdl 3.x 使用 {title}-{artist} 作为默认文件名，我们使用 --output 来自定义
            # 文件名中的非法字符会被 spotdl 自动处理
            output_format = f"{song_index}_{song_name}.mp3"
            
            command = ["spotdl", "download", query, "--output", output_format]
            
            self.status_queue.put(f"\n[正在下载] 序号 {song_index}: {song_name} - {artist}")

            try:
                # 使用 cwd 参数指定命令的执行目录，这样文件就会被下载到那里
                result = subprocess.run(command, check=True, capture_output=True, text=True, encoding='utf-8', cwd=download_dir)
                self.status_queue.put(f"[下载成功] 文件已保存为 '{output_format}'。")
            except FileNotFoundError:
                self.status_queue.put("\n错误：找不到 'spotdl' 命令。请确保已正确安装 spotdl。")
                failed_downloads.append({**song_info, "失败原因": "spotdl 未安装或路径错误"})
                break # 中断下载
            except subprocess.CalledProcessError as e:
                error_message = f"spotdl 执行失败: {e.stderr.strip()}"
                self.status_queue.put(f"[下载失败] {error_message}")
                failed_downloads.append({**song_info, "失败原因": "歌曲可能无法找到或下载出错"})
            except Exception as e:
                error_message = f"发生未知错误: {e}"
                self.status_queue.put(f"[下载失败] {error_message}")
                failed_downloads.append({**song_info, "失败原因": error_message})
        
        # --- 下载结束，生成总结报告 ---
        self.status_queue.put("\n\n--- 所有下载任务已处理完毕 ---")
        if failed_downloads:
            self.status_queue.put("\n以下歌曲下载失败，请检查：")
            for item in failed_downloads:
                self.status_queue.put(f"  - 序号: {item['序号']}, 歌名: {item['歌名']}, 歌手: {item['歌手']}, 原因: {item['失败原因']}")
        else:
            self.status_queue.put("\n恭喜！所有可处理的歌曲均已成功下载。")


if __name__ == "__main__":
    root = tk.Tk()
    app = SongDownloaderApp(root)
    root.mainloop()
