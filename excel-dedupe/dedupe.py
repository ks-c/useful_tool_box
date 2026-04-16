# -*- coding: utf-8 -*-
"""
Created on Sat Jun 28 18:41:57 2025

@author: lenovo
"""
import tkinter as tk
from tkinter import ttk, filedialog, scrolledtext
import pandas as pd
import threading
import os

class DeduplicatorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Excel 智能去重工具 v2.1")
        self.root.geometry("1200x600") # 再次增加高度以容纳新布局

        # --- 数据变量 ---
        self.input_file_path = tk.StringVar()
        self.mode_var = tk.IntVar(value=1)

        # --- 创建界面组件 ---
        self.create_widgets()

    def create_widgets(self):
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- 1. 文件选择区 ---
        file_frame = ttk.LabelFrame(main_frame, text="第一步：选择文件", padding="10")
        file_frame.pack(fill=tk.X, padx=5, pady=5)
        ttk.Label(file_frame, text="Excel 文件:").pack(side=tk.LEFT, padx=(0, 5))
        ttk.Entry(file_frame, textvariable=self.input_file_path, state="readonly").pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(file_frame, text="选择...", command=self.select_file).pack(side=tk.LEFT, padx=(5, 0))

        # --- 2. 模式选择区 ---
        mode_frame = ttk.LabelFrame(main_frame, text="第二步：选择去重模式", padding="10")
        mode_frame.pack(fill=tk.X, padx=5, pady=5)
        ttk.Radiobutton(mode_frame, text="合并列去重", variable=self.mode_var, value=1, command=self.toggle_mode).pack(anchor=tk.W)
        ttk.Radiobutton(mode_frame, text="不合并（按单列）", variable=self.mode_var, value=2, command=self.toggle_mode).pack(anchor=tk.W)

        # --- 3. 模式配置区 ---
        self.config_frame = ttk.Frame(main_frame)
        self.config_frame.pack(fill=tk.X, padx=5, pady=5)

        # 模式一：合并列配置
        self.merge_frame = ttk.LabelFrame(self.config_frame, text="第三步：配置合并模式", padding="10")
        labels_merge = ["合并列1:", "合并列2:", "报告列1 (院校):", "报告列2 (专业):"]
        for i, label_text in enumerate(labels_merge):
            ttk.Label(self.merge_frame, text=label_text).grid(row=i, column=0, sticky=tk.W, pady=3, padx=5)
        self.merge_col1_combo = ttk.Combobox(self.merge_frame, state="disabled")
        self.merge_col2_combo = ttk.Combobox(self.merge_frame, state="disabled")
        self.merge_report1_combo = ttk.Combobox(self.merge_frame, state="disabled")
        self.merge_report2_combo = ttk.Combobox(self.merge_frame, state="disabled")
        self.merge_col1_combo.grid(row=0, column=1, sticky=tk.EW, pady=3, padx=5)
        self.merge_col2_combo.grid(row=1, column=1, sticky=tk.EW, pady=3, padx=5)
        self.merge_report1_combo.grid(row=2, column=1, sticky=tk.EW, pady=3, padx=5)
        self.merge_report2_combo.grid(row=3, column=1, sticky=tk.EW, pady=3, padx=5)
        self.merge_frame.columnconfigure(1, weight=1)

        # 模式二：不合并配置
        self.non_merge_frame = ttk.LabelFrame(self.config_frame, text="第三步：配置不合并模式", padding="10")
        labels_non_merge = ["去重依据列:", "报告列1:", "报告列2:"]
        for i, label_text in enumerate(labels_non_merge):
            ttk.Label(self.non_merge_frame, text=label_text).grid(row=i, column=0, sticky=tk.W, pady=3, padx=5)
        self.non_merge_key_combo = ttk.Combobox(self.non_merge_frame, state="disabled")
        self.non_merge_report1_combo = ttk.Combobox(self.non_merge_frame, state="disabled")
        self.non_merge_report2_combo = ttk.Combobox(self.non_merge_frame, state="disabled")
        self.non_merge_key_combo.grid(row=0, column=1, sticky=tk.EW, pady=3, padx=5)
        self.non_merge_report1_combo.grid(row=1, column=1, sticky=tk.EW, pady=3, padx=5)
        self.non_merge_report2_combo.grid(row=2, column=1, sticky=tk.EW, pady=3, padx=5)
        self.non_merge_frame.columnconfigure(1, weight=1)
        
        # --- 4. 执行区 ---
        self.run_button = ttk.Button(main_frame, text="开始处理", command=self.start_processing, state="disabled")
        self.run_button.pack(fill=tk.X, padx=5, pady=10)

        # --- 5. 日志输出区 ---
        log_frame = ttk.LabelFrame(main_frame, text="信息输出", padding="10")
        log_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.log_text = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD, height=10, state='disabled')
        self.log_text.pack(fill=tk.BOTH, expand=True)

        self.toggle_mode()

    def toggle_mode(self):
        if self.mode_var.get() == 1:
            self.merge_frame.pack(fill=tk.X, expand=True)
            self.non_merge_frame.pack_forget()
        else:
            self.merge_frame.pack_forget()
            self.non_merge_frame.pack(fill=tk.X, expand=True)

    def log(self, message):
        self.root.after(0, self._log_threadsafe, message)

    def _log_threadsafe(self, message):
        self.log_text.configure(state='normal')
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)
        self.log_text.configure(state='disabled')

    def select_file(self):
        path = filedialog.askopenfilename(title="请选择一个Excel文件", filetypes=(("Excel Files", "*.xlsx *.xls"), ("All files", "*.*")))
        if not path: return
        self.input_file_path.set(path)
        self.log(f"已选择文件: {path}")
        self.log("正在读取列名...")
        try:
            df_header = pd.read_excel(path, nrows=0)
            column_list = list(df_header.columns)
            self.update_column_selectors(column_list)
            self.log("列名读取成功！请在上方配置列名。")
            self.run_button.config(state="normal")
        except Exception as e:
            self.log(f"错误：无法读取文件列名: {e}")
            self.update_column_selectors([])
            self.run_button.config(state="disabled")

    def update_column_selectors(self, columns):
        all_combos = [self.merge_col1_combo, self.merge_col2_combo, self.merge_report1_combo, self.merge_report2_combo,
                      self.non_merge_key_combo, self.non_merge_report1_combo, self.non_merge_report2_combo]
        
        if not columns:
            for combo in all_combos: combo.config(values=[], state="disabled"); combo.set('')
            return

        for combo in all_combos: combo.config(values=columns, state="readonly")

        def set_default(combo, preferred_value, default_index):
            if preferred_value and preferred_value in columns: combo.set(preferred_value)
            elif len(columns) > default_index: combo.current(default_index)
            elif columns: combo.current(0)
        
        # 智能默认选择 - 合并模式
        set_default(self.merge_col1_combo, "院校", 0)
        set_default(self.merge_col2_combo, "专业", 1)
        set_default(self.merge_report1_combo, "院校名称", 0)
        set_default(self.merge_report2_combo, "专业名称", 4)
        
        # 智能默认选择 - 不合并模式
        set_default(self.non_merge_key_combo, "专业代码", 3)
        set_default(self.non_merge_report1_combo, None, 0) # 默认为第一列
        set_default(self.non_merge_report2_combo, None, 1) # 默认为第二列

    def start_processing(self):
        if not self.input_file_path.get(): self.log("错误：文件路径无效！"); return
        self.run_button.config(state="disabled")
        self._log_threadsafe("\n") # 清空前加换行
        self.log("...开始处理任务...")
        threading.Thread(target=self.process_file_thread, daemon=True).start()
        
    def process_file_thread(self):
        try:
            input_path = self.input_file_path.get()
            mode = self.mode_var.get()
            
            if mode == 1:
                col1, col2 = self.merge_col1_combo.get(), self.merge_col2_combo.get()
                report1, report2 = self.merge_report1_combo.get(), self.merge_report2_combo.get()
                if not all([col1, col2, report1, report2]): raise ValueError("合并模式下的所有列都必须选择！")
                self.log(f"模式：合并列去重 ('{col1}' + '{col2}')")
                dedupe_key_text, dedupe_logic_cols = f"基于'{col1}'+'{col2}'的组合", [col1, col2]
                report_display_cols = [col1, col2, report1, report2]
            else:
                key_col = self.non_merge_key_combo.get()
                report1, report2 = self.non_merge_report1_combo.get(), self.non_merge_report2_combo.get()
                if not all([key_col, report1, report2]): raise ValueError("不合并模式下的所有列都必须选择！")
                self.log(f"模式：不合并去重 (依据列: '{key_col}')")
                dedupe_key_text, dedupe_logic_cols = f"依据列'{key_col}'", [key_col]
                report_display_cols = [key_col, report1, report2]

            path_parts = os.path.splitext(input_path)
            output_path = f"{path_parts[0]}_去重后{path_parts[1]}"

            self.log("正在读取完整Excel文件...")
            df = pd.read_excel(input_path)
            self.log(f"文件读取完毕，共 {len(df)} 行数据。")

            temp_check_col = '_组合查重列'
            if mode == 1:
                df[temp_check_col] = df[dedupe_logic_cols[0]].astype(str) + '-' + df[dedupe_logic_cols[1]].astype(str)
                dedupe_key_for_pd = temp_check_col
            else:
                dedupe_key_for_pd = dedupe_logic_cols[0]

            duplicates = df[df.duplicated(subset=[dedupe_key_for_pd], keep=False)]
            if not duplicates.empty:
                self.log(f"\n--- 发现{len(duplicates)}条重复记录 ({dedupe_key_text}) ---")
                # 确保报告列唯一，避免重复显示
                report_display_cols_unique = list(dict.fromkeys(report_display_cols))
                report_str = duplicates.sort_values(by=[dedupe_key_for_pd])[report_display_cols_unique].to_string(index=False)
                self.log("以下是完整的重复记录详情：\n" + report_str)
            else:
                self.log("\n--- 未发现任何重复项 ---")

            df_deduplicated = df.drop_duplicates(subset=[dedupe_key_for_pd], keep='first')
            if temp_check_col in df_deduplicated.columns:
                df_deduplicated = df_deduplicated.drop(columns=[temp_check_col])

            df_deduplicated.to_excel(output_path, index=False, engine='openpyxl')
            self.log(f"\n处理完成！已删除 {len(df) - len(df_deduplicated)} 行重复数据。")
            self.log(f"结果已保存至新文件: {output_path}")

        except Exception as e:
            self.log(f"\n！！！发生错误！！！\n{e}")
        finally:
            self.root.after(0, self.run_button.config, {"state": "normal"})

if __name__ == "__main__":
    root = tk.Tk()
    app = DeduplicatorApp(root)
    root.mainloop()
