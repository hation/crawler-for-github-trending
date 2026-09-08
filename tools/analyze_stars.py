#!/usr/bin/env python3
"""对比 GitHub star 项目与本地 aiengine 目录，做 AI 相关性与分类标注"""
import json, re, sys, os
from collections import Counter, defaultdict

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
STARRED = []
with open(os.path.join(DATA_DIR, "starred_all.json")) as f:
    for line in f:
        line = line.strip()
        if line:
            STARRED.append(json.loads(line))

# ===== 2. 读取本地克隆列表 =====
LOCAL = {}  # repo_full -> {local_dir, remote}
local_repo_names_lower = set()
local_dir_by_lower_name = {}
with open(os.path.join(DATA_DIR, "local_repos.txt")) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 3:
            continue
        local_dir, repo_full, remote = parts[0], parts[1], parts[2]
        repo_full = repo_full.rstrip("/")
        if repo_full:
            LOCAL[repo_full.lower()] = {"dir": local_dir, "remote": remote}
        name_only = repo_full.split("/")[-1].lower() if repo_full else local_dir.lower()
        local_repo_names_lower.add(name_only)
        local_dir_by_lower_name[name_only] = local_dir

# ===== 3. 分类规则 =====
CATEGORY_RULES = [
    ("AI-Agent-Framework", ["agent framework", "multi-agent", "agentic framework",
                             "agent team", "agent swarm", "harness", "swarm",
                             "swe-agent", "openhands", "praisonai", "qwen-agent", "agentscope",
                             "beeai", "deepagents", "hermes-agent", "prime-agent", "semantica",
                             "agents"], "AI Agent 框架/Harness"),
    ("AI-Coding-Harness", ["claude code", "claude-code", "codex", "opencode", "aider",
                           "coding agent", "coding harness", "ai coding platform",
                           "code agent", "archon", "jcode", "t3code", "munder-difflin",
                           "superplane"], "AI 编码 Agent / Harness"),
    ("AI-Agent-Skill", ["agent skill", "claude skill", "codex skill", "cursor skill",
                        "opencode skill", "narrator-ai-cli-skill", "ip-as-logo",
                        "karpathy skills", "cybersecurity skills", "socialdatax",
                        "skill"], "Agent Skills / 技能库"),
    ("AI-RAG-Knowledge", ["rag", "knowledge", "retrieval", "vector", "embedding",
                          "weknora", "ragflow", "hypergraphrag", "db-gpt",
                          "autoschemakg", "mempalace", "paperclip", "turbovec"],
     "RAG / 知识库 / 向量检索"),
    ("AI-LLM-Training", ["llm", "fine-tun", "finetun", "training", "lora",
                         "llamafactory", "modular ml"],
     "LLM 训练 / 微调 / 推理框架"),
    ("AI-LLM-App", ["llm app", "ai app", "prompt", "gpt", "nano banana",
                    "awesome-ai-apps", "hallmark", "higgsfield", "translation-agent"],
     "LLM 应用合集 / 提示词"),
    ("AI-Video", ["video", "vid", "pixelle", "dramaclaw", "moneyprinter",
                  "shortgpt", "joyai", "localminidrama", "video-autopilot",
                  "minimax h3", "clawteam", "video-shotcraft", "toonflow",
                  "arcreel", "openmontage", "openrsi", "vimax", "opencut",
                  "open-cut"], "AI 视频 / 短剧 / 数字人"),
    ("AI-Voice-TTS", ["tts", "voice", "语音克隆", "elevenlabs", "voicestudio",
                       "fireredtts", "minimax-music", "music3", "livetalking",
                       "talking", "数字人"], "语音合成 / TTS / 音乐 / 数字人"),
    ("AI-Vision-Image", ["comfyui", "stable diffusion", "diffusion model",
                         "comfyui_minimax", "awesome-gpt-image",
                         "memory", "odysseus", "inkos", "waoowaoo", "gbrain"],
     "图像生成 / 多模态 / 视觉 / AI 记忆"),
    ("AI-Agent-Browser", ["browser", "midscene", "browserskill", "geolook"],
     "浏览器 Agent / Web 自动化"),
    ("AI-Agent-Social", ["social media", "社媒", "xiaohongshu", "xhs", "小红书",
                         "douyin", "抖音", "twitter", "redd", "spider_xhs",
                         "agent-reach", "social-media-copilot", "stonedt", "舆情"],
     "社媒采集 / 舆情 / Agent 触达"),
    ("AI-Productivity", ["ppt", "assistant", "octop", "ai assistant",
                         "ppt-master", "screenshot", "diagram", "open-seo",
                         "career-ops", "deeptutor", "ai-researcher", "auto-schema",
                         "jarvishub", "everos", "everme", "evermind", "cumora",
                         "nexent", "openocta", "mempalace"],
     "AI 生产力 / 助手 / 办公"),
    ("AI-Security-RedTeam", ["security", "cyber", "red team", "ai-infra-guard",
                              "krillinai"], "AI 安全 / 红队 / 基础设施防护"),
    ("AI-Data-Infra", ["airflow", "workflow", "langflow", "miroflow",
                        "deer-flow", "deerflow"], "数据工程 / 工作流编排"),
    ("AI-Book-Tutorial", ["book", "教程", "tutorial", "awesome", "learning",
                           "from scratch", "engineering", "橙皮书", "ai-agent-book",
                           "deepagents-book", "llamaindex-book", "miroflow-book",
                           "ragflow-book", "hermes-agent-book", "deerflow-book",
                           "openclaw-book", "andrej-karpathy", "diagram-design"],
     "Awesome 合集 / 教程书籍 / 文档"),
    ("Ops-Observability", ["posthog", "product analytics", "analytics", "screenpipe",
                            "monitor", "log", "observability", "openopc", "aiops"],
     "运维 / 可观测性 / 分析平台"),
    ("DevOps-Platform", ["cicd", "devops", "tencentdb-agent-memory", "modelengine",
                          "nexent"], "DevOps / CI/CD 平台"),
    ("DevTools-Plugins", ["cursor plugins", "plugins", "mcp", "browser extension",
                           "chrome-extension", "copilot", "edit-mind", "ecc",
                           "sensitive-word", "free-claude-code", "bookstack"],
     "开发工具 / 插件 / MCP"),
    ("Media-Tool-NonAI", ["vidbee", "视频下载", "youtube download", "tiktok download",
                           "wx_channel", "download video", "video downloader",
                           "matrixmedia"], "媒体工具 / 下载工具（弱 AI）"),
    ("Misc", [], "其他 / 未分类"),
]

AI_CATEGORIES = {c for c,_,_ in CATEGORY_RULES if c.startswith("AI-")}

AI_HINTS = [
    "ai", "llm", "gpt", "agent", "harness", "skill", "rag", "prompt", "llama",
    "qwen", "model", "copilot", "diffusion", "tts", "vision", "embedding",
    "fine-tun", "training", "knowledge", "claude", "codex", "cursor",
    "mcp", "opencode", "nano", "digital human", "数字人", "短剧",
    "red team", "redteam", "intelligent", "智能", "开源免费的舆情系统",
]

def is_ai_related(item, category):
    if category in AI_CATEGORIES:
        return True
    text = f"{item.get('description','')} {' '.join(item.get('topics',[]))} {item.get('full_name','')}".lower()
    return any(h in text for h in AI_HINTS)

def classify(item):
    text = f"{item.get('description','')} {' '.join(item.get('topics',[]))} {item.get('full_name','')}".lower()
    for cat, keywords, _ in CATEGORY_RULES[:-1]:
        for kw in keywords:
            if kw.lower() in text:
                return cat
    return "Misc"

def one_line_summary(item):
    desc = (item.get("description") or "").strip()
    if not desc:
        return "(项目无描述)"
    if len(desc) > 140:
        desc = desc[:137] + "..."
    return desc

# ===== 4. 匹配 =====
CLONED, NOT_CLONED = [], []
for item in STARRED:
    full = item["full_name"].lower().rstrip("/")
    local = None
    if full in LOCAL:
        local = LOCAL[full]["dir"]
    else:
        name_only = full.split("/")[-1]
        if name_only in local_repo_names_lower:
            local = local_dir_by_lower_name[name_only]
    item["_cloned"] = bool(local)
    item["_local_dir"] = local
    item["_category"] = classify(item)
    item["_is_ai"] = is_ai_related(item, item["_category"])
    item["_summary"] = one_line_summary(item)
    (CLONED if local else NOT_CLONED).append(item)

# ===== 5. 输出 =====
def category_counter(items):
    return Counter(x["_category"] for x in items).most_common()

def main():
    total = len(STARRED)
    cloned_n, not_cloned_n = len(CLONED), len(NOT_CLONED)
    ai_cloned = sum(1 for x in CLONED if x["_is_ai"])
    ai_not = sum(1 for x in NOT_CLONED if x["_is_ai"])

    print("=" * 78)
    print(f"  对比报告：GitHub Star（{total}） vs 本地 aiengine/ 克隆")
    print("=" * 78)
    print(f"\n  ✅ 已克隆到本地：{cloned_n:3d}    ❌ 未克隆：{not_cloned_n:3d}")
    print(f"  🤖 与 AI 相关：已克隆 {ai_cloned:3d} / 未克隆 {ai_not:3d} （合计 {ai_cloned+ai_not}）")
    print(f"  🔧 非 AI 项目：已克隆 {cloned_n-ai_cloned:3d} / 未克隆 {not_cloned_n-ai_not:3d}")
    print()

    print("── 分类统计（已克隆）──")
    for cat, n in category_counter(CLONED):
        cn = next((c[2] for c in CATEGORY_RULES if c[0]==cat), cat)
        print(f"  {cat:26s}  {cn:22s}: {n:3d}")
    print()
    print("── 分类统计（未克隆）──")
    for cat, n in category_counter(NOT_CLONED):
        cn = next((c[2] for c in CATEGORY_RULES if c[0]==cat), cat)
        print(f"  {cat:26s}  {cn:22s}: {n:3d}")
    print()

    # 已克隆详情
    print("=" * 78)
    print(f"  ✅ 已克隆清单（{cloned_n}）：AI？ · 分类 · 项目 → 本地目录")
    print("=" * 78)
    by_cat = defaultdict(list)
    for x in CLONED:
        by_cat[x["_category"]].append(x)
    for cat, _ in category_counter(CLONED):
        cn = next((c[2] for c in CATEGORY_RULES if c[0]==cat), cat)
        print(f"\n▍{cat} — {cn}")
        for x in sorted(by_cat[cat], key=lambda i: -i.get("stars", 0)):
            tag = "🤖AI" if x["_is_ai"] else "🔧  "
            stars = f"{x.get('stars', 0):>7,}"
            print(f"  [{tag}] ⭐{stars:>8s}  {x['full_name']}")
            print(f"         → 本地：{x['_local_dir']}")
            print(f"         {x['_summary']}")

    # 未克隆 TOP 50
    print()
    print("=" * 78)
    top_n = min(50, len(NOT_CLONED))
    print(f"  ❌ 未克隆 · 热门 TOP {top_n}（按 star 降序）")
    print("=" * 78)
    nc_sorted = sorted(NOT_CLONED, key=lambda i: -i.get("stars", 0))
    by_cat_nc = defaultdict(list)
    for x in nc_sorted[:top_n]:
        by_cat_nc[x["_category"]].append(x)
    for cat, _, _ in CATEGORY_RULES:
        items = by_cat_nc.get(cat)
        if not items:
            continue
        cn = next((c[2] for c in CATEGORY_RULES if c[0]==cat), cat)
        print(f"\n▍{cat} — {cn}")
        for x in items:
            tag = "🤖AI" if x["_is_ai"] else "🔧  "
            stars = f"{x.get('stars', 0):>7,}"
            print(f"  [{tag}] ⭐{stars:>8s}  {x['full_name']}")
            print(f"         {x['_summary']}")

    # 本地有但没 star
    print()
    print("=" * 78)
    print("  🔎 本地有 clone、但你没 star 的项目（两者不一致的清单）")
    print("=" * 78)
    starred_fulls_lower = {x["full_name"].lower().rstrip("/") for x in STARRED}
    starred_names_lower = {x["full_name"].split("/")[-1].lower() for x in STARRED}
    no_star = []
    for repo_key, info in LOCAL.items():
        if repo_key not in starred_fulls_lower:
            name_only = repo_key.split("/")[-1]
            if name_only not in starred_names_lower:
                no_star.append((info["dir"], repo_key))
    no_star.append(("docs", "(本地文档目录，非 GitHub 仓库)"))
    if no_star:
        for d, r in no_star:
            print(f"  📁 {d:<36s}  {r}")
    else:
        print("  无：本地 clone 的都 star 过了")

    print()
    print("=" * 78)
    print("报告结束。完整 JSON → tools/data/starred_vs_local.json")

out = {
    "total_starred": len(STARRED), "cloned": len(CLONED), "not_cloned": len(NOT_CLONED),
    "cloned_items": CLONED, "not_cloned_items": NOT_CLONED,
}
with open(os.path.join(DATA_DIR, "starred_vs_local.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

main()
