// Built-in task templates — turn "every day scrape competitor prices" into a
// structured, repeatable job with a known output table. The agent system prompt
// advertises these so a real model follows a template's steps + writes structured
// rows instead of inventing an ad-hoc flow each time. This is the "Copilot"
// differentiation: natural language → executable, inspectable, schedulable task.
export interface TaskTemplateInput {
  key: string;
  label: string;
  description: string;
  required: boolean;
  example?: string;
}

export interface TaskTemplate {
  id: string;
  title: string;
  category: "ecommerce" | "social" | "ads" | "data" | "ops";
  description: string;
  /** Risk classification shown to operators before scheduling. */
  riskLevel: "low" | "medium" | "high";
  /** Inputs the operator/model should provide before execution. */
  requiredInputs: TaskTemplateInput[];
  /** Tools expected during execution; used for prompt grounding + review. */
  tools: string[];
  /** Human-checkable success criteria for the run. */
  successCriteria: string[];
  /** Example user/operator prompt that can be copied into automation. */
  examplePrompt: string;
  /** The canonical prompt the agent expands from. */
  prompt: string;
  /** Structured output table the agent should CREATE + INSERT into. */
  outputTable?: { name: string; columns: string[] };
  /** Ordered step outline the agent should follow. */
  steps: string[];
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "price-scrape",
    title: "竞品价格采集",
    category: "ecommerce",
    description: "采集一组商品页的当前价格,结构化存库,可定时执行。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "urls", label: "商品 URL 列表", description: "要采集价格的商品页,一行一个。", required: true, example: "https://shop.example/products/widget" },
      { key: "profile", label: "登录/地区 Profile", description: "用于打开目标站点的 Browser profile。", required: true },
      { key: "schedule", label: "采集频率", description: "例如每天 09:00 或每 6 小时。", required: false, example: "每天 09:00" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["prices 表存在", "每个可访问 URL 至少写入一行", "记录包含 product/url/price/currency/captured_at", "失败 URL 在总结中列出"],
    examplePrompt: "用 price-scrape 模板采集这些商品页价格,写入 prices 表: https://shop.example/products/widget",
    prompt: "采集以下商品页的当前价格并存入 prices 表:每条记录 product/url/price/currency/captured_at。",
    outputTable: { name: "prices", columns: ["product", "url", "price", "currency", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS prices (id INTEGER PRIMARY KEY, product TEXT, url TEXT, price REAL, currency TEXT, captured_at TEXT)",
      "对每个商品 URL: browser_navigate(port, url) → browser_wait_for_load(port)",
      "browser_evaluate(port, <提取 product + price 的 JSON 表达式>)",
      "db_exec: INSERT INTO prices (...) VALUES (...) 参数化",
      "完成后用一句话总结采集到的条数",
    ],
  },
  {
    id: "news-collect",
    title: "新闻/资讯采集",
    category: "data",
    description: "从搜索结果页提取前 N 条新闻,存入 news 表。",
    riskLevel: "low",
    requiredInputs: [
      { key: "sourceUrl", label: "资讯/搜索结果 URL", description: "需要采集的列表页或搜索结果页。", required: true },
      { key: "limit", label: "条数", description: "默认前 10 条。", required: false, example: "10" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["news 表存在", "写入 title/url/source/published_at", "URL 去重", "总结采集条数"],
    examplePrompt: "用 news-collect 模板从这个搜索结果页采集前 10 条新闻并写入 news 表: https://example.com/search?q=market",
    prompt: "从指定搜索结果页提取前10条新闻,存入 news 表:title/url/source/published_at。",
    outputTable: { name: "news", columns: ["title", "url", "source", "published_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY, title TEXT, url TEXT UNIQUE, source TEXT, published_at TEXT)",
      "browser_navigate + browser_wait_for_load",
      "browser_evaluate: 提取 [...items].map(e=>({title,url,source}))",
      "db_exec: 多行参数化 INSERT",
      "总结条数",
    ],
  },
  {
    id: "account-check",
    title: "账号健康巡检",
    category: "ops",
    description: "逐个登录态检查账号,记录是否在线/被风控,存入 account_health。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "accounts", label: "账号范围", description: "要巡检的平台账号或 profile tags。", required: true, example: "tag:ecommerce" },
      { key: "platform", label: "平台", description: "Amazon/Shopee/TikTok/Facebook/自定义 URL。", required: true },
    ],
    tools: ["list_accounts", "browser_navigate", "browser_snapshot", "browser_evaluate", "db_exec"],
    successCriteria: ["account_health 表存在", "每个账号都有 online/challenge/blocked/unknown 状态", "不提交表单或更改账号", "异常写入总结"],
    examplePrompt: "用 account-check 模板巡检 tag=ecommerce 的账号登录状态,写入 account_health。",
    prompt: "巡检账号登录状态,把每个账号的 status(online/challenge/blocked) 写入 account_health 表。",
    outputTable: { name: "account_health", columns: ["account", "platform", "status", "checked_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS account_health (id INTEGER PRIMARY KEY, account TEXT, platform TEXT, status TEXT, checked_at TEXT)",
      "list_accounts 取账号清单",
      "逐个 browser_navigate 到平台 → browser_snapshot/evaluate 判断登录态",
      "db_exec: INSERT 巡检结果",
    ],
  },
  {
    id: "ad-balance",
    title: "广告后台余额抓取",
    category: "ads",
    description: "抓取广告平台后台的账户余额/消耗,存入 ad_balances。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "platformUrl", label: "广告后台 URL", description: "账户余额页面或广告后台首页。", required: true },
      { key: "accounts", label: "账号/Profile", description: "需要采集的账号范围。", required: true },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["ad_balances 表存在", "写入 platform/account/balance/spent/currency/at", "余额解析失败时不写入假数据", "总结异常账号"],
    examplePrompt: "用 ad-balance 模板抓取广告后台余额和本日消耗,写入 ad_balances。",
    prompt: "抓取广告后台各账户余额与本日消耗,存入 ad_balances:platform/account/balance/spent/currency/at。",
    outputTable: { name: "ad_balances", columns: ["platform", "account", "balance", "spent", "currency", "at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS ad_balances (id INTEGER PRIMARY KEY, platform TEXT, account TEXT, balance REAL, spent REAL, currency TEXT, at TEXT)",
      "browser_navigate 到广告后台 → browser_evaluate 提取余额",
      "db_exec: INSERT",
    ],
  },
  {
    id: "form-webhook",
    title: "表单数据提交到 Webhook",
    category: "ops",
    description: "从页面采集结构化数据,POST 到外部 webhook/ERP。",
    riskLevel: "high",
    requiredInputs: [
      { key: "sourceUrl", label: "数据页面 URL", description: "要读取表单/订单数据的页面。", required: true },
      { key: "webhookUrl", label: "Webhook URL", description: "接收 JSON 的 HTTPS endpoint。", required: true, example: "https://erp.example/webhook" },
      { key: "payloadFields", label: "字段映射", description: "需要提取并提交的字段。", required: true },
    ],
    tools: ["browser_navigate", "browser_evaluate", "http_request", "db_exec"],
    successCriteria: ["只 POST 到用户提供的 endpoint", "webhook_exports 记录 endpoint/status/at", "失败响应记录 status/error", "payload 不包含未请求的敏感字段"],
    examplePrompt: "用 form-webhook 模板从当前订单页提取订单号/金额,POST 到 https://erp.example/webhook,并记录 webhook_exports。",
    prompt: "采集页面表单数据,组装 JSON,http_request POST 到指定 webhook。",
    outputTable: { name: "webhook_exports", columns: ["endpoint", "payload", "status", "at"] },
    steps: [
      "browser_evaluate: 提取表单字段为 JSON",
      "http_request: POST (method:POST, url:<webhook>, body:JSON)",
      "db_exec: INSERT 导出记录到 webhook_exports",
    ],
  },
];

export function getTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.id === id);
}

/** Render the template catalog for injection into the agent system prompt. */
export function renderTemplateCatalog(): string {
  const lines = TASK_TEMPLATES.map((t) => {
    const cols = t.outputTable ? ` → 表 ${t.outputTable.name}(${t.outputTable.columns.join(", ")})` : "";
    const inputs = t.requiredInputs.filter((i) => i.required).map((i) => i.key).join(", ") || "none";
    return `- 【${t.id}】${t.title} [risk:${t.riskLevel}; tools:${t.tools.join("/")}; inputs:${inputs}]${cols}: ${t.description} 成功标准:${t.successCriteria.join("; ")}`;
  });
  return [
    "## 内置任务模板(Copilot)",
    "当用户的需求匹配以下模板时,优先按模板的 requiredInputs/steps/successCriteria 执行,并把结构化结果写入模板指定的表。这样任务可复用、可定时、可审计。",
    "",
    ...lines,
    "",
    "执行模板时:先确认必要输入,再 db_exec 建表(CREATE TABLE IF NOT EXISTS),按 steps 顺序用 browser_*/http_request/db_exec 执行,最后按 successCriteria 汇报。高风险模板或 http_request POST/PUT/PATCH/DELETE 会触发用户审批,拒绝时必须停止外部写入并汇报。不要每次重新发明流程。",
  ].join("\n");
}
