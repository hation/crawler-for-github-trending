require("dotenv").config({path:"./.env"});
const fs=require("fs"), os=require("os"), path=require("path"), axios=require("axios");
const { FIX_SYSTEM_PROMPT, fixUserPrompt } = require("../src/prompts");
const ARK=process.env.ARK_BASE_URL||"https://ark.cn-beijing.volces.com/api/coding/v3";
const MODEL=process.env.ARK_MODEL||"doubao-seed-2.0-code";
const K=process.env.ARK_API_KEY || JSON.parse(fs.readFileSync(path.join(os.homedir(),".codex","auth.json"),"utf8")).OPENAI_API_KEY;

const cache = JSON.parse(fs.readFileSync(path.join(__dirname,"data","zh_summary_cache.json"),"utf8"));
const items = ["houbb/sensitive-word", "littlecodersh/ItChat"];
const all = [];
for(const l of fs.readFileSync(path.join(__dirname,"data","starred_all.json"),"utf8").split("\n"))if(l.trim())all.push(JSON.parse(l));

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
          {role:"system",content:FIX_SYSTEM_PROMPT},
          {role:"user",content:fixUserPrompt({ fn, language: it.language, description: it.description })}
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
  fs.writeFileSync(path.join(__dirname,"data","zh_summary_cache.json"), JSON.stringify(cache,null,1));
  console.log("✅ 2 个修复完成，缓存已写回。");
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
