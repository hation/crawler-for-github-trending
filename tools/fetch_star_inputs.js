#!/usr/bin/env node
// ===== 生成 Star 对比流程的两个输入文件（tools/data/）=====
// 1. starred_all.json  —— 当前 GitHub 账号 star 的全部项目（每行一个 JSON 对象）
// 2. local_repos.txt  —— 本地 aiengine 目录下克隆的仓库清单（格式：本地目录|owner/repo|remote）
// 用法：node tools/fetch_star_inputs.js [本地目录]
//   本地目录默认 /Users/xingan/Documents/software/aiengine，可传参覆盖
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "data");
const STARRED_FILE = path.join(DATA_DIR, "starred_all.json");
const LOCAL_FILE = path.join(DATA_DIR, "local_repos.txt");

// ===== 1) 拉取当前账号全部 star 项目 =====
function fetchStarred() {
    console.log("[fetch] 拉取 star 项目列表（gh api user/starred --paginate）...");
    const out = execSync("gh api user/starred --paginate", {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60000,
    });
    const items = JSON.parse(out);
    // 只保留后续脚本用到的字段，每行一个 JSON
    const lines = items.map((r) =>
        JSON.stringify({
            full_name: r.full_name,
            description: r.description || "",
            language: r.language || null,
            topics: r.topics || [],
            stars: r.stargazers_count || 0,
        })
    );
    fs.writeFileSync(STARRED_FILE, lines.join("\n") + "\n", "utf8");
    console.log(`[fetch] ✓ ${items.length} 个项目 → ${STARRED_FILE}`);
}

// ===== 2) 扫描本地目录，找 git 仓库 =====
function listLocalRepos(baseDir) {
    const entries = [];
    let names;
    try {
        names = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        console.error(`[fetch] 无法读取目录 ${baseDir}: ${e.message}`);
        return entries;
    }
    for (const ent of names) {
        if (!ent.isDirectory()) continue;
        const dir = ent.name;
        const abs = path.join(baseDir, dir);
        // 排除明显非仓库目录
        if (["docs", "node_modules", ".git"].includes(dir)) continue;
        if (!fs.existsSync(path.join(abs, ".git"))) continue;
        let remote = "";
        try {
            remote = execSync(`git -C "${abs}" remote get-url origin`, {
                encoding: "utf8", timeout: 10000,
            }).trim();
        } catch (_) { /* 无 origin 远程 */ }
        // 从 remote 提取 owner/repo（支持 https / git@ / ssh 形式）
        let repoFull = "";
        const m = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/);
        if (m) repoFull = m[1];
        entries.push(`${dir}|${repoFull || "not-a-git-repo"}|${remote}`);
    }
    // 固定补充 docs 目录占位（与下游脚本约定一致）
    entries.push("docs||(本地文档目录，非 GitHub 仓库)");
    return entries;
}

const baseDir = process.argv[2] || "/Users/xingan/Documents/software/aiengine";
fetchStarred();
const repos = listLocalRepos(baseDir);
fs.writeFileSync(LOCAL_FILE, repos.join("\n") + "\n", "utf8");
console.log(`[fetch] ✓ 本地仓库 ${repos.length - 1} 个 → ${LOCAL_FILE}`);
console.log("[fetch] 完成。可用 analyze_stars.py → translate_to_zh.js → export_excel_*.py 生成对比报告。");
