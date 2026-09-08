#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 starred_vs_local.json + 本地未 star 清单导出为「全中文」多 Sheet Excel 文件"""
import json, os
from datetime import datetime
from collections import Counter, defaultdict
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

SRC_JSON = "/tmp/starred_vs_local.json"
SRC_ZH_JSON = "/tmp/starred_with_zh.json"   # 豆包 LLM 高质量翻译结果
LOCAL_TXT = "/tmp/local_repos.txt"
OUT_XLSX = "/Users/xingan/Documents/software/aiengine/GitHub_Star_对比报告_中文版.xlsx"

# ---- 分类中文映射（英文编码 → 纯中文分类名） ----
CAT_CN = {
    "AI-Agent-Framework":   "① AI Agent 框架与 Harness",
    "AI-Coding-Harness":    "② AI 编码助手与 Harness",
    "AI-Agent-Skill":       "③ Agent 技能库与合集",
    "AI-RAG-Knowledge":     "④ RAG、知识库与向量检索",
    "AI-LLM-Training":      "⑤ LLM 训练、微调与推理框架",
    "AI-LLM-App":           "⑥ LLM 应用、提示词与合集",
    "AI-Video":             "⑦ AI 视频、短剧与数字人",
    "AI-Voice-TTS":         "⑧ 语音合成、TTS 与音乐生成",
    "AI-Vision-Image":      "⑨ 图像生成、多模态与 AI 记忆",
    "AI-Agent-Browser":     "⑩ 浏览器 Agent 与 Web 自动化",
    "AI-Agent-Social":      "⑪ 社媒采集、舆情与 Agent 触达",
    "AI-Productivity":      "⑫ AI 生产力、助手与办公",
    "AI-Security-RedTeam":  "⑬ AI 安全、红队与基础设施防护",
    "AI-Data-Infra":        "⑭ 数据工程与工作流编排",
    "AI-Book-Tutorial":     "⑮ 教程书籍与 Awesome 合集",
    "Ops-Observability":    "⑯ 运维、可观测性与分析平台",
    "DevOps-Platform":      "⑰ DevOps 与 CI/CD 平台",
    "DevTools-Plugins":     "⑱ 开发工具、插件与 MCP",
    "Media-Tool-NonAI":     "⑲ 媒体工具与下载器（弱 AI）",
    "Misc":                 "⑳ 其他与未分类",
}
AI_CATS = {k for k in CAT_CN if k.startswith("AI-")}

# ---- 样式 ----
HEADER_FILL = PatternFill("solid", fgColor="1F4E78")   # 深蓝
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11, name="PingFang SC")
CAT_FILL    = PatternFill("solid", fgColor="DDEBF7")   # 浅蓝
CAT_FONT    = Font(bold=True, color="1F4E78", name="PingFang SC")
AI_FILL     = PatternFill("solid", fgColor="FFF2CC")   # 浅黄
BADGE_FILL  = PatternFill("solid", fgColor="FCE4D6")   # 浅橙
THIN = Side(border_style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT   = Alignment(horizontal="left",   vertical="center", wrap_text=True, indent=1)

def style_header(ws, row=1, ncols=None):
    ncols = ncols or ws.max_column
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = CENTER
        cell.border = BORDER

def auto_width(ws, max_w=70):
    for col in ws.columns:
        letter = get_column_letter(col[0].column)
        longest = 0
        for cell in col:
            v = "" if cell.value is None else str(cell.value)
            w = sum(2 if ord(ch) > 127 else 1 for ch in v)
            if w > longest:
                longest = w
        ws.column_dimensions[letter].width = min(max(longest + 3, 12), max_w)

def write_row(ws, values, row=None, bold=False):
    r = row or ws.max_row + 1
    for i, v in enumerate(values, start=1):
        cell = ws.cell(row=r, column=i, value=v)
        cell.border = BORDER
        cell.alignment = LEFT
        if bold:
            cell.font = Font(bold=True, name="PingFang SC")
        else:
            cell.font = Font(name="PingFang SC", size=10.5)
    return r

# ========== 载入数据 ==========
with open(SRC_JSON) as f:
    raw = json.load(f)
cloned   = raw["cloned_items"]
uncloned = sorted(raw["not_cloned_items"], key=lambda x: -x.get("stars", 0))

# ===== 用豆包 LLM 生成的中文一句话说明，覆盖原来的英文 description =====
with open(SRC_ZH_JSON) as f:
    zh_list = json.load(f)
zh_map = {}
for z in zh_list:
    zh_map[z["full_name"].lower().rstrip("/")] = z.get("_summary_zh") or ""
def apply_zh(items):
    for it in items:
        zh = zh_map.get(it["full_name"].lower().rstrip("/"))
        if zh:
            it["_summary"] = zh
    return items
cloned   = apply_zh(cloned)
uncloned = apply_zh(uncloned)

# 本地 clone 但没 star
starred_fulls = {x["full_name"].lower().rstrip("/") for x in cloned + uncloned}
starred_names = {x["full_name"].split("/")[-1].lower() for x in cloned + uncloned}
no_star = []
with open(LOCAL_TXT) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        p = line.split("|")
        if len(p) < 3:
            continue
        d, repo, remote = p[0], p[1].rstrip("/"), p[2]
        key = repo.lower() if repo else ""
        name_only = repo.split("/")[-1].lower() if repo else d.lower()
        if not key or key == "not-a-git-repo":
            if d == "docs":
                no_star.append(("docs", "", "（本地文档目录，非 GitHub 仓库）"))
            continue
        if key not in starred_fulls and name_only not in starred_names:
            no_star.append((d, repo, remote))

wb = Workbook()
now_str = datetime.now().strftime("%Y年%m月%d日 %H:%M")

# ====================================================================
# Sheet 1：总览
# ====================================================================
ws = wb.active
ws.title = "一、总览"
ws.merge_cells("A1:E1")
ws["A1"] = f"GitHub Star 项目 VS 本地 aiengine/ 克隆 对比报告   （生成于 {now_str}）"
ws["A1"].font = Font(bold=True, size=14, color="1F4E78", name="PingFang SC")
ws["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
ws.row_dimensions[1].height = 28

# —— 核心数字 ——
ws["A3"] = "📌 核心数据"
ws["A3"].font = Font(bold=True, size=12, color="1F4E78", name="PingFang SC")
ws.merge_cells("A3:E3")

kvs = [
    ("GitHub 账号",   "hation（ganxin）", False),
    ("Star 项目总数", len(cloned) + len(uncloned), True),
    ("  └ 已克隆到本地", len(cloned), True),
    ("  └ 未克隆到本地", len(uncloned), True),
    ("AI 相关项目（Star 列表）", sum(1 for x in cloned + uncloned if x["_is_ai"]), True),
    ("  └ 已克隆中 AI 相关占比",
     f"{sum(1 for x in cloned if x['_is_ai'])} / {len(cloned)}  ({round(sum(1 for x in cloned if x['_is_ai'])*100/len(cloned))}%)", False),
    ("本地 clone 了但未 Star 的项目数", len(no_star), True),
]
for i, (k, v, badge) in enumerate(kvs, start=4):
    c1 = ws.cell(row=i, column=1, value=k)
    c1.border = BORDER; c1.font = Font(name="PingFang SC", size=11)
    c1.alignment = LEFT
    c2 = ws.cell(row=i, column=2, value=v)
    c2.border = BORDER; c2.alignment = CENTER
    if badge:
        c2.fill = BADGE_FILL
        c2.font = Font(bold=True, name="PingFang SC", size=11, color="C00000")
    else:
        c2.font = Font(bold=True, name="PingFang SC", size=11)

# —— 分类分布表 ——
r = 13
ws.cell(row=r, column=1, value="📂 分类分布（AI 类优先，按分类聚合）")
ws.cell(row=r, column=1).font = Font(bold=True, size=12, color="1F4E78", name="PingFang SC")
ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
r += 1
hd_cat = ["分类名称", "是否 AI 相关", "已克隆数", "未克隆数", "总数", "克隆率"]
for i, h in enumerate(hd_cat, 1):
    ws.cell(row=r, column=i, value=h)
style_header(ws, row=r, ncols=len(hd_cat))
r += 1

cloned_cnt = Counter(x["_category"] for x in cloned)
uncloned_cnt = Counter(x["_category"] for x in uncloned)
cat_list = list(CAT_CN.keys())
sum_c1 = sum_c2 = 0
for cat in cat_list:
    cn = CAT_CN[cat]
    c1 = cloned_cnt.get(cat, 0)
    c2 = uncloned_cnt.get(cat, 0)
    tot = c1 + c2
    rate = f"{round(c1/tot*100)}%" if tot else "-"
    ai_flag = "是（AI）" if cat in AI_CATS else "否（工具/其他）"
    write_row(ws, [cn, ai_flag, c1, c2, tot, rate], row=r)
    if cat in AI_CATS:
        ws.cell(row=r, column=2).fill = AI_FILL
    sum_c1 += c1; sum_c2 += c2
    r += 1
# 合计
write_row(ws, ["合   计", "", sum_c1, sum_c2, sum_c1 + sum_c2,
               f"{round(sum_c1/(sum_c1+sum_c2)*100)}%" if sum_c1+sum_c2 else "-"], row=r, bold=True)
for c in range(1, 7):
    ws.cell(row=r, column=c).fill = CAT_FILL
r += 2
ws.cell(row=r, column=1, value="说明：克隆率 = 已克隆数 / 该分类 Star 总数。AI 大类（①-⑮）整体克隆率很高。")
ws.cell(row=r, column=1).font = Font(italic=True, color="595959", name="PingFang SC", size=10)
ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)

ws.column_dimensions["A"].width = 40
ws.column_dimensions["B"].width = 16
for col_letter in ["C", "D", "E", "F"]:
    ws.column_dimensions[col_letter].width = 14

# ====================================================================
# Sheet 2：已克隆清单
# ====================================================================
ws2 = wb.create_sheet(f"二、已克隆到本地（共 {len(cloned)} 个）")
hd2 = ["分类名称", "是否 AI", "Star 数", "项目地址（owner/repo）",
       "本地目录名", "项目主要语言", "一句话说明（解决什么问题）"]
for i, h in enumerate(hd2, 1):
    ws2.cell(row=1, column=i, value=h)
style_header(ws2, row=1, ncols=len(hd2))
ws2.freeze_panes = "A2"
ws2.row_dimensions[1].height = 28

by_cat_cloned = defaultdict(list)
for x in cloned:
    by_cat_cloned[x["_category"]].append(x)

row = 2
for cat in [c for c in cat_list if c in by_cat_cloned]:
    cn = CAT_CN[cat]
    ai_flag = "是" if cat in AI_CATS else "否"
    grp_start = row
    for x in sorted(by_cat_cloned[cat], key=lambda i: -i.get("stars", 0)):
        write_row(ws2, [
            cn, ai_flag, x.get("stars", 0), x["full_name"],
            x.get("_local_dir") or "",
            x.get("language") or "（未标注）",
            x.get("_summary") or "（项目无描述）",
        ], row=row)
        if ai_flag == "是":
            ws2.cell(row=row, column=2).fill = AI_FILL
        ws2.cell(row=row, column=3).number_format = "#,##0"
        row += 1
    # 分类分组着色
    for rr in range(grp_start, row):
        ws2.cell(row=rr, column=1).fill = CAT_FILL
        ws2.cell(row=rr, column=1).font = CAT_FONT

widths2 = [40, 10, 12, 50, 30, 16, 90]
for i, w in enumerate(widths2, 1):
    ws2.column_dimensions[get_column_letter(i)].width = w

# ====================================================================
# Sheet 3：未克隆清单（按 star 降序）
# ====================================================================
ws3 = wb.create_sheet(f"三、未克隆（共 {len(uncloned)} 个）")
hd3 = ["分类名称", "是否 AI", "Star 数", "项目地址（owner/repo）",
       "项目主要语言", "一句话说明（解决什么问题）", "GitHub Topics 标签"]
for i, h in enumerate(hd3, 1):
    ws3.cell(row=1, column=i, value=h)
style_header(ws3, row=1, ncols=len(hd3))
ws3.freeze_panes = "A2"
ws3.row_dimensions[1].height = 28

by_cat_nc = defaultdict(list)
for x in uncloned:
    by_cat_nc[x["_category"]].append(x)

row = 2
for cat in [c for c in cat_list if c in by_cat_nc]:
    cn = CAT_CN[cat]
    ai_flag = "是" if cat in AI_CATS else "否"
    grp_start = row
    for x in sorted(by_cat_nc[cat], key=lambda i: -i.get("stars", 0)):
        topics = "、".join(x.get("topics") or [])
        write_row(ws3, [
            cn, ai_flag, x.get("stars", 0), x["full_name"],
            x.get("language") or "（未标注）",
            x.get("_summary") or "（项目无描述）",
            topics or "—",
        ], row=row)
        if ai_flag == "是":
            ws3.cell(row=row, column=2).fill = AI_FILL
        ws3.cell(row=row, column=3).number_format = "#,##0"
        row += 1
    for rr in range(grp_start, row):
        ws3.cell(row=rr, column=1).fill = CAT_FILL
        ws3.cell(row=rr, column=1).font = CAT_FONT

widths3 = [40, 10, 12, 50, 16, 90, 56]
for i, w in enumerate(widths3, 1):
    ws3.column_dimensions[get_column_letter(i)].width = w

# ====================================================================
# Sheet 4：本地 Clone 未 Star
# ====================================================================
ws4 = wb.create_sheet(f"四、本地已 Clone 但未 Star（共 {len(no_star)} 个）")
hd4 = ["本地目录名", "对应 GitHub 项目", "Git Remote / 备注"]
for i, h in enumerate(hd4, 1):
    ws4.cell(row=1, column=i, value=h)
style_header(ws4, row=1, ncols=len(hd4))
ws4.freeze_panes = "A2"
ws4.row_dimensions[1].height = 26

for r, (d, repo, remote) in enumerate(no_star, start=2):
    write_row(ws4, [d, repo or "（非 GitHub 项目）", remote], row=r)
    if not repo:
        for c in range(1, 4):
            ws4.cell(row=r, column=c).fill = BADGE_FILL

widths4 = [32, 48, 72]
for i, w in enumerate(widths4, 1):
    ws4.column_dimensions[get_column_letter(i)].width = w

# ====================================================================
# 保存
# ====================================================================
wb.save(OUT_XLSX)
size = os.path.getsize(OUT_XLSX) / 1024
print(f"✅ 中文版 Excel 已生成：")
print(f"   路径：{OUT_XLSX}")
print(f"   大小：{size:,.1f} KB")
print(f"   Sheet：{[s.title for s in wb.worksheets]}")
print(f"   已克隆 {ws2.max_row - 1} 行 / 未克隆 {ws3.max_row - 1} 行 / 本地未 Star {ws4.max_row - 1} 行")
