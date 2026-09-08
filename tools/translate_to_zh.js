#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 用火山豆包 LLM 把 324 个 GitHub 项目的 description 翻译为「中文一句话说明」。
 *  - 本地缓存（按项目 full_name 哈希），重跑不重复调用
 *  - 并发 8，失败重试 2 次
 *  - 质量校验：保留词白名单之外英文字 > 3 个自动重译（最多 2 次）
 *  - 专有名词（RAG/LLM/Agent/Harness/ComfyUI…）一律保留英文原词
 */
require("dotenv").config({ path: "/Users/xingan/Documents/software/trending/crawler-for-github-trending/.env" });
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");

const SRC = "/tmp/starred_all.json";                    // 324 个星标项目
const CACHE_FILE = "/tmp/zh_summary_cache.json";        // 翻译缓存（避免重复花钱）
const OUT_JSON = "/tmp/starred_with_zh.json";           // 带中文 summary 的结果
const LOG_FILE = "/tmp/zh_summary.log";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3";
const ARK_MODEL = process.env.ARK_MODEL || "doubao-seed-2.0-code";
function getArkKey() {
    if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
    try {
        const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8"));
        return auth.OPENAI_API_KEY || null;
    } catch (_) { return null; }
}

// --- 专有名词保留白名单（大小写不敏感匹配，保留原形式）---
const KEEP_WORDS = new Set([
    // AI 基础
    "ai", "llm", "llms", "gpt", "rag", "agent", "agents", "harness",
    "nlp", "cv", "ocr", "asr", "tts", "vlm", "ml", "dl",
    "mcp", "model", "models", "prompt", "prompts", "embedding", "embeddings",
    "diffusion", "sdk", "api", "apis", "cli", "ide", "ide's",
    // 模型/产品名
    "chatgpt", "claude", "codex", "llama", "llamafactory", "grok",
    "deepseek", "qwen", "doubao", "minimax", "volcengine", "ark",
    "comfyui", "stable diffusion", "sdxl", "midscene", "langchain",
    "langflow", "langgraph", "miroflow", "opengpt", "openclaw",
    "openhands", "openhands", "swe-agent", "swarm", "maigret",
    "vimax", "ruflo", "buzz", "odysseus", "gbrain",
    "superpowers", "headroom", "agentscope", "metagpt",
    "livedigital", "livetalking", "weknora", "ragflow",
    "hypergraphrag", "mempalace", "ppt-master",
    // 技术/协议
    "http", "https", "rest", "graphql", "websocket", "json", "yaml", "docker",
    "kubernetes", "k8s", "ui", "ux", "gui", "ssr", "csr", "spa", "cms",
    "ci", "cd", "cicd", "devops", "sql", "rss", "html", "css", "js", "ts",
    "wasm", "node.js", "react", "vue", "next.js", "flutter", "android", "ios",
    "rust", "python", "typescript", "javascript", "go", "zig", "java", "shell",
    "bazel", "copilot", "cursor", "vim", "vscode",
    // 公司/平台
    "github", "gitlab", "twitter", "reddit", "xhs", "tiktok", "douyin",
    "linkedin", "youtube", "instagram", "bilibili", "b站",
    "openai", "microsoft", "google", "anthropic", "apache", "tencent",
    "aws", "gcp", "azure", "posthog", "bookstack", "maxkb", "autogpt",
    // 其他常见保留词
    "open source", "open-source", "self-hosted", "self hosted", "real-time",
    "real time", "end-to-end", "e2e", "plug-in", "plugin", "plugins",
    "browser", "dockerfile", "s3", "oss", "saas", "paas", "iaas",
    "llmops", "aiops", "red-team", "redteam", "qa",
    "opus", "codex", "mini", "pro", "turbo", "v1", "v2", "v3",
]);

const SYSTEM_PROMPT = `你是一个高质量的 GitHub 项目中文翻译助手。你的任务是把给定的英文/中英混合项目描述，改写成一句自然流畅的简体中文，准确回答「这个项目解决什么问题」。

严格规则：
1. 长度 10~35 个字之间。**只输出这一句话本身，不要任何前缀、引号、后缀或解释**。
2. **必须是完整、自然的中文句子**，不能是单词列表。
3. 技术专有名词一律保留英文原词（不要翻译）：包括但不限于 AI、LLM、RAG、Agent、Harness、TTS、OCR、MCP、ComfyUI、LangChain、LangGraph、LangFlow、GPT、Claude、Codex、Llama、DeepSeek、Qwen、MiniMax、OpenHands、SWE-agent、MidScene、MiroFlow、MetaGPT、Headroom、AutoGPT、Ruflo、SuperPowers、PostHog、RAGFlow、WeKnora、Krona、Aider、Cursor、Copilot、GPT、Flutter、Android、iOS、React、Vue、Next.js、Docker、Kubernetes、K8s、HTTP、API、SDK、CLI、GUI、UI、RSS、JSON、SQL、SaaS、PaaS、GPT-4o 等。
4. 中文句号、逗号、冒号正常用；不要使用英文句号。
5. 禁止返回英文原文，禁止返回「（已翻译）」等占位词。
6. 如果你判断描述太短或无法理解，用中文写成「（该项目暂无有效描述）」，不要编造。

正确示例：
- 输入："An agentic skills framework & software development methodology that works"
  输出：提供 Agentic Skills 框架和配套的软件开发方法论
- 输入："Lightweight coding agent that runs in your terminal"
  输出：运行在你终端里的轻量编码 Agent
- 输入："A hive mind communication platform"
  输出：提供类似蜂巢思维的群体通信平台
- 输入：""
  输出：该项目暂无有效描述`;

// 读入星标项目
function loadItems() {
    const arr = [];
    for (const line of fs.readFileSync(SRC, "utf8").split("\n")) {
        const s = line.trim();
        if (s) arr.push(JSON.parse(s));
    }
    return arr;
}

// 缓存读写
function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
    catch (_) { return {}; }
}
function saveCache(c) { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1), "utf8"); }

// 日志
function log(msg) {
    const line = `[${new Date().toISOString().slice(0,19)}] ${msg}`;
    console.error(line);
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

// 调一次豆包
async function callLLM(fullName, desc, lang, topics) {
    const key = getArkKey();
    if (!key) throw new Error("NO_ARK_KEY");
    const userMsg =
`项目：${fullName}
主要语言：${lang || "未标注"}
Topics：${(topics||[]).join(" / ") || "无"}
英文描述：
${desc || "(空描述)"}

请输出一句 10~35 字的自然中文，说明这个项目是用来解决什么问题的。只输出这句话本身。`;

    const resp = await axios.post(
        `${ARK_BASE_URL}/chat/completions`,
        {
            model: ARK_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: userMsg },
            ],
            max_tokens: 180,
            temperature: 0.2,
            thinking: { type: "disabled" },
        },
        {
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            proxy: false,
            timeout: 40000,
        }
    );
    const text = (resp.data?.choices?.[0]?.message?.content || "").trim();
    return text
        .replace(/^[\s"'""''「」《》（）()【】\-—·.。,，:：]+|[\s"'""''「」《》（）()【】\-—·.。,，:：]+$/g, "")
        .replace(/\n+/g, "");
}

// 质量检查：非保留词的英文字符串数量（只看 >1 个字母的词）
function countNonKeepEnglish(text) {
    if (!text) return 999;
    const words = text.toLowerCase().match(/[a-z]{2,}/g) || [];
    let bad = 0;
    for (const w of words) {
        if (KEEP_WORDS.has(w)) continue;
        // 复数/所有格容错
        const base = w.replace(/s$/, "").replace(/'s$/, "");
        if (KEEP_WORDS.has(base)) continue;
        bad++;
    }
    return bad;
}

// 翻译并做质量检查，不行就重试
async function translateOne(item, cache) {
    const fullName = item.full_name;
    if (cache[fullName] && cache[fullName].zh) {
        return cache[fullName].zh;
    }
    const desc = item.description || "";
    const lang = item.language || null;
    const topics = item.topics || [];

    // 空描述直接返回
    if (!desc.trim()) {
        const zh = "该项目暂无有效描述";
        cache[fullName] = { zh, reason: "empty", attempts: 0 };
        saveCache(cache);
        return zh;
    }
    // 如果 description 已经是中文（中文字符占比 > 40%），直接用，只做长度裁剪
    const cnChars = (desc.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cnChars > 0 && cnChars / desc.length > 0.4) {
        let zh = desc.replace(/\s+/g, " ").trim();
        zh = zh.replace(/[.。]+$/, "");
        if (zh.length > 35) zh = zh.slice(0, 33) + "…";
        cache[fullName] = { zh, reason: "zh-native", attempts: 0 };
        saveCache(cache);
        return zh;
    }

    let best = null;
    let bestBad = Infinity;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const zh = await callLLM(fullName, desc, lang, topics);
            const bad = countNonKeepEnglish(zh);
            // 太短判定（<6 字）视为失败
            if (!zh || zh.length < 6) continue;
            if (bad < bestBad) { best = zh; bestBad = bad; }
            // 达标：保留词外英文词 ≤ 3 个，且字符 ≥ 10
            if (bestBad <= 3 && zh.length >= 10) break;
        } catch (e) {
            log(`[ERR] ${fullName} attempt=${attempt} ${e.message.slice(0,80)}`);
            await sleep(800 * attempt);
        }
    }
    if (!best) {
        // 最后兜底：描述前 35 字裁剪（不返回原文英文，直接中文兜底）
        const zh = "该项目描述暂无法高质量翻译，建议直接访问仓库查看详情";
        cache[fullName] = { zh, reason: "fallback", attempts: maxAttempts };
        saveCache(cache);
        return zh;
    }
    cache[fullName] = { zh: best, reason: "ok", bad_en: bestBad, attempts: maxAttempts };
    saveCache(cache);
    return best;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 并发执行（带并发上限）
async function mapLimit(arr, limit, fn) {
    const res = new Array(arr.length);
    let idx = 0;
    async function worker() {
        while (idx < arr.length) {
            const i = idx++;
            res[i] = await fn(arr[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return res;
}

(async function main() {
    const items = loadItems();
    const cache = loadCache();
    log(`开始翻译：共 ${items.length} 个项目，缓存已有 ${Object.keys(cache).length} 条`);

    const CONCURRENCY = 8;
    let done = 0;
    const zhs = await mapLimit(items, CONCURRENCY, async (item) => {
        const zh = await translateOne(item, cache);
        done++;
        if (done % 20 === 0) log(`进度 ${done}/${items.length}`);
        return zh;
    });

    // 合并到 items
    const out = items.map((it, i) => ({
        ...it,
        _summary_zh: zhs[i],
    }));
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1), "utf8");

    // 最终质量统计
    let ok = 0, zhNative = 0, empty = 0, fb = 0, badEnglish = 0;
    for (const it of out) {
        const meta = cache[it.full_name] || {};
        if (meta.reason === "ok") ok++;
        else if (meta.reason === "zh-native") zhNative++;
        else if (meta.reason === "empty") empty++;
        else if (meta.reason === "fallback") fb++;
        const be = countNonKeepEnglish(it._summary_zh);
        if (be > 3) {
            badEnglish++;
            log(`[BAD-EN] ${it.full_name} -> ${it._summary_zh}`);
        }
    }
    log(`完成 ✅ 总=${out.length}  LLM翻译=${ok}  原文中文=${zhNative}  空描述=${empty}  兜底=${fb}  保留词外英文超标的=${badEnglish}`);
    console.log(`\n翻译完成，输出文件 → ${OUT_JSON}`);
    console.log(`缓存文件 → ${CACHE_FILE}（下次重跑跳过已翻译项）`);
    process.exit(0);
})().catch(e => {
    log(`[FATAL] ${e.message}\n${e.stack?.slice(0,400)||""}`);
    process.exit(1);
});
