// v2-app/js/core-config.js
// 职责：全局常量、1-9 键 JSON 字典、Firebase 初始化
// 依赖：firebase/app（CDN ESM）
// 导出：APP_CONFIG, KEY_MAP, STATUS_META, initFirebase, getFirebaseApp

// ── Firebase 配置（从环境注入，不硬编码敏感值）────────
// 部署时通过 Cloudflare Pages 环境变量注入，
// 本地开发时在项目根目录创建 env.js 并赋值 window.__ENV__
const ENV = (typeof window !== "undefined" && window.__ENV__) || {};

export const APP_CONFIG = Object.freeze({
  // Cloudflare Worker 代理入口（国内免翻墙）
  WORKER_URL: ENV.WORKER_URL || "https://api.yourdomain.com",

  // V1 GAS 接口（首月双写影子备份，过渡期结束后删除此行）
  GAS_V1_URL: ENV.GAS_V1_URL || "",

  // 双写过渡期开关：设为 false 即关闭影子写，下线前删除整个字段
  SHADOW_WRITE_ENABLED: ENV.SHADOW_WRITE_ENABLED !== "false",

  // 双盲核对横幅开关（首月显示，验收通过后设为 false）
  DUAL_BLIND_BANNER: ENV.DUAL_BLIND_BANNER !== "false",

  // Gemini 模型版本（由后端 Worker 读取，此处仅供前端展示）
  GEMINI_MODEL: "gemini-2.5-flash",

  // 请求超时（ms）
  REQUEST_TIMEOUT_MS: 15_000,

  // 影子写超时（ms，必须短于主链路，失败不影响用户）
  SHADOW_TIMEOUT_MS: 5_000,

  // Firebase 客户端配置（非敏感，可写入代码）
  FIREBASE: {
    apiKey:            ENV.FIREBASE_API_KEY            || "",
    authDomain:        ENV.FIREBASE_AUTH_DOMAIN        || "",
    projectId:         ENV.FIREBASE_PROJECT_ID         || "",
    storageBucket:     ENV.FIREBASE_STORAGE_BUCKET     || "",
    messagingSenderId: ENV.FIREBASE_MESSAGING_SENDER_ID || "",
    appId:             ENV.FIREBASE_APP_ID             || "",
  },
});

// ── 1-9 功能键 JSON 字典（铁律三核心）────────────────
// 每个键定义：id, label, icon, desc, action（被 feature-logic 调度）
export const KEY_MAP = Object.freeze([
  {
    id:     1,
    label:  "批量对账台",
    icon:   "M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7",
    desc:   "常规快速处理",
    action: "openBatchMatching",
  },
  {
    id:     2,
    label:  "按行排查",
    icon:   "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    desc:   "按行内容检查关联",
    action: "openRowCorrelation",
  },
  {
    id:     3,
    label:  "按凭证排查",
    icon:   "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
    desc:   "按凭证检查关联",
    action: "openVoucherCorrelation",
  },
  {
    id:     4,
    label:  "快捷记账",
    icon:   "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    desc:   "语音 / 文字录入",
    action: "openQuickEntry",
  },
  {
    id:     5,
    label:  "批量补录",
    icon:   "M4 6h16M4 10h16M4 14h16M4 18h16",
    desc:   "大段文字解析",
    action: "openBatchText",
  },
  {
    id:     6,
    label:  "双写监控",
    icon:   "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    desc:   "影子同步状态日志",
    action: "openShadowMonitor",  // 终端风格面板
  },
  {
    id:     7,
    label:  "去重凭证",
    icon:   "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
    desc:   "重复凭证查杀",
    action: "openDeduplication",
  },
  {
    id:     8,
    label:  "精准解绑",
    icon:   "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21",
    desc:   "精准解绑选中行",
    action: "openUnbind",
  },
  {
    id:     9,
    label:  "断案法庭",
    icon:   "M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3",
    desc:   "冲突凭证审理",
    action: "openConflictCourt",
  },
]);

// ── 凭证状态元数据（颜色、标签统一管理）─────────────
export const STATUS_META = Object.freeze({
  "智能关联": { color: "text-teal-600 dark:text-teal-400",  dot: "bg-teal-500",  label: "智能关联" },
  "人工关联": { color: "text-blue-600 dark:text-blue-400",  dot: "bg-blue-500",  label: "人工关联" },
  "待续关联": { color: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500", label: "🔖 待续" },
  "未关联":   { color: "text-gray-400 dark:text-gray-500",  dot: "bg-gray-400",  label: "未关联" },
  "多图合并": { color: "text-purple-600 dark:text-purple-400", dot: "bg-purple-500", label: "多图合并" },
});

// ── 分类 → emoji 映射（UI 渲染用）───────────────────
export const CATEGORY_ICON = Object.freeze({
  "餐饮": "🍜", "交通": "🚌", "购物": "🛒", "娱乐": "🎬",
  "医疗": "💊", "教育": "📚", "住房": "🏠", "水电气": "💡",
  "办公": "💼", "工资": "💰", "投资": "📈", "奖金": "🎁",
  "其他支出": "💸", "其他收入": "💹", "未分类": "📋",
});

// ── Firebase 初始化（单例）───────────────────────────
let _firebaseApp  = null;
let _firestoreDb  = null;
let _firebaseAuth = null;

/**
 * 初始化 Firebase（幂等，多次调用安全）
 * 依赖 CDN 加载的 firebase/app、firestore、auth ESM
 */
export async function initFirebase() {
  if (_firebaseApp) return { app: _firebaseApp, db: _firestoreDb, auth: _firebaseAuth };

  const { initializeApp }              = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const { getFirestore }               = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");

  _firebaseApp  = initializeApp(APP_CONFIG.FIREBASE);
  _firestoreDb  = getFirestore(_firebaseApp);
  _firebaseAuth = getAuth(_firebaseApp);

  return { app: _firebaseApp, db: _firestoreDb, auth: _firebaseAuth };
}

/**
 * 获取已初始化的 Firestore 实例（需先调用 initFirebase）
 */
export function getFirebaseApp() {
  return { app: _firebaseApp, db: _firestoreDb, auth: _firebaseAuth };
}
