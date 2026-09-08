// ===== 提示词集中管理 =====
// 所有发给豆包 LLM 的 system / user 提示词都集中在这里，方便手动调整后重跑对比效果。
// 使用方法：require("./prompts")（src/ 内）或 require("../src/prompts")（tools/ 内）。
// 修改提示词后，重新运行对应命令即可看到效果差异。

// ===== ① 榜单项目分析（src/crawler.js 的 analyzeProject / fillReadmeSummary）=====
// 用途：每日榜单爬取时，基于 README 分析每个项目，产出 summary（一句话总结）+ solves（详细解决什么问题）。
// 注意：输出必须保持 JSON 结构，crawler.js 依赖该格式解析。
const ANALYZE_SYSTEM_PROMPT = `你是 GitHub 仓库分析助手。请基于 README 分析项目，输出两项内容：
1. summary：用一句话（不超过30字，中文）总结这个项目主要解决什么问题，只输出这句话本身。
2. solves：用一段话（50~150字，中文）详细说明这个项目是给谁用的、解决什么痛点、大致怎么做。
严格以 JSON 格式输出：{"summary":"一句话","solves":"一段话"}。不要输出任何其他内容、前缀或解释。`;

// user 消息：喂项目名 + 描述 + README 全文
const analyzeUserPrompt = (item, readme) =>
    `项目: ${item.title}\n描述: ${item.description || ""}\nREADME全文:\n${readme || ""}`;

// ===== ② star 项目描述翻译（tools/translate_to_zh.js 的 SYSTEM_PROMPT）=====
// 用途：把 star 项目的中英混合描述改写成一句 10~35 字的中文"解决什么问题"。
// 注意：规则 3 的专有名词保留列表若调整，需与 translate_to_zh.js 里的 KEEP_WORDS 校验白名单保持一致，
//       否则可能出现"翻译了但校验不通过被重译"的情况。
const TRANSLATE_SYSTEM_PROMPT = `你是一个高质量的 GitHub 项目中文翻译助手。你的任务是把给定的英文/中英混合项目描述，改写成一句自然流畅的简体中文，准确回答「这个项目解决什么问题」。

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

// user 消息：喂项目名 + 语言 + topics + 描述
const translateUserPrompt = ({ fullName, lang, topics, desc }) =>
`项目：${fullName}
主要语言：${lang || "未标注"}
Topics：${(topics || []).join(" / ") || "无"}
英文描述：
${desc || "(空描述)"}

请输出一句 10~35 字的自然中文，说明这个项目是用来解决什么问题的。只输出这句话本身。`;

// ===== ③ 翻译修复（tools/fix2.js 的 SYS）=====
// 用途：批量翻译中有个别不合格项时，用更严格的中文约束重译。
// 注意：要求 100% 纯中文（无字母无 emoji），fix2.js 靠这个约束做质量校验。
const FIX_SYSTEM_PROMPT = `你是 GitHub 项目中文介绍改写者。把英文描述改写成 15~35 字的流畅中文句子，回答「这个项目做什么用」。
强制规则：
- 输出必须 100% 纯中文（允许数字、标点），不允许任何英文字母 a-z/A-Z，不允许 emoji。
- 常见词「微信、敏感词、Java、Python、DFA、API」等在中文里出现必须改为中文等价表达（如果有的话），实在没有就用中文意译。
- 只输出中文句子本体，不要引号、前缀、解释。`;

// user 消息：喂项目名 + 语言 + 描述
const fixUserPrompt = ({ fn, language, description }) =>
`项目名：${fn}\n语言：${language || ""}\n英文描述：\n${description || ""}\n\n请给出 15~35 字的纯中文一句话介绍。禁止任何字母和 emoji。`;

module.exports = {
    ANALYZE_SYSTEM_PROMPT,
    analyzeUserPrompt,
    TRANSLATE_SYSTEM_PROMPT,
    translateUserPrompt,
    FIX_SYSTEM_PROMPT,
    fixUserPrompt,
};
