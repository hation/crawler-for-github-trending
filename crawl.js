const { runCrawl } = require("./crawler");

// 用法: node crawl.js <daily|weekly|monthly> [language]
const time = process.argv[2];
const language = process.argv[3] || "";

if (!["daily", "weekly", "monthly"].includes(time)) {
    console.error("用法: node crawl.js <daily|weekly|monthly> [language]");
    process.exit(1);
}

console.log(`[crawl] 开始拉取 ${time} 榜${language ? " · " + language : ""}`);
runCrawl(time, language)
    .then((list) => {
        console.log(`[crawl] ${time} 榜拉取完成，共 ${list.length} 个项目，已入库并推送飞书`);
        process.exit(0);
    })
    .catch((e) => {
        console.error(`[crawl] ${time} 榜拉取失败:`, e.message);
        process.exit(1);
    });
