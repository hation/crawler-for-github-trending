require("dotenv").config();
const cheerio = require("cheerio");
const axios = require("axios");
const HttpsProxyAgent = require("https-proxy-agent");
const { marked } = require("marked");
const { Pool } = require("pg");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ===== 基础配置 =====
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SEC) || 600) * 1000; // 默认缓存 10 分钟

// 数据库连接（本机 PostgreSQL，库 github_trending）
const DATABASE_URL =
    process.env.DATABASE_URL || "postgres://xingan@localhost:5432/github_trending";
const pool = new Pool({ connectionString: DATABASE_URL });

// 爬 GitHub 用的系统代理（GitHub 在国内被墙，需走代理）
const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
};

// ===== 豆包 LLM 配置（火山方舟 coding 端点，直连不走代理）=====
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3";
const ARK_MODEL = process.env.ARK_MODEL || "doubao-seed-2.0-code";

// 飞书推送配置（群自定义机器人 webhook），未配置则不推送
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || "";

function getArkKey() {
    if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
    try {
        const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8"));
        return auth.OPENAI_API_KEY || null;
    } catch (e) {
        return null;
    }
}

// ===== 抓取 GitHub Trending 列表（保留原作者解析与排序逻辑）=====
async function getData(time, language) {
    const url = "https://github.com/trending" + (!!language ? "/" + language : "") + "?since=" + time;
    const response = await axios
        .get(url, { headers: browserHeaders, httpsAgent, proxy: false })
        .catch(function (error) {
            return error;
        });

    if (!response.data) {
        throw new Error("GitHub request failed: " + (response.message || "no data"));
    }

    const $ = cheerio.load(response.data);
    let items_array = [];
    $(".Box .Box-row").each(function () {
        let obj = {};
        // 仓库标题在 <h2><a href="/owner/repo"> 中
        const href = $(this).find("h2 a").attr("href") || "";
        obj.title = href.replace(/^\//, "");
        obj.links = "https://github.com" + href;
        obj.description = $(this).find("p").text().trim();
        obj.language = $(this).find(">.f6 .repo-language-color").siblings().text();
        obj.stars = $(this).find(">.f6 a").eq(0).text().trim();
        obj.forks = $(this).find(">.f6 a").eq(1).text().trim();
        obj.info = $(this).find(">.f6 .float-sm-right").text().trim();
        obj.avatar = $(this).find(">.f6 img").eq(0).attr("src");
        items_array.push(obj);
    });

    // 按新增 star 数量排名（原作者逻辑）
    items_array.sort((item1, item2) => {
        return parseInt(item2.info.replace(/,/g, "")) - parseInt(item1.info.replace(/,/g, ""));
    });

    return items_array;
}

// ===== Markdown -> HTML -> 纯文本（去掉语法标记/HTML 标签，保留段落结构）=====
function markdownToText(md) {
    const html = marked.parse(md);
    const $ = cheerio.load(html);
    $("script,style,img,svg,iframe").remove();
    // block 元素后补换行，保留段落结构
    $("p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr,br").each(function () {
        $(this).append("\n");
    });
    return $("body")
        .text()
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ===== 抓取 README（raw.githubusercontent.com，同样走代理，只保留纯文本内容）=====
async function fetchReadme(ownerRepo) {
    const base = `https://raw.githubusercontent.com/${ownerRepo}/HEAD/`;
    const candidates = ["README.md", "readme.md", "README.markdown", "README.rst"];
    for (const file of candidates) {
        try {
            const resp = await axios.get(base + file, {
                headers: { "User-Agent": browserHeaders["User-Agent"] },
                httpsAgent,
                proxy: false,
                timeout: 15000,
                maxContentLength: 5 * 1024 * 1024,
            });
            if (resp.status === 200 && typeof resp.data === "string") {
                const text = markdownToText(resp.data);
                return text ? text.slice(0, 50000) : null; // 纯文本，限 5 万字符
            }
        } catch (e) {
            // 尝试下一个候选文件名
        }
    }
    return null;
}

// ===== 豆包项目分析：一次调用返回 summary（一句话总结）+ solves（详细解决什么问题）=====
async function analyzeProject(item, readme) {
    const key = getArkKey();
    if (!key) return { summary: null, solves: null };
    // 喂 README 全文（已是纯文本）
    const payload = `项目: ${item.title}\n描述: ${item.description || ""}\nREADME全文:\n${readme || ""}`;
    try {
        const resp = await axios.post(
            `${ARK_BASE_URL}/chat/completions`,
            {
                model: ARK_MODEL,
                messages: [
                    {
                        role: "system",
                        content:
                            "你是 GitHub 仓库分析助手。请基于 README 分析项目，输出两项内容：\n" +
                            "1. summary：用一句话（不超过30字，中文）总结这个项目主要解决什么问题，只输出这句话本身。\n" +
                            "2. solves：用一段话（50~150字，中文）详细说明这个项目是给谁用的、解决什么痛点、大致怎么做。\n" +
                            '严格以 JSON 格式输出：{"summary":"一句话","solves":"一段话"}。不要输出任何其他内容、前缀或解释。',
                    },
                    { role: "user", content: payload },
                ],
                max_tokens: 500,
                temperature: 0.3,
                thinking: { type: "disabled" }, // 禁用思考链，避免耗时过长/超时
            },
            {
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                proxy: false, // 国内火山服务直连
                timeout: 40000,
            }
        );
        const text = (resp.data && resp.data.choices && resp.data.choices[0].message.content) || "";
        return parseAnalysisJson(text);
    } catch (e) {
        console.error("[LLM] analyze failed:", e.message);
        return { summary: null, solves: null };
    }
}

// 解析 LLM 返回的 JSON，容错处理
function parseAnalysisJson(text) {
    const cleaned = text.trim().replace(/^```json\s*|^```\s*|\s*```$/g, "");
    let summary = null, solves = null;
    try {
        const obj = JSON.parse(cleaned);
        summary = (obj.summary || "").trim() || null;
        solves = (obj.solves || "").trim() || null;
    } catch (e) {
        // 非严格 JSON：尝试提取 summary/solves 字段文本
        const sm = cleaned.match(/"summary"\s*:\s*"([^"]*)"/);
        const sv = cleaned.match(/"solves"\s*:\s*"([^"]*)"/);
        if (sm) summary = sm[1].trim() || null;
        if (sv) solves = sv[1].trim() || null;
        // 兜底：如果只有一段文本，作为 summary 用
        if (!summary && !solves && cleaned.length < 100) summary = cleaned;
    }
    // 去掉首尾引号/装饰
    if (summary) summary = summary.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, "");
    if (solves) solves = solves.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, "");
    return { summary, solves };
}

// ===== 飞书推送（群自定义机器人 webhook，聚合为一条消息）=====
// 从 info（如 "1,588 stars today"）解析新增 star 数字
function parseInfoGain(info) {
    const m = (info || "").match(/([\d,]+)/);
    return m ? m[1].replace(/,/g, "") : "0";
}

async function pushToFeishu(items, label) {
    if (!FEISHU_WEBHOOK || !items || !items.length) return;
    // 所有项目聚合到一条 post 消息
    const lines = [];
    for (const item of items) {
        lines.push([
            { tag: "text", text: "📌 " },
            { tag: "a", text: item.title, href: item.links },
        ]);
        lines.push([{ tag: "text", text: `💡 ${item.summary || "（暂无总结）"}` }]);
        const langTag = item.language ? `   ·  🗂 ${item.language}` : "";
        lines.push([
            { tag: "text", text: `⭐ ${item.stars || "?"}   ⬆ 新增 ${parseInfoGain(item.info)}` },
            { tag: "text", text: langTag },
        ]);
        lines.push([{ tag: "text", text: "" }]); // 项目间空行分隔
    }
    const payload = {
        msg_type: "post",
        content: {
            post: {
                zh_cn: {
                    title: label ? `⭐ GitHub Trending · ${label}` : "⭐ GitHub Trending",
                    content: lines,
                },
            },
        },
    };
    try {
        await axios.post(FEISHU_WEBHOOK, payload, {
            timeout: 30000,
            proxy: false, // 飞书是国内服务，直连
        });
        console.log(`[feishu] push success (${items.length} items, label=${label})`);
    } catch (e) {
        console.error("[feishu] push failed:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

// ===== README + summary + solves 填充 =====
async function fillReadmeSummary(item) {
    // 缓存：只要库中有非空即可复用，相同项目不重复拉取
    const cached = await pool.query(
        `SELECT readme, summary, solves FROM trending_snapshots
         WHERE title = $1 AND readme IS NOT NULL AND readme <> ''
         ORDER BY fetched_at DESC LIMIT 1`,
        [item.title]
    );
    if (cached.rows.length) {
        item.readme = cached.rows[0].readme;
        item.summary = cached.rows[0].summary;  // 可能为 null，下面补齐
        item.solves = cached.rows[0].solves;    // 可能为 null，下面补齐
    } else {
        item.readme = await fetchReadme(item.title);
        item.summary = null;
        item.solves = null;
    }
    // summary/solves 任一缺失则调一次 LLM 补全（一次调用生成两项，省 token）
    if (item.readme && (!item.summary || !item.solves)) {
        const { summary, solves } = await analyzeProject(item, item.readme);
        if (!item.summary) item.summary = summary;
        if (!item.solves) item.solves = solves;
    }
}

// 带并发上限的 map
async function mapLimit(arr, limit, fn) {
    const results = new Array(arr.length);
    let next = 0;
    async function worker() {
        while (next < arr.length) {
            const i = next++;
            results[i] = await fn(arr[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return results;
}

// ===== 保存一批快照 =====
async function saveSnapshot(list, dimension, language) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const now = new Date();
        for (const item of list) {
            await client.query(
                `INSERT INTO trending_snapshots
                 (dimension, language, title, links, description, repo_language, stars, forks, info, avatar, readme, summary, solves, fetched_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [
                    dimension,
                    language,
                    item.title,
                    item.links,
                    item.description,
                    item.language,
                    item.stars,
                    item.forks,
                    item.info,
                    item.avatar,
                    item.readme || null,
                    item.summary || null,
                    item.solves || null,
                    now,
                ]
            );
        }
        await client.query("COMMIT");
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

// ===== 完整爬取流程：抓列表 -> 补 README/总结 -> 入库 -> 推送 =====
async function runCrawl(time, language) {
    const list = await getData(time, language);
    await mapLimit(list, 4, fillReadmeSummary); // 禁用思考后 LLM 2-3s/次，并发 4 足够
    await saveSnapshot(list, time, language);
    // 仅综合榜（未指定语言）推送飞书；带语言的数据只入库供接口查询，不推送
    if (!language) {
        await pushToFeishu(list, time); // 等待推送完成，确保进程退出前消息已发出
    }
    return list;
}

module.exports = { runCrawl, pool, getData, analyzeProject, fetchReadme };
