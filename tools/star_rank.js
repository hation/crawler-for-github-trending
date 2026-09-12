// ===== Star 涨速排名查询工具 =====
// 用法: node tools/star_rank.js [--days N] [--top N] [--csv]
//   --days 时间窗口天数，默认 7（一周传 7、一月传 30、任意 N 天传 N）
//   --top  取增量降序前 N 名，默认 20
//   --csv  同时导出 CSV 到 tools/data/star_rank_<N>d_<日期>.csv
// 统计口径：增量 = 最新采样 − N 天前最近一次采样（窗口期净增长）；
// 窗口前无采样的新追踪项目用 project_track_level.base_stars 兜底并标注「新追踪」。
// 排序范围：全量按增量降序取前 N（含负增长），并附带项目一句话总结。
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/crawler");

// ===== 参数解析 =====
function parseArgs(argv) {
  const args = { days: 7, top: 20, csv: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      const v = parseInt(argv[i + 1], 10);
      if (Number.isInteger(v) && v > 0) args.days = v;
    }
    if (argv[i] === "--top") {
      const v = parseInt(argv[i + 1], 10);
      if (Number.isInteger(v) && v > 0) args.top = v;
    }
    if (argv[i] === "--csv") args.csv = true;
  }
  return args;
}

// ===== 显示宽度与格式化（中文按 2 字符宽对齐） =====
function width(str) {
  let w = 0;
  for (const ch of String(str)) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return w;
}
function padEnd(str, n) {
  str = String(str);
  return str + " ".repeat(Math.max(0, n - width(str)));
}
function padStart(str, n) {
  str = String(str);
  return " ".repeat(Math.max(0, n - width(str))) + str;
}
function truncate(str, n) {
  str = String(str);
  if (width(str) <= n) return str;
  let out = "";
  for (const ch of str) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + "…";
}
function fmtInt(n) {
  const sign = n > 0 ? "+" : "";
  return sign + n.toLocaleString("en-US");
}
function fmtPct(delta, base) {
  if (!base) return "—";
  return ((delta / base) * 100).toFixed(1) + "%";
}
function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const COL_RANK = 4;
const COL_TITLE = 38;
const COL_STARS = 12;
const COL_DELTA = 12;
const COL_PCT = 8;
const COL_SUMMARY = 50;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { days, top, csv } = args;
  const { rows } = await pool.query(
    `WITH latest AS (
        SELECT DISTINCT ON (title) title, stars, fetched_at
        FROM star_history
        ORDER BY title, fetched_at DESC
      ),
      prev AS (
        SELECT DISTINCT ON (title) title, stars
        FROM star_history
        WHERE fetched_at <= now() - make_interval(days => $2)
        ORDER BY title, fetched_at DESC
      ),
      summary AS (
        SELECT DISTINCT ON (title) title, summary
        FROM trending_snapshots
        WHERE summary IS NOT NULL AND summary <> ''
        ORDER BY title, fetched_at DESC
      )
      SELECT l.title,
             l.stars AS cur_stars,
             COALESCE(p.stars, b.base_stars) AS prev_stars,
             l.stars - COALESCE(p.stars, b.base_stars) AS delta,
             (p.stars IS NULL) AS is_new,
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

  console.log(`# Star 涨速排名（近 ${days} 天）· 前 ${top} 名 · 生成时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  console.log(
    padEnd("排名", COL_RANK) +
      " " +
      padEnd("项目", COL_TITLE) +
      padStart("当前⭐", COL_STARS) +
      padStart(`窗口前⭐`, COL_STARS) +
      padStart("增量", COL_DELTA) +
      padStart("增幅", COL_PCT) +
      "  " +
      padEnd("一句话总结", COL_SUMMARY)
  );
  console.log("-".repeat(COL_RANK + COL_TITLE + COL_STARS * 2 + COL_DELTA + COL_PCT + COL_SUMMARY + 4));

  rows.forEach((r, i) => {
    const tag = r.is_new ? "★新追踪" : "";
    const pct = fmtPct(r.delta, r.prev_stars);
    console.log(
      padStart(String(i + 1), COL_RANK) +
        " " +
        padEnd(truncate(r.title, COL_TITLE), COL_TITLE) +
        padStart(r.cur_stars.toLocaleString("en-US"), COL_STARS) +
        padStart(r.prev_stars.toLocaleString("en-US"), COL_STARS) +
        padStart(fmtInt(r.delta), COL_DELTA) +
        padStart(pct, COL_PCT) +
        "  " +
        padEnd(truncate(r.summary || "（无总结）", COL_SUMMARY - width(tag)), COL_SUMMARY) +
        tag
    );
  });

  if (csv) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const file = path.join(__dirname, "data", `star_rank_${days}d_${date}.csv`);
    const header = ["排名", "项目", "当前星", "窗口前星", "增量", "增幅", "新追踪", "一句话总结"];
    const lines = [header.join(",")];
    rows.forEach((r, i) => {
      lines.push(
        [
          i + 1,
          r.title,
          r.cur_stars,
          r.prev_stars,
          r.delta,
          fmtPct(r.delta, r.prev_stars),
          r.is_new ? "是" : "",
          r.summary || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    fs.writeFileSync(file, "\uFEFF" + lines.join("\n"), "utf8");
    console.log(`\n已导出 CSV → ${file}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[star_rank] 查询失败:", err.message);
  process.exit(1);
});
