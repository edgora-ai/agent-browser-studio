// Platform adapters — versioned, per-platform selector recipes so the agent
// doesn't reinvent DOM logic for FB/TikTok/Amazon/Shopee on every run (the
// scenario eval's P2 "platform adapter / skill pack"). Each adapter declares
// the domains it covers, a selector version (bump when the platform's DOM
// changes), and browser_evaluate expressions for login-check / metric collect.
// Adapters are data — the agent executes the expressions via browser_evaluate.
//
// The adapter list is also the "AI Skills Hub platform adapter catalog":
// every adapter carries hub metadata (category / target regions / linked
// business presets / pitch) and is surfaced through the renderer hub view,
// the local REST API, and the MCP tools so external AI can discover and pick
// the right recipe for the page it is on.

export interface PlatformAdapterRecipe {
  name: string;
  goal: string;
  steps: string[];
}

/** Hub metadata used to browse the adapter catalog like a skills marketplace. */
export interface PlatformAdapterHubInfo {
  /** Catalog grouping: social / ecommerce / ads / crypto / productivity / utility / generic. */
  category: string;
  /** Target regions / markets this adapter is curated for (ISO-ish labels). */
  regions: string[];
  /** Business preset ids (business-presets.ts) this adapter directly serves. */
  presets: string[];
  /** One-line pitch for the hub listing. */
  pitch: string;
}

export interface PlatformAdapter {
  id: string;
  name: string;
  /** Host substrings this adapter handles (lowercase). Empty = generic fallback. */
  domains: string[];
  /** Bump when the platform's DOM changes so stale recipes are detectable. */
  selectorVersion: number;
  /** Broad platform capabilities advertised to the agent. */
  capabilities: string[];
  /** URL hints for account/login health checks. */
  loginUrlHints: string[];
  /** Stable selectors grouped by purpose. */
  selectors: Record<string, string[]>;
  /** Reusable operational recipes; selectors are advisory and must be verified at runtime. */
  recipes: PlatformAdapterRecipe[];
  /** ISO date of last manual recipe/selector verification. */
  lastVerifiedAt: string;
  /** Operator-facing caveats for the agent prompt. */
  notes: string;
  /** A browser_evaluate expression returning { loggedIn: boolean, hint: string }. */
  loginCheck: string;
  /** Optional metric-collection expression returning a JSON object. */
  collectMetrics?: string;
  /** Hub catalog metadata (Skills Hub marketplace view). */
  hub: PlatformAdapterHubInfo;
}

export interface PlatformAdapterSummary {
  id: string;
  name: string;
  category: string;
  regions: string[];
  presets: string[];
  pitch: string;
  domains: string[];
  selectorVersion: number;
  capabilities: string[];
  loginUrlHints: string[];
  recipes: PlatformAdapterRecipe[];
  notes: string;
  lastVerifiedAt: string;
}

export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  {
    id: "generic-web",
    name: "通用网站",
    domains: [],
    selectorVersion: 1,
    capabilities: ["login-check", "snapshot", "generic-metrics"],
    loginUrlHints: [],
    selectors: {
      loginForm: ["input[type=password]", "form[action*=login i]"],
      logout: ["[href*=logout i]", "[href*=signout i]", "button[aria-label*=logout i]"],
    },
    recipes: [
      { name: "generic-login-check", goal: "判断页面是否可能已登录", steps: ["检测 password input", "检测 logout/signout 控件", "返回 loggedIn + hint,未知时保守标注 unknown"] },
    ],
    lastVerifiedAt: "2026-06-24",
    notes: "通用启发式只能做低置信度判断;对高风险操作必须让用户确认目标页面和字段。",
    loginCheck: "(function(){ var hasLogin = !!document.querySelector('input[type=password]'); var hasLogout = !!document.querySelector('[href*=logout i],[href*=signout i],button[aria-label*=logout i]'); return JSON.stringify({ loggedIn: hasLogout || !hasLogin, hint: hasLogout?'logout control seen':(hasLogin?'login form seen':'unknown') }); })()",
    hub: { category: "generic", regions: [], presets: [], pitch: "通用启发式登录态检查与页面快照兜底" },
  },
  {
    id: "amazon-seller",
    name: "Amazon Seller Central",
    domains: ["sellercentral.amazon", "sellercentral-europe.amazon"],
    selectorVersion: 2,
    capabilities: ["login-check", "account-health", "price-review", "order-summary"],
    loginUrlHints: ["https://sellercentral.amazon.com/home", "https://sellercentral-europe.amazon.com/home"],
    selectors: {
      loggedIn: ["#sc-masthead", "#ap-name a", "[data-testid=user-name]"],
      challenge: ["#auth-mfa-form", "#captchacharacters", "[id*=challenge]"],
      orders: ["[data-test-id*=order]", "#orders-dashboard"],
    },
    recipes: [
      { name: "seller-login-health", goal: "检查账号是否在线或遇到风控", steps: ["打开 Seller Central home", "运行 loginCheck", "若出现 challenge selector,记录 challenge", "写入 account_health"] },
      { name: "price-review", goal: "采集商品/报价摘要", steps: ["导航到指定商品或库存页面", "等待主要表格/卡片", "提取 SKU/price/currency", "参数化写入 prices"] },
    ],
    lastVerifiedAt: "2026-06-24",
    notes: "Amazon 页面地区差异明显;执行前优先使用 profile 的代理国家和店铺站点匹配。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('#auth-mfa-form,#captchacharacters,[id*=challenge]'); var loggedIn = !!document.querySelector('#sc-masthead, #ap-name a, [data-testid=user-name]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'challenge seen':(loggedIn?'seller header seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["US", "EU"], presets: ["amazon-seller-us"], pitch: "Amazon Seller Central 登录健康 / 订单 / 价格采集" },
  },
  {
    id: "shopee-seller",
    name: "Shopee Seller",
    domains: ["seller.shopee", "seller.th.shopee", "seller.ph.shopee"],
    selectorVersion: 2,
    capabilities: ["login-check", "account-health", "order-summary", "chat-presence"],
    loginUrlHints: ["https://seller.shopee.com/", "https://seller.shopee.ph/"],
    selectors: {
      loggedIn: [".shopee-minipage-header", "[class*=seller-account]", "[class*=navbar-user]"],
      challenge: ["[class*=captcha]", "[class*=verify]"],
      orders: ["[class*=order]", "[data-testid*=order]"],
    },
    recipes: [
      { name: "seller-login-health", goal: "判断 Shopee Seller 登录态", steps: ["打开 seller home", "运行 loginCheck", "记录 online/challenge/blocked/unknown"] },
      { name: "order-summary", goal: "提取订单状态数量", steps: ["导航到订单页", "等待订单状态元素", "提取状态/count", "写入 order_summary"] },
    ],
    lastVerifiedAt: "2026-06-24",
    notes: "Shopee 多地区域名和 UI 差异较大;selectors 只能作为候选,运行时需从 snapshot 验证。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[class*=captcha],[class*=verify]'); var loggedIn = !!document.querySelector('.shopee-minipage-header, [class*=seller-account], [class*=navbar-user]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'verification seen':(loggedIn?'seller header seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["SEA"], presets: [], pitch: "Shopee 卖家中心登录态 / 订单健康巡检" },
  },
  {
    id: "tiktok-shop",
    name: "TikTok Shop (Seller)",
    domains: ["seller.tiktokglobalshop", "seller-us.tiktok", "seller.tiktok"],
    selectorVersion: 2,
    capabilities: ["login-check", "account-health", "shop-metrics", "order-summary"],
    loginUrlHints: ["https://seller.tiktokglobalshop.com/", "https://seller-us.tiktok.com/"],
    selectors: {
      loggedIn: ["[data-e2e=avatar]", ".avatar-wrapper", "[class*=user-avatar]"],
      challenge: ["[class*=captcha]", "[id*=captcha]"],
      metrics: ["[data-e2e*=metric]", "[class*=dashboard]"],
    },
    recipes: [
      { name: "shop-health", goal: "检查 TikTok Shop 登录和基础指标", steps: ["打开 seller dashboard", "运行 loginCheck", "若在线再提取 dashboard metric 文本", "写入 account_health 或 shop_metrics"] },
    ],
    lastVerifiedAt: "2026-06-24",
    notes: "TikTok 防自动化较敏感;只读采集优先,不要自动提交设置变更。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[class*=captcha],[id*=captcha]'); var loggedIn = !!document.querySelector('[data-e2e=avatar], .avatar-wrapper, [class*=user-avatar]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'captcha seen':(loggedIn?'avatar seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["US", "SEA", "EU"], presets: ["tiktok-shop-us"], pitch: "TikTok Shop 卖家后台登录 / 店铺指标巡检" },
  },
  {
    id: "facebook",
    name: "Facebook",
    domains: ["facebook.com"],
    selectorVersion: 2,
    capabilities: ["login-check", "account-health", "page-insights-read"],
    loginUrlHints: ["https://www.facebook.com/", "https://business.facebook.com/"],
    selectors: {
      loggedIn: ["[role=navigation] [aria-label*=account i]", "[data-click=profile_photo]", '[aria-label*="Your profile" i]'],
      loginForm: ["input[name=email]", "input[name=pass]"],
      challenge: ["[id*=checkpoint]", "[action*=checkpoint]"],
    },
    recipes: [
      { name: "facebook-login-health", goal: "判断 Facebook 账号是否在线/检查点", steps: ["打开 facebook.com", "运行 loginCheck", "checkpoint 出现则标记 challenge", "写入 account_health"] },
    ],
    lastVerifiedAt: "2026-06-24",
    notes: "Facebook 选择器受语言和实验分组影响;登录态判断需结合 URL 和可见文本。",
    loginCheck: `(function(){ var challenge = !!document.querySelector('[id*=checkpoint],[action*=checkpoint]'); var loggedIn = !!document.querySelector('[role=navigation] [aria-label*=account i], [data-click=profile_photo], [aria-label*="Your profile" i]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'checkpoint seen':(loggedIn?'account nav seen':'login likely required') }); })()`,
    hub: { category: "social", regions: ["US", "EU", "Global"], presets: ["facebook-ads-us"], pitch: "Facebook 登录态 / 检查点风控巡检（个人号 + 商业号）" },
  },
  {
    id: "instagram",
    name: "Instagram",
    domains: ["instagram.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "profile-metrics"],
    loginUrlHints: ["https://www.instagram.com/", "https://www.instagram.com/accounts/activity"],
    selectors: {
      loggedIn: ["a[href*=accounts_center i]", "span._aacl", "svg[aria-label*=profile i]"],
      loginForm: ["input[name=username]", "input[type=password]"],
      challenge: ["[id=loginForm]", "[class*=captcha]", "input[name=verificationCode]"],
    },
    recipes: [
      { name: "instagram-login-health", goal: "判断 Instagram 账号是否在线或触发验证", steps: ["打开 instagram.com", "运行 loginCheck", "loginForm 出现标记 challenge", "写入 account_health"] },
      { name: "profile-metrics", goal: "采集个人主页基础指标", steps: ["导航到目标主页", "等待粉丝/关注/帖子数字", "提取 follower/following/posts", "写入 instagram_metrics"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "Instagram 桌面端近期大量引入 A/B 测试;登录态判断以 accounts_center 链接为准,避免误判。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[id=loginForm], input[name=verificationCode], [class*=captcha]'); var loggedIn = !!document.querySelector('a[href*=accounts_center i], span._aacl, svg[aria-label*=profile i]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'challenge seen':(loggedIn?'profile chrome seen':'login likely required') }); })()",
    hub: { category: "social", regions: ["US", "EU", "Global"], presets: ["instagram-matrix-us", "facebook-ads-us"], pitch: "Instagram 社媒矩阵登录健康 / 主页指标采集" },
  },
  {
    id: "google-ads",
    name: "Google Ads",
    domains: ["ads.google.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "campaign-health", "metrics-read"],
    loginUrlHints: ["https://ads.google.com/aw/overview", "https://ads.google.com/home/"],
    selectors: {
      loggedIn: [".accounts-list", "[data-standalone]", "material-dialog"],
      loginForm: ["#identifierId", "input[name=identifier]"],
      challenge: ["#gaia_loginform", "[id*=captcha]"],
    },
    recipes: [
      { name: "ads-login-health", goal: "判断 Google Ads 是否已登录", steps: ["打开 ads.google.com", "运行 loginCheck", "identifier/captcha 出现标记 challenge", "写入 account_health"] },
      { name: "campaign-health", goal: "读取账户/活动级基础状态", steps: ["导航到 overview", "等待 account selector", "提取 campaign/status 文本", "写入 ads_metrics"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "Google 登录有独立页;未登录时 ads.google.com 会重定向到 accounts.google.com,需用 loginUrlHints 导航。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('#gaia_loginform, [id*=captcha], #identifierId'); var loggedIn = !!document.querySelector('.accounts-list, [data-standalone], material-dialog'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'google login/captcha seen':(loggedIn?'ads account chrome seen':'login likely required') }); })()",
    hub: { category: "ads", regions: ["US", "EU", "Global"], presets: ["facebook-ads-us"], pitch: "Google Ads 账号登录健康 / 广告系列巡检" },
  },
  {
    id: "ebay",
    name: "eBay",
    domains: ["ebay.co.uk", "ebay.com", "ebay.de"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "order-summary", "listing-review"],
    loginUrlHints: ["https://www.ebay.co.uk/", "https://orders.ebay.co.uk/", "https://www.ebay.com/"],
    selectors: {
      loggedIn: ["#gh-uo", "[data-testid=user-menu]", "#gh-account"],
      loginForm: ["input[name=userid]", "input[type=password]"],
      challenge: ["[id*=captcha]", "#signIn"],
    },
    recipes: [
      { name: "ebay-login-health", goal: "判断 eBay 账号是否在线", steps: ["打开 ebay 首页", "运行 loginCheck", "signIn/captcha 出现标记 challenge", "写入 account_health"] },
      { name: "order-summary", goal: "提取待发货/销售订单概览", steps: ["导航到 seller hub", "等待订单表格", "提取 status/count", "写入 order_summary"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "eBay 地区站差异大;用 profile 代理国家选择匹配的地区站（uk/de）再采集。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[id*=captcha], #signIn'); var loggedIn = !!document.querySelector('#gh-uo, [data-testid=user-menu], #gh-account'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'signIn/captcha seen':(loggedIn?'account chrome seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["UK", "US", "DE"], presets: ["ebay-uk"], pitch: "eBay 卖家登录健康 / 订单与 listing 巡检" },
  },
  {
    id: "amazon-retail",
    name: "Amazon Retail",
    domains: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.sg"],
    selectorVersion: 1,
    capabilities: ["login-check", "order-summary", "product-review"],
    loginUrlHints: ["https://www.amazon.com/", "https://www.amazon.co.uk/", "https://www.amazon.de/"],
    selectors: {
      loggedIn: ["#nav-link-accountList", "[data-nav-ref=nav_youraccount]", "#nav-logo-sprites"],
      loginForm: ["input[name=email]", "input[name=password]"],
      challenge: ["#ap_password", "[id*=captcha]", "input[name=otpCode]"],
    },
    recipes: [
      { name: "amazon-login-health", goal: "判断 Amazon 买家号是否在线", steps: ["打开 amazon 首页", "运行 loginCheck", "password/otp/captcha 出现标记 challenge", "写入 account_health"] },
      { name: "order-summary", goal: "提取近期订单概览", steps: ["导航到 Your Orders", "等待订单列表", "提取 order/date/status", "写入 order_summary"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "Amazon 买家号与 Seller Central 不同;本适配器只处理买家/零售面,卖家面用 amazon-seller。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('#ap_password, [id*=captcha], input[name=otpCode]'); var loggedIn = !!document.querySelector('#nav-link-accountList, [data-nav-ref=nav_youraccount], #nav-logo-sprites'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'login/captcha seen':(loggedIn?'nav account seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["US", "UK", "DE", "SG"], presets: ["ecommerce-de"], pitch: "Amazon 零售买家号登录健康 / 订单概览" },
  },
  {
    id: "lazada",
    name: "Lazada (SEA)",
    domains: ["lazada.co.id", "lazada.com.ph", "lazada.sg", "lazada.com.my", "lazada.vn", "lazada.co.th"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "order-summary"],
    loginUrlHints: ["https://www.lazada.sg/", "https://www.lazada.com.ph/", "https://www.lazada.co.id/"],
    selectors: {
      loggedIn: ["[class*=my-account]", "[class*=login-stat]", "a[href*=felicita]"],
      loginForm: ["input[name=username]", "input[type=password]", "#container-login"],
      challenge: ["[class*=captcha]", "[id*=captcha]"],
    },
    recipes: [
      { name: "lazada-login-health", goal: "判断 Lazada 账号是否在线", steps: ["打开 lazada 地区站", "运行 loginCheck", "captcha/login 出现标记 challenge", "写入 account_health"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "Lazada 各地区站 DOM 共用度高但文案不同;选择器以类名为主。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[class*=captcha],[id*=captcha]'); var loggedIn = !!document.querySelector('[class*=my-account], [class*=login-stat], a[href*=felicita]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'captcha seen':(loggedIn?'account chrome seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["SEA"], presets: ["ecommerce-de"], pitch: "Lazada 东南亚站登录健康巡检" },
  },
  {
    id: "x-twitter",
    name: "X / Twitter",
    domains: ["x.com", "twitter.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "engagement-metrics"],
    loginUrlHints: ["https://x.com/home", "https://twitter.com/home"],
    selectors: {
      loggedIn: ["[data-testid=SideNav_AccountSwitcher_Button]", "[aria-label='Account menu']", "a[href*=notifications]"],
      loginForm: ["input[autocomplete=username]", "input[name=password]"],
      challenge: ["[data-testid=LoginForm]", "[id*=captcha]"],
    },
    recipes: [
      { name: "x-login-health", goal: "判断 X 账号是否在线", steps: ["打开 x.com/home", "运行 loginCheck", "LoginForm 出现标记 challenge", "写入 account_health"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "X 对脚本行为高度敏感;只读采集,避免高频动作触发 CF 挑战。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[data-testid=LoginForm],[id*=captcha]'); var loggedIn = !!document.querySelector('[data-testid=SideNav_AccountSwitcher_Button], [aria-label=\"Account menu\"], a[href*=notifications]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'login/captcha seen':(loggedIn?'nav account seen':'login likely required') }); })()",
    hub: { category: "social", regions: ["Global"], presets: [], pitch: "X / Twitter 账号登录健康与互动巡检" },
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    domains: ["linkedin.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "connection-metrics"],
    loginUrlHints: ["https://www.linkedin.com/feed/", "https://www.linkedin.com/mynetwork/"],
    selectors: {
      loggedIn: ["#global-nav", "a[href*=mynetwork]", "[class*=global-nav]"],
      loginForm: ["input[name=session_key]", "input[name=session_password]"],
      challenge: ["[id*=captcha]", "form.login"],
    },
    recipes: [
      { name: "linkedin-login-health", goal: "判断 LinkedIn 账号是否在线", steps: ["打开 linkedin.com", "运行 loginCheck", "login form 出现标记 challenge", "写入 account_health"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "LinkedIn 风控随操作频率提升;先只做登录健康,不自动大规模添加连接。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[id*=captcha], form.login'); var loggedIn = !!document.querySelector('#global-nav, a[href*=mynetwork], [class*=global-nav]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'login/captcha seen':(loggedIn?'global nav seen':'login likely required') }); })()",
    hub: { category: "social", regions: ["Global"], presets: [], pitch: "LinkedIn 账号登录健康巡检" },
  },
  {
    id: "youtube",
    name: "YouTube",
    domains: ["youtube.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "channel-metrics"],
    loginUrlHints: ["https://www.youtube.com/", "https://studio.youtube.com/"],
    selectors: {
      loggedIn: ["yt-img-shadow#avatar", "#avatar-btn", "#account-button"],
      loginForm: ["input[name=identifier]", "input[type=password]"],
      challenge: ["#identifier-captcha-captcha-container", "[id*=captcha]"],
    },
    recipes: [
      { name: "youtube-login-health", goal: "判断 YouTube 账号是否在线", steps: ["打开 youtube.com", "运行 loginCheck", "captcha/identifier 出现标记 challenge", "写入 account_health"] },
      { name: "studio-channel-health", goal: "读取 YouTube Studio 频道概览", steps: ["导航到 studio.youtube.com", "等待 channel 概览", "提取 views/subs/revenue-ish", "写入 channel_metrics"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "YouTube Studio 与主站登录态一致;采集受版权/隐私限制,只读为主。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('#identifier-captcha-captcha-container, [id*=captcha], input[name=identifier]'); var loggedIn = !!document.querySelector('yt-img-shadow#avatar, #avatar-btn, #account-button'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'google login/captcha seen':(loggedIn?'avatar seen':'login likely required') }); })()",
    hub: { category: "social", regions: ["Global"], presets: [], pitch: "YouTube / Studio 频道登录健康与指标巡检" },
  },
  {
    id: "crypto-exchange",
    name: "Crypto Exchanges (SG/Global)",
    domains: ["binance.com", "okx.com", "coinbase.com", "bybit.com", "htx.com", "kraken.com"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "balances-read"],
    loginUrlHints: ["https://www.binance.com/", "https://www.okx.com/", "https://www.coinbase.com/"],
    selectors: {
      loggedIn: ["[class*=profile-button]", "[class*=user-menu]", "[data-testid=account-avatar]", "button[aria-label*=account i]"],
      loginForm: ["input[name=username]", "input[name=email]", "input[type=password]"],
      challenge: ["[class*=captcha]", "[id*=captcha]", "input[name=otp]", "input[autocomplete=one-time-code]"],
    },
    recipes: [
      { name: "exchange-login-health", goal: "判断交易所账号是否在线/需要 2FA", steps: ["打开交易所首页", "运行 loginCheck", "otp/captcha 出现标记 challenge", "写入 account_health"] },
      { name: "balances-read", goal: "只读读取各币种余额", steps: ["导航到资产页", "等待资产表格", "提取 coin/balance", "写入 crypto_balances"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "交易所页面高度动态且各站差异极大;2FA 必须人工介入,适配器只做只读健康与余额采集。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[class*=captcha],[id*=captcha],input[name=otp],input[autocomplete=one-time-code]'); var loggedIn = !!document.querySelector('[class*=profile-button], [class*=user-menu], [data-testid=account-avatar], button[aria-label*=account i]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'otp/captcha seen':(loggedIn?'account chrome seen':'login likely required') }); })()",
    hub: { category: "crypto", regions: ["SG", "Global"], presets: ["crypto-sg"], pitch: "加密交易所登录健康 / 余额只读巡检（含 2FA 感知）" },
  },
  {
    id: "eu-marketplace",
    name: "EU Marketplaces (DE-oriented)",
    domains: ["otto.de", "zalando.de", "aboutyou.de", "mediamarkt.de", "saturn.de"],
    selectorVersion: 1,
    capabilities: ["login-check", "account-health", "order-summary"],
    loginUrlHints: ["https://www.otto.de/", "https://www.zalando.de/", "https://www.mediamarkt.de/"],
    selectors: {
      loggedIn: ["[data-testid*=account]", "[class*=account]", "a[href*='/me/']", "a[href*=konto]"],
      loginForm: ["input[type=email]", "input[type=password]", "input[name=password]"],
      challenge: ["[class*=captcha]", "[id*=captcha]", "[class*=verify]"],
    },
    recipes: [
      { name: "eu-login-health", goal: "判断欧盟电商账号是否在线", steps: ["打开站点首页", "运行 loginCheck", "captcha/login 出现标记 challenge", "写入 account_health"] },
    ],
    lastVerifiedAt: "2026-08-16",
    notes: "欧盟站点语言以德语为主;选择器以语义类名为准,文案匹配需带 de 大小写。",
    loginCheck: "(function(){ var challenge = !!document.querySelector('[class*=captcha],[id*=captcha],[class*=verify]'); var loggedIn = !!document.querySelector('[data-testid*=account], [class*=account], a[href*=konto]'); return JSON.stringify({ loggedIn: loggedIn && !challenge, hint: challenge?'captcha/verify seen':(loggedIn?'account link seen':'login likely required') }); })()",
    hub: { category: "ecommerce", regions: ["DE", "EU"], presets: ["ecommerce-de"], pitch: "德国/欧盟电商通用登录健康巡检" },
  },
];

/** Match an adapter for a URL; falls back to the generic adapter. */
export function detectAdapter(url: string): PlatformAdapter {
  const u = String(url || "").toLowerCase();
  for (const a of PLATFORM_ADAPTERS) {
    if (a.id === "generic-web") continue;
    if (a.domains.some((d) => u.includes(d))) return a;
  }
  return PLATFORM_ADAPTERS.find((a) => a.id === "generic-web")!;
}

export function getAdapter(id: string): PlatformAdapter | undefined {
  return PLATFORM_ADAPTERS.find((a) => a.id === id);
}

/** Render the adapter catalog for the agent system prompt. */
export function renderAdapterCatalog(): string {
  const lines = PLATFORM_ADAPTERS.filter((a) => a.id !== "generic-web").map((a) => {
    const selectorSummary = Object.entries(a.selectors)
      .map(([key, values]) => `${key}=${values.slice(0, 3).join(" | ")}`)
      .join("; ");
    const recipeSummary = a.recipes
      .map((recipe) => `${recipe.name}:${recipe.steps.join(" -> ")}`)
      .join("; ");
    return `- 【${a.id}】${a.name} (domains:${a.domains.join(", ")}; category:${a.hub.category}; regions:${a.hub.regions.join("/")}; presets:${a.hub.presets.join("/") || "n/a"}; selectorVersion:v${a.selectorVersion}; capabilities:${a.capabilities.join("/")}; verified:${a.lastVerifiedAt}) loginUrlHints:${a.loginUrlHints.join(", ") || "n/a"} selectors:${selectorSummary} loginCheck:${a.loginCheck} recipes:${recipeSummary} notes:${a.notes}`;
  });
  return [
    "## 平台适配器(versioned selector recipes + Skills Hub catalog)",
    "检查登录态/采集数据时,先从当前 URL 在下方 catalog 中匹配 domains,再复制对应 loginCheck/selectors/recipes 到 browser_evaluate/browser_* 调用中,并在运行时验证 selector 是否仍存在。selectorVersion 变化说明平台改版,需更新。catalog 可通过 agent_browser_platform_adapters_list / agent_browser_platform_adapter_get 查询。",
    "",
    ...lines,
    "",
    "调用方式: 根据当前 URL 命中 domains 后,用 browser_evaluate(port, <该行 loginCheck>) → JSON.parse 结果判断 {loggedIn, hint}; selectors/recipes 给出只读采集步骤。未知平台用 generic-web 启发式。",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════
// Skills Hub catalog surface — list/get as lean summaries
// (the raw loginCheck/selectors are kept in the full detail).
// ═══════════════════════════════════════════════════════════

function toSummary(a: PlatformAdapter): PlatformAdapterSummary {
  return {
    id: a.id,
    name: a.name,
    category: a.hub.category,
    regions: [...a.hub.regions],
    presets: [...a.hub.presets],
    pitch: a.hub.pitch,
    domains: [...a.domains],
    selectorVersion: a.selectorVersion,
    capabilities: [...a.capabilities],
    loginUrlHints: [...a.loginUrlHints],
    recipes: a.recipes.map((r) => ({ ...r })),
    notes: a.notes,
    lastVerifiedAt: a.lastVerifiedAt,
  };
}

const CATEGORY_ORDER = ["ecommerce", "social", "ads", "crypto", "productivity", "utility", "generic"];

/** List the hub adapter catalog as lean summaries, optionally filtered. */
export function listPlatformAdapters(filter?: string): PlatformAdapterSummary[] {
  const normalized = String(filter || "").trim().toLowerCase();
  const all = PLATFORM_ADAPTERS.map(toSummary);
  const filtered = normalized
    ? all.filter((a) =>
        [a.id, a.name, a.category, a.pitch, ...a.regions, ...a.presets, ...a.capabilities, ...a.domains]
          .some((v) => String(v || "").toLowerCase().includes(normalized)),
      )
    : all;
  return filtered.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return (ca === -1 ? 999 : ca) - (cb === -1 ? 999 : cb);
    return a.name.localeCompare(b.name);
  });
}

/** Get one full adapter (with loginCheck + selectors) or undefined. */
export function getPlatformAdapter(id: string): PlatformAdapter | undefined {
  return getAdapter(id);
}