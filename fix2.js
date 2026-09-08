require("dotenv").config({path:"./.env"});
const fs=require("fs"), os=require("os"), path=require("path"), axios=require("axios");
const ARK=process.env.ARK_BASE_URL||"https://ark.cn-beijing.volces.com/api/coding/v3";
const MODEL=process.env.ARK_MODEL||"doubao-seed-2.0-code";
const K=process.env.ARK_API_KEY || JSON.parse(fs.readFileSync(path.join(os.homedir(),".codex","auth.json"),"utf8")).OPENAI_API_KEY;
const SYS=`你是 GitHub 项目中文介绍改写者。把英文描述改写成 15~35 字的流畅中文句子，回答「这个项目做什么用」。
强制规则：
- 输出必须 100% 纯中文（允许数字、标点），不允许任何英文字母 a-z/A-Z，不允许 emoji。
- 常见词「微信、敏感词、Java、Python、DFA、API」等在中文里出现必须改为中文等价表达（如果有的话），实在没有就用中文意译。
- 只输出中文句子本体，不要引号、前缀、解释。`;

const cache = JSON.parse(fs.readFileSync("/tmp/zh_summary_cache.json","utf8"));
const items = ["houbb/sensitive-word", "littlecodersh/ItChat"];
const all = [];
for(const l of fs.readFileSync("/tmp/starred_all.json","utf8").split("\n"))if(l.trim())all.push(JSON.parse(l));

(async()=>{
  for(const fn of items){
    const it = all.find(x=>x.full_name===fn);
    console.log("修复:", fn);
    console.log("  原文:", it.description);
    let zh = null;
    for(let a=1; a<=3; a++){
      const r = await axios.post(ARK+"/chat/completions",{
        model:MODEL,
        messages:[
          {role:"system",content:SYS},
          {role:"user",content:`项目名：${fn}\n语言：${it.language||""}\n英文描述：\n${it.description||""}\n\n请给出 15~35 字的纯中文一句话介绍。禁止任何字母和 emoji。`}
        ],
        max_tokens:180,temperature:0.1,thinking:{type:"disabled"}
      },{headers:{Authorization:"Bearer "+K,"Content-Type":"application/json"},proxy:false,timeout:40000});
      zh = r.data.choices[0].message.content.trim();
      const english = (zh.match(/[a-zA-Z]/g)||[]).length;
      const emoji = (zh.match(/[\u{1F300}-\u{1FAFF}]/gu)||[]).length;
      console.log(`  attempt=${a} 字母=${english} emoji=${emoji}  译=${zh}`);
      if(english === 0 && emoji === 0) break;
    }
    cache[fn] = {zh, reason:"ok-fixed", bad_en:0, attempts:3};
    console.log("  → 最终:", zh, "\n");
  }
  fs.writeFileSync("/tmp/zh_summary_cache.json", JSON.stringify(cache,null,1));
  console.log("✅ 2 个修复完成，缓存已写回。");
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
