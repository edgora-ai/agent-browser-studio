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
  {
    id: "product-inventory",
    title: "库存监控",
    category: "ecommerce",
    description: "按商品页列表检查在售/缺货状态与数量,存入库存快照表,可定时执行。",
    riskLevel: "low",
    requiredInputs: [
      { key: "urls", label: "商品 URL 列表", description: "要监控库存的商品页,一行一个。", required: true, example: "https://shop.example/products/widget" },
      { key: "profile", label: "地区/登录 Profile", description: "用于打开商品页的 Browser profile。", required: true },
      { key: "schedule", label: "巡检频率", description: "例如每 30 分钟。", required: false, example: "每 30 分钟" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["inventory_snapshots 表存在", "每个可访问 URL 写入一行", "字段含 product/url/in_stock/qty/price/checked_at", "缺货商品在总结中单独列出"],
    examplePrompt: "用 product-inventory 模板监控这些商品页库存,写入 inventory_snapshots: https://shop.example/products/widget",
    prompt: "检查以下商品页的在售状态与数量,写入 inventory_snapshots:product/url/in_stock/qty/price/checked_at。",
    outputTable: { name: "inventory_snapshots", columns: ["product", "url", "in_stock", "qty", "price", "checked_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS inventory_snapshots (id INTEGER PRIMARY KEY, product TEXT, url TEXT, in_stock INTEGER, qty INTEGER, price REAL, checked_at TEXT)",
      "对每个 URL: browser_navigate(port, url) → browser_wait_for_load(port)",
      "browser_evaluate: 提取 product/in_stock/qty/price",
      "db_exec: 参数化 INSERT",
      "总结写入条数并单独列出缺货项",
    ],
  },
  {
    id: "order-sync",
    title: "订单导出同步",
    category: "ecommerce",
    description: "从订单/后台列表页提取新订单并写入本地 orders 表,可选 POST 到 webhook/ERP。",
    riskLevel: "high",
    requiredInputs: [
      { key: "ordersUrl", label: "订单列表 URL", description: "订单/后台列表页。", required: true },
      { key: "webhookUrl", label: "Webhook URL(可选)", description: "POST 同步的 HTTPS endpoint。", required: false, example: "https://erp.example/orders" },
      { key: "range", label: "时间范围", description: "例如最近 24 小时。", required: false },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec", "http_request"],
    successCriteria: ["orders 表存在", "每笔新订单一行,含 order_id 去重", "字段含 order_id/platform/amount/status/placed_at", "POST 前提示用户并等待审批"],
    examplePrompt: "用 order-sync 模板同步最近 24 小时订单到 orders 表: https://seller.example/orders",
    prompt: "提取订单列表页的新订单,写入 orders 表;若提供了 webhook,再 http_request POST 同步。",
    outputTable: { name: "orders", columns: ["order_id", "platform", "amount", "currency", "status", "customer", "placed_at", "synced_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, order_id TEXT UNIQUE, platform TEXT, amount REAL, currency TEXT, status TEXT, customer TEXT, placed_at TEXT, synced_at TEXT)",
      "browser_navigate 到订单列表 → browser_evaluate 提取订单 JSON 数组",
      "db_exec: 参数化 INSERT,已存在 order_id 跳过",
      "若提供 webhook:http_request POST (提示用户,等待审批)",
      "总结新增/跳过条数",
    ],
  },
  {
    id: "review-monitor",
    title: "商品评价监控",
    category: "ecommerce",
    description: "采集商品页的评价列表,记录新增评价(标题/评分/内容),写入 reviews。",
    riskLevel: "low",
    requiredInputs: [
      { key: "urls", label: "商品 URL 列表", description: "要监控评价的商品页。", required: true },
      { key: "max", label: "每页条数上限", description: "默认 20。", required: false, example: "20" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["reviews 表存在", "写入 product/title/rating/content/author/captured_at", "同一条评价不重复写入", "总结新增条数"],
    examplePrompt: "用 review-monitor 模板监控这个商品页的新评价: https://shop.example/products/widget",
    prompt: "采集商品页评价,把新增评价写入 reviews:product/title/rating/content/author/captured_at。",
    outputTable: { name: "reviews", columns: ["product", "title", "rating", "content", "author", "url", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, product TEXT, title TEXT, rating REAL, content TEXT, author TEXT, url TEXT UNIQUE, captured_at TEXT)",
      "对每个商品页: browser_navigate → browser_wait_for_load → browser_evaluate 提取评价数组",
      "db_exec: 参数化 INSERT,url 重复跳过",
      "总结新增条数",
    ],
  },
  {
    id: "keyword-rank",
    title: "关键词排名跟踪",
    category: "ecommerce",
    description: "在搜索引擎/平台搜索框搜索关键词,记录前 N 名结果的标题与 URL,写入 keyword_ranks。",
    riskLevel: "low",
    requiredInputs: [
      { key: "keyword", label: "关键词", description: "要跟踪的搜索词。", required: true, example: "wireless earbuds" },
      { key: "searchUrl", label: "搜索 URL 模板", description: "含占位符 {q} 的搜索地址。", required: true, example: "https://www.google.com/search?q={q}" },
      { key: "limit", label: "记录条数", description: "默认前 10 名。", required: false, example: "10" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["keyword_ranks 表存在", "写入 keyword/position/title/url/rank_date", "同一 (keyword,position) 当日不重复"],
    examplePrompt: "用 keyword-rank 模板跟踪关键词排名: wireless earbuds,搜索页 https://www.google.com/search?q={q}",
    prompt: "搜索关键词并记录结果排名,写入 keyword_ranks:keyword/position/title/url/rank_date。",
    outputTable: { name: "keyword_ranks", columns: ["keyword", "position", "title", "url", "rank_date"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS keyword_ranks (id INTEGER PRIMARY KEY, keyword TEXT, position INTEGER, title TEXT, url TEXT, rank_date TEXT)",
      "browser_navigate(searchUrl 替换 {q}) → browser_wait_for_load",
      "browser_evaluate: 提取前 N 名 [{position,title,url}]",
      "db_exec: 参数化 INSERT",
      "总结记录条数",
    ],
  },
  {
    id: "follower-growth",
    title: "社媒账号数据统计",
    category: "social",
    description: "抓取社媒主页的粉丝/关注/作品数等指标,写入 social_stats,用于增长追踪。",
    riskLevel: "low",
    requiredInputs: [
      { key: "profileUrl", label: "主页 URL", description: "社媒个人/品牌主页。", required: true, example: "https://www.tiktok.com/@brand" },
      { key: "platform", label: "平台", description: "TikTok/Instagram/Facebook/自定义。", required: true },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["social_stats 表存在", "写入 platform/handle/followers/following/posts/captured_at", "数值解析失败时写入 null 而非猜测"],
    examplePrompt: "用 follower-growth 模板抓取这个主页的数据: https://www.tiktok.com/@brand",
    prompt: "抓取社媒主页指标,写入 social_stats:platform/handle/followers/following/posts/captured_at。",
    outputTable: { name: "social_stats", columns: ["platform", "handle", "followers", "following", "posts", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS social_stats (id INTEGER PRIMARY KEY, platform TEXT, handle TEXT, followers INTEGER, following INTEGER, posts INTEGER, captured_at TEXT)",
      "browser_navigate 到主页 → browser_wait_for_load → browser_evaluate 提取数字指标",
      "db_exec: 参数化 INSERT",
      "总结抓取结果",
    ],
  },
  {
    id: "comment-watch",
    title: "评论监控",
    category: "social",
    description: "采集帖子/页面的新评论,写入 comments,便于舆情监控与及时回复。",
    riskLevel: "low",
    requiredInputs: [
      { key: "postUrl", label: "帖子/页面 URL", description: "要监控评论的页面。", required: true },
      { key: "platform", label: "平台", description: "TikTok/Instagram/Facebook/YouTube/自定义。", required: true },
      { key: "max", label: "条数上限", description: "默认 50。", required: false, example: "50" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["comments 表存在", "写入 platform/post_url/author/content/comment_url/captured_at", "同一 comment_url 不重复"],
    examplePrompt: "用 comment-watch 模板监控这个帖子的新评论: https://www.tiktok.com/@brand/video/123",
    prompt: "采集帖子下的评论,把新增评论写入 comments:platform/post_url/author/content/comment_url/captured_at。",
    outputTable: { name: "comments", columns: ["platform", "post_url", "author", "content", "comment_url", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, platform TEXT, post_url TEXT, author TEXT, content TEXT, comment_url TEXT UNIQUE, captured_at TEXT)",
      "browser_navigate 到帖子 → browser_wait_for_load → 滚动加载评论",
      "browser_evaluate: 提取评论数组",
      "db_exec: 参数化 INSERT,comment_url 重复跳过",
      "总结新增条数",
    ],
  },
  {
    id: "social-publish",
    title: "定时内容发布",
    category: "social",
    description: "把准备好的文案发布到社媒平台(需要用户审批),记录发布结果。",
    riskLevel: "high",
    requiredInputs: [
      { key: "platformUrl", label: "发布页 URL", description: "发布入口/编辑器页面。", required: true },
      { key: "content", label: "文案内容", description: "要发布的正文(可含主题标签)。", required: true },
      { key: "mediaPath", label: "媒体文件(可选)", description: "本地上传的图片/视频路径。", required: false },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_type", "browser_upload_file", "browser_click", "db_exec"],
    successCriteria: ["每次发布前触发用户审批并等待确认", "social_posts 表记录 platform/content/status/published_at", "发布失败时不重试发送同一内容超过一次"],
    examplePrompt: "用 social-publish 模板把这段文案发布到 https://www.tiktok.com/upload",
    prompt: "把指定文案发布到社媒平台;发布属于外部写入,必须先提示用户并等待审批。",
    outputTable: { name: "social_posts", columns: ["platform", "content", "status", "published_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS social_posts (id INTEGER PRIMARY KEY, platform TEXT, content TEXT, status TEXT, published_at TEXT)",
      "提示用户即将发布并等待审批通过",
      "browser_navigate 到发布页 → browser_wait_for_load → browser_type 输入文案(有媒体则 browser_upload_file)",
      "browser_click 发布按钮 → 确认成功",
      "db_exec: INSERT 发布记录",
    ],
  },
  {
    id: "ad-campaign-health",
    title: "广告活动健康巡检",
    category: "ads",
    description: "巡检广告后台各广告活动的状态/预算/消耗/投放,写入 ad_campaigns。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "adsUrl", label: "广告后台 URL", description: "广告活动列表/后台首页。", required: true },
      { key: "accounts", label: "账号/Profile 范围", description: "要巡检的账号范围。", required: true },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["ad_campaigns 表存在", "写入 platform/account/campaign/status/budget/spend/delivery/checked_at", "异常状态(预算耗尽/拒审)在总结中列出"],
    examplePrompt: "用 ad-campaign-health 模板巡检广告后台活动状态: https://ads.example/campaigns",
    prompt: "巡检广告活动状态与预算消耗,写入 ad_campaigns:platform/account/campaign/status/budget/spend/delivery/checked_at。",
    outputTable: { name: "ad_campaigns", columns: ["platform", "account", "campaign", "status", "budget", "spend", "delivery", "checked_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS ad_campaigns (id INTEGER PRIMARY KEY, platform TEXT, account TEXT, campaign TEXT, status TEXT, budget REAL, spend REAL, delivery TEXT, checked_at TEXT)",
      "browser_navigate 到广告后台 → browser_wait_for_load → browser_evaluate 提取活动列表 JSON",
      "db_exec: 参数化 INSERT",
      "单独列出预算耗尽/拒审/异常活动",
    ],
  },
  {
    id: "competitor-track",
    title: "竞品广告监控",
    category: "ads",
    description: "访问广告资料库/竞品主页,记录正在投放的广告,写入 competitor_ads。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "libraryUrl", label: "广告资料库/搜索 URL", description: "如 Meta Ad Library 或平台广告搜索页。", required: true, example: "https://www.facebook.com/ads/library/?q=brand" },
      { key: "brands", label: "竞品品牌", description: "要监控的品牌关键词,逗号分隔。", required: true },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["competitor_ads 表存在", "写入 brand/headline/cta/url/started_at/captured_at", "同一广告 url 不重复"],
    examplePrompt: "用 competitor-track 模板监控竞品广告: brand1, brand2",
    prompt: "在广告资料库搜索竞品品牌,记录投放中的广告,写入 competitor_ads:brand/headline/cta/url/started_at/captured_at。",
    outputTable: { name: "competitor_ads", columns: ["brand", "headline", "cta", "url", "started_at", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS competitor_ads (id INTEGER PRIMARY KEY, brand TEXT, headline TEXT, cta TEXT, url TEXT UNIQUE, started_at TEXT, captured_at TEXT)",
      "逐个品牌: browser_navigate 到资料库搜索 → browser_wait_for_load → browser_evaluate 提取广告列表",
      "db_exec: 参数化 INSERT,url 重复跳过",
      "总结各品牌广告数",
    ],
  },
  {
    id: "session-check",
    title: "批量会话巡检",
    category: "ops",
    description: "对一组 profile 批量检查登录会话是否有效/被风控,写入 session_health(配合批量 agent 任务)。",
    riskLevel: "medium",
    requiredInputs: [
      { key: "profiles", label: "Profile 范围", description: "要巡检的 profile 列表或 tags。", required: true, example: "tag:shop" },
      { key: "platformUrl", label: "登录后首页 URL", description: "用于判断登录态的页面。", required: true, example: "https://seller.example/home" },
    ],
    tools: ["list_profiles", "launch_profile", "browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["session_health 表存在", "每个 profile 一行,status 为 logged_in/challenge/logged_out/unknown", "不提交表单或改密码", "异常会话在总结中列出"],
    examplePrompt: "用 session-check 模板巡检 tag=shop 的 profile 登录状态,写入 session_health",
    prompt: "逐个 profile 打开登录后首页,判断会话状态,写入 session_health:profile/platform/status/checked_at。",
    outputTable: { name: "session_health", columns: ["profile", "platform", "status", "checked_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS session_health (id INTEGER PRIMARY KEY, profile TEXT, platform TEXT, status TEXT, checked_at TEXT)",
      "list_profiles 确定巡检范围,逐个 launch_profile(未运行则启动)",
      "browser_navigate 到登录后首页 → browser_wait_for_load → browser_evaluate 判断登录态",
      "db_exec: 参数化 INSERT",
      "列出需人工处理的会话",
    ],
  },
  {
    id: "screenshot-archive",
    title: "定时截图存档",
    category: "data",
    description: "按 URL 列表定时截图保存到本地,并记录文件路径到 screenshots 表。",
    riskLevel: "low",
    requiredInputs: [
      { key: "urls", label: "URL 列表", description: "要截图的页面,一行一个。", required: true },
      { key: "outputDir", label: "保存目录", description: "截图保存的绝对路径。", required: true, example: "~/Documents/screenshots" },
      { key: "profile", label: "Profile", description: "用于打开页面的 Browser profile。", required: true },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_screenshot", "write_file", "db_exec"],
    successCriteria: ["每页至少一张截图写入输出目录", "screenshots 表记录 url/file_path/captured_at", "总结成功/失败页"],
    examplePrompt: "用 screenshot-archive 模板给这些页面截图并存到 ~/Documents/screenshots: https://example.com",
    prompt: "对每个 URL 打开页面并截图保存到输出目录,记录到 screenshots:url/file_path/captured_at。",
    outputTable: { name: "screenshots", columns: ["url", "file_path", "captured_at"] },
    steps: [
      "db_exec: CREATE TABLE IF NOT EXISTS screenshots (id INTEGER PRIMARY KEY, url TEXT, file_path TEXT, captured_at TEXT)",
      "对每个 URL: browser_navigate → browser_wait_for_load → browser_screenshot 保存文件",
      "db_exec: 参数化 INSERT url/file_path",
      "总结截图数量与失败页",
    ],
  },
  {
    id: "table-extract",
    title: "结构化表格抽取",
    category: "data",
    description: "把页面上任意 HTML 表格/列表抽成结构化数据,写入用户指定的表。",
    riskLevel: "low",
    requiredInputs: [
      { key: "pageUrl", label: "页面 URL", description: "包含表格/列表的页面。", required: true },
      { key: "tableName", label: "目标表名", description: "写入的 SQLite 表名(小写+下划线)。", required: true, example: "products" },
      { key: "columns", label: "列名", description: "逗号分隔的列名列表。", required: true, example: "name, price, stock" },
    ],
    tools: ["browser_navigate", "browser_wait_for_load", "browser_evaluate", "db_exec"],
    successCriteria: ["目标表被创建且列名匹配", "每行数据对应表格一行", "不重复写入(可用 url+行号去重)", "总结抽取行数"],
    examplePrompt: "用 table-extract 模板抽取这个页面的表格到 products 表(name, price, stock): https://example.com/list",
    prompt: "把页面表格抽成结构化行,按用户指定列写入表:先建表,再逐行插入。",
    outputTable: { name: "extracted", columns: ["source_url", "row_no", "data_json"] },
    steps: [
      "确认列名与类型后 db_exec 建表(CREATE TABLE IF NOT EXISTS)",
      "browser_navigate → browser_wait_for_load → browser_evaluate 提取表格行数组",
      "db_exec: 参数化 INSERT(若含 source_url/row_no 可去重)",
      "总结抽取行数",
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
