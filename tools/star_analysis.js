// ===== Star 涨势分析数据引擎 =====
// 用法: node tools/star_analysis.js [--days N] [--top N]
//   --days 时间窗口天数，默认 7
//   --top  分析前 N 名，默认 50
// 自动完成投资分析框架的第 ①③ 步（本地数据）：
//   ① 信号拆解：涨速 TOP N 排名 + 按 summary/solves 关键词归类赛道，汇总赛道热度
//   ③ 持续性验证：读 star_history 全时序，计算日增/近3日前3日增量，分档 加速/平台/回落
// 输出：
//   - 终端摘要
//   - 数据包 JSON → tools/data/star_analysis_<days>d_<日期>.json（供联网检索与报告生成）
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/crawler");

// ===== 参数解析 =====
function parseArgs(argv) {
  const args = { days: 7, top: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      const v = parseInt(argv[i + 1], 10);
      if (Number.isInteger(v) && v > 0) args.days = v;
    }
    if (argv[i] === "--top") {
      const v = parseInt(argv[i + 1], 10);
      if (Number.isInteger(v) && v > 0) args.top = v;
    }
  }
  return args;
}

// ===== 赛道归类规则（按 summary/title 关键词，自上而下优先匹配）=====
// 技能/规则库前置：关键词更具体（输出规则/准则/技能），避免被"编码助手"等泛词先匹配
const SECTOR_RULES = [
  ["Agent技能/规则库", ["skill", "技能", "技能库", "提示词", "prompt", "输出规则", "adhd", "回答", "图表", "diagram", "设计系统", "模板", "架构图", "工作流", "准则"]],
  ["编码Agent/Harness", ["编码agent", "编码智能体", "编码助手", "编码代理", "智能体开发环境", "ade", "并行ai编码", "coding agent", "harness", "claude code", "codex", "终端编码", "agent开发环境", "编码工具"]],
  ["内容生成", ["视频", "图像", "图片", "音频", "语音", "配音", "短视频", "视觉", "tts", "comfyui", "渲染", "生成高清", "music"]],
  ["聚合/API层", ["api", "接口", "聚合", "统一", "provider", "模型路由", "免费大模型", "免费云", "订阅", "api额度", "代理"]],
  ["AI教育/求职", ["教育", "课程", "书籍", "book", "教程", "学习", "授课", "课堂", "求职", "简历", "职业"]],
  ["空间情报", ["3d", "地球", "地图", "空间", "情报", "态势", "地理", "卫星", "飞行", "船舶", "实时全球"]],
  ["基础设施/工具", ["隧道", "加密", "隧道传输", "本地", "设备", "驱动", "渗透", "安全漏洞", "监控", "端点"]],
  ["其他", []],
];

function classify(item) {
  const text = `${item.title} ${item.summary || ""}`.toLowerCase();
  for (const [name, keywords] of SECTOR_RULES) {
    if (keywords.some((k) => text.includes(k.toLowerCase()))) return name;
  }
  return "其他";
}

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function main() {
  const { days, top } = parseArgs(process.argv.slice(2));

  // ① 涨速 TOP N + summary
  const rank = await pool.query(
    `WITH latest AS (
        SELECT DISTINCT ON (title) title, stars
        FROM star_history ORDER BY title, fetched_at DESC
      ),
      prev AS (
        SELECT DISTINCT ON (title) title, stars
        FROM star_history WHERE fetched_at <= now() - make_interval(days => $2)
        ORDER BY title, fetched_at DESC
      ),
      summary AS (
        SELECT DISTINCT ON (title) title, summary
        FROM trending_snapshots WHERE summary IS NOT NULL AND summary <> ''
        ORDER BY title, fetched_at DESC
      )
      SELECT l.title,
             l.stars AS cur,
             COALESCE(p.stars, b.base_stars) AS prev_stars,
             l.stars - COALESCE(p.stars, b.base_stars) AS delta,
             s.summary
      FROM latest l
      JOIN project_track_level b ON b.title = l.title
      LEFT JOIN prev p ON p.title = l.title
      LEFT JOIN summary s ON s.title = l.title
      WHERE COALESCE(p.stars, b.base_stars) IS NOT NULL
      ORDER BY delta DESC
      LIMIT $1`,
    [top, days]
  );
  const ranked = rank.rows;

  // ③ 趋势分档（近3日 vs 前3日增量）
  const trend = await pool.query(
    `WITH ts AS (
        SELECT title, stars, row_number() OVER (PARTITION BY title ORDER BY fetched_at DESC) AS rn
        FROM star_history
      ),
      pivot AS (
        SELECT title,
               max(stars) FILTER (WHERE rn=1) AS c1,
               max(stars) FILTER (WHERE rn=4) AS c4,
               max(stars) FILTER (WHERE rn=7) AS c7,
               count(*) AS n
        FROM ts GROUP BY title
      )
      SELECT title,
             (c1 - COALESCE(c4, c1)) AS last3,
             (COALESCE(c4, c1) - COALESCE(c7, c4, c1)) AS prev3,
             n,
             CASE
               WHEN n < 4 OR c4 IS NULL THEN '数据不足'
               WHEN c7 IS NOT NULL AND (c1 - c4) > (c4 - c7) * 1.2 THEN '加速'
               WHEN c7 IS NOT NULL AND (c4 - c7) > 0 AND (c1 - c4) < (c4 - c7) * 0.8 THEN '回落'
               ELSE '平台'
             END AS trend
      FROM pivot`,
    []
  );
  const trendMap = new Map(trend.rows.map((r) => [r.title, r]));

  // 关键项目时序（加速档 + TOP 8 的近 10 天序列，供画图）
  const keyTitles = ranked
    .filter((r) => (trendMap.get(r.title) || {}).trend === "加速")
    .map((r) => r.title);
  ranked.slice(0, 8).forEach((r) => keyTitles.push(r.title));
  const keyTitlesUniq = [...new Set(keyTitles)];
  const series = {};
  if (keyTitlesUniq.length) {
    const s = await pool.query(
      `SELECT title, stars, fetched_at::date AS d
       FROM star_history
       WHERE title = ANY($1)
       ORDER BY title, fetched_at`,
      [keyTitlesUniq]
    );
    for (const r of s.rows) {
      (series[r.title] = series[r.title] || []).push({ d: r.d, stars: r.stars });
    }
    for (const t of Object.keys(series)) {
      let prev = null;
      series[t] = series[t].map((p) => {
        const daily = prev === null ? null : p.stars - prev;
        prev = p.stars;
        return { d: p.d, stars: p.stars, daily };
      });
    }
  }

  // 组装数据包（pg 对 bigint/numeric 返回字符串，需转 Number）
  const items = ranked.map((r) => {
    const t = trendMap.get(r.title) || { last3: null, prev3: null, trend: "数据不足" };
    return {
      title: r.title,
      cur_stars: Number(r.cur),
      prev_stars: Number(r.prev_stars),
      delta: Number(r.delta),
      last3: t.last3 === null ? null : Number(t.last3),
      prev3: t.prev3 === null ? null : Number(t.prev3),
      trend: t.trend,
      sector: classify(r),
      summary: r.summary || "",
    };
  });

  const sectors = [];
  const sectorMap = new Map();
  for (const it of items) {
    if (!sectorMap.has(it.sector)) sectorMap.set(it.sector, { sector: it.sector, total_delta: 0, projects: [] });
    const s = sectorMap.get(it.sector);
    s.total_delta += it.delta;
    s.projects.push(it.title);
  }
  sectorMap.forEach((v) => sectors.push(v));
  sectors.sort((a, b) => b.total_delta - a.total_delta);

  const trendCount = { 加速: 0, 平台: 0, 回落: 0, 数据不足: 0 };
  items.forEach((it) => { trendCount[it.trend] = (trendCount[it.trend] || 0) + 1; });

  const pkg = {
    meta: { days, top, generated_at: new Date().toISOString() },
    total_delta: items.reduce((s, r) => s + r.delta, 0),
    trend_count: trendCount,
    sectors,
    items,
    key_series: series,
  };

  // 终端摘要
  console.log(`# Star 趋势分析数据包（近 ${days} 天 · TOP ${top}）`);
  console.log(`- 增量合计: ${fmt(pkg.total_delta)}  ⭐`);
  console.log(`- 趋势分布: 加速 ${trendCount["加速"]} / 平台 ${trendCount["平台"]} / 回落 ${trendCount["回落"]} / 数据不足 ${trendCount["数据不足"]}`);
  console.log("- 赛道热度:");
  sectors.forEach((s) => {
    console.log(`  ${s.sector.padEnd(12)} ${fmt(s.total_delta).padStart(9)}  (${s.projects.length} 个)`);
  });
  console.log("- 加速项目:");
  items.filter((i) => i.trend === "加速").forEach((i) => {
    console.log(`  ${i.title}  近3日 ${i.last3} / 前3日 ${i.prev3}`);
  });

  // 写数据包
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const file = path.join(__dirname, "data", `star_analysis_${days}d_${date}.json`);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 1), "utf8");
  console.log(`\n数据包已写入 → ${file}`);

  await pool.end();
}

main().catch((err) => {
  console.error("[star_analysis] 失败:", err.message);
  process.exit(1);
});
