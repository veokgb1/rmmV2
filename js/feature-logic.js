// v2-app/js/feature-logic.js
// 职责：核心业务逻辑"-9 键响应、AI 调度、应用状态流"
// 依赖：js/core-config.js, js/api-bridge.js, js/ui-layout.js, js/match-engine.js
// 导出：initApp

import { APP_CONFIG, KEY_MAP, getFirebaseApp } from "./core-config.js";
import {
  submitTransaction, updateTransaction, fetchLedger,
  deleteTransaction, unbindVouchers,
  geminiOCR, geminiNLP, uploadVoucher,
  fetchPendingVouchers, fetchTempTransactions,
  promoteTempTransaction, relinkVoucherToTransaction, markVoucherDifficultyDone,
  fetchShadowLogs,
  loginUser, logoutUser, onAuthChange,
}                                         from "./api-bridge.js";
import {
  getStorage, ref, getDownloadURL,
}                                         from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import {
  showLoginScreen, showAppShell, renderLedger,
  renderCalendar, renderStats, renderShadowMonitor,
  openDrawer, closeDrawer,
  showShadowMonitor, closeShadowMonitor,
  showToast, setLoadingState,
}                                         from "./ui-layout.js";
import {
  findBestMatch,
  findDuplicateCandidates,
  findDuplicatePairs,
  findRankedMatches,
}                                         from "./match-engine.js";

// ── 应用状"──────────────────────────────────────────
const state = {
  user:         null,
  transactions: [],
  currentYear:  new Date().getFullYear(),
  currentMonth: new Date().getMonth(),  // 0-indexed
  activeTab:    "flow",
  isLoading:    false,
};

const FALLBACK_IMAGE_URL = "/fallback.png";

function getFormalTransactions(transactions = state.transactions) {
  return (Array.isArray(transactions) ? transactions : [])
    .filter((tx) => tx?.recordBucket !== "temp");
}

function buildAuditNote(existing, message) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${String(message || "").trim()}`;
  return String(existing || "").trim()
    ? `${String(existing || "").trim()}\n${entry}`
    : entry;
}

function formatReviewTime(value) {
  const raw = normalizeDateStr(value);
  if (!value) return "--";
  if (typeof value === "object" && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return raw;
}

const DIFFICULTY_DONE_MARKER = "difficulty_center_done";
const DEDUPE_MANUAL_RESOLVE_REASON = "dedupe_promotion_manual_resolve";
const SETTINGS_STORAGE_KEYS = Object.freeze({
  dedupePromotionStrategy: "rmm.v2.dedupePromotionStrategy",
});
const DEDUPE_DONE_REASON_OPTIONS = Object.freeze([
  "user_confirmed_duplicate",
  "manual_keep_both",
  "false_positive",
  "other",
]);
const DEDUPE_DONE_REASON_LABELS = Object.freeze({
  user_confirmed_duplicate: "User confirmed duplicate",
  manual_keep_both: "Manually keep both records",
  false_positive: "False positive",
  other: "Other (requires note)",
});
// Session-only memory for global investigation center (cleared on page refresh).
let globalCenterSessionMemory = null;

function normalizeDedupePromotionStrategy(value) {
  return value === "manual_resolve" ? "manual_resolve" : "strict";
}

function readStoredDedupePromotionStrategy() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEYS.dedupePromotionStrategy);
    if (!raw) return null;
    return normalizeDedupePromotionStrategy(raw);
  } catch {
    return null;
  }
}

function writeStoredDedupePromotionStrategy(value) {
  const normalized = normalizeDedupePromotionStrategy(value);
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(SETTINGS_STORAGE_KEYS.dedupePromotionStrategy, normalized);
    }
  } catch {
    // ignore storage write failures and continue with in-memory behavior
  }
  return normalized;
}

function getDedupePromotionStrategy() {
  const stored = readStoredDedupePromotionStrategy();
  if (stored) return stored;
  return normalizeDedupePromotionStrategy(APP_CONFIG.DEDUPE_PROMOTION_STRATEGY);
}

function getDedupePromotionStrategyLabel(value) {
  return normalizeDedupePromotionStrategy(value) === "manual_resolve"
    ? "manual_resolve (continue promote = manually resolved)"
    : "strict (continue promote keeps dedupe difficulty item)";
}

function getDedupeDoneReasonLabel(value) {
  return DEDUPE_DONE_REASON_LABELS[value] || DEDUPE_DONE_REASON_LABELS.other;
}

function isDifficultyDismissed(record) {
  if (record?.difficultyState === "done") return true;
  return String(record?.decisionNote || "").includes(DIFFICULTY_DONE_MARKER);
}

function isManualResolvedDedupe(record) {
  if (!record) return false;
  return record.difficultyState === "done"
    && record.difficultyDoneReason === DEDUPE_MANUAL_RESOLVE_REASON;
}

function summarizeMatchReasons(reasons = []) {
  const set = new Set(Array.isArray(reasons) ? reasons : []);
  if (set.has("exact_amount") && set.has("near_day") && !set.has("same_day")) {
    return "Amount matches but date has offset";
  }
  if (set.has("same_summary") && !set.has("exact_amount")) {
    return "Summary is similar but amount differs";
  }
  if (set.has("summary_overlap") && set.has("close_amount")) {
    return "Summary overlaps and amount is close; manual review needed";
  }
  if (!set.size) return "Insufficient information for auto confirmation";
  return "Candidate scores are close; manual review needed";
}

function summarizeDuplicateReasons(reasons = [], score = 0) {
  const set = new Set(Array.isArray(reasons) ? reasons : []);
  if (set.has("exact_amount_same_day") && set.has("same_summary")) {
    return "High duplicate risk: amount, date and summary are highly similar";
  }
  if (set.has("exact_amount") && !set.has("exact_amount_same_day")) {
    return "Amount matches but date differs";
  }
  if (set.has("same_summary") && !set.has("exact_amount") && !set.has("exact_amount_same_day")) {
    return "Summary is similar but amount differs";
  }
  if (set.size <= 1 && score < 100) {
    return "Insufficient information for auto confirmation";
  }
  return "Candidate scores are close; manual review needed";
}

function describePendingReason(record) {
  const pendingReason = String(record?.pendingReason || "");
  if (!pendingReason) return "Insufficient information for auto confirmation";
  if (pendingReason.includes("manual_unbind")) {
    return "Voucher was unbound and returned to pending-link pool";
  }
  if (pendingReason.includes("ocr")) {
    return "Voucher/OCR information is incomplete";
  }
  return "Matching information is insufficient; manual decision required";
}

function describeTempReason(record) {
  const pendingReason = String(record?.pendingReason || "");
  if (pendingReason.includes("temp_capture")) {
    return "Temp record has not been promoted yet";
  }
  return "Temp record pending manual decision";
}

function buildDifficultyReason(record) {
  if (!record) return "Insufficient information for auto confirmation";
  if (record.kind === "voucher") {
    return describePendingReason(record);
  }
  if (record.kind === "temp") {
    return describeTempReason(record);
  }
  if (record.kind === "dedupe") {
    return summarizeDuplicateReasons(record.reasons, record.score || 0);
  }
  return "Insufficient information for auto confirmation";
}

function normalizeDifficultySearchKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

function buildDifficultySearchIndex(record) {
  if (!record) return "";

  if (record.kind === "voucher") {
    return [
      record.id,
      record.storagePath,
      record.legacyDriveId,
      getVoucherLabel(record.storagePath || record.legacyDriveId || record.id),
      record.summary,
      record.merchant,
      record.pendingReason,
      record.decisionNote,
      record.amount,
      normalizeDateStr(record.date),
    ]
      .map((item) => String(item || ""))
      .join(" ")
      .toLowerCase();
  }

  if (record.kind === "temp") {
    return [
      record.id,
      record.summary,
      record.category,
      record.source,
      record.pendingReason,
      record.decisionNote,
      record.amount,
      normalizeDateStr(record.date),
    ]
      .map((item) => String(item || ""))
      .join(" ")
      .toLowerCase();
  }

  if (record.kind === "dedupe") {
    const left = record.left || {};
    const right = record.right || {};
    return [
      left.id,
      right.id,
      left.summary,
      right.summary,
      left.category,
      right.category,
      left.source,
      right.source,
      left.amount,
      right.amount,
      normalizeDateStr(left.date),
      normalizeDateStr(right.date),
      ...(Array.isArray(record.reasons) ? record.reasons : []),
      summarizeDuplicateReasons(record.reasons, record.score || 0),
    ]
      .map((item) => String(item || ""))
      .join(" ")
      .toLowerCase();
  }

  return "";
}

function matchesDifficultySearch(record, searchKeyword) {
  const keyword = normalizeDifficultySearchKeyword(searchKeyword);
  if (!keyword) return true;
  return buildDifficultySearchIndex(record).includes(keyword);
}

function getDifficultyMeta(record) {
  if (!record || isDifficultyDismissed(record)) return null;

  if (record.kind === "voucher") {
    if (record.lifecycleState !== "pending_link") return null;
    return {
      filterKey: "matching",
      sourceType: "matching",
      statusText: record.lifecycleState || "pending_link",
      reasonText: buildDifficultyReason(record),
      updatedAt: record.latestAt || record.lastReviewedAt || record.updatedAt || null,
    };
  }

  if (record.kind === "temp") {
    if (record.recordBucket !== "temp") return null;
    return {
      filterKey: "temp",
      sourceType: "temp",
      statusText: record.recordBucket,
      reasonText: buildDifficultyReason(record),
      updatedAt: record.lastReviewedAt || record.updatedAt || record.createdAt || null,
    };
  }

  if (record.kind === "dedupe") {
    const leftManualResolved = isManualResolvedDedupe(record.left);
    const rightManualResolved = isManualResolvedDedupe(record.right);
    if (leftManualResolved || rightManualResolved) return null;

    const leftDismissed = isDifficultyDismissed(record.left);
    const rightDismissed = isDifficultyDismissed(record.right);
    if (leftDismissed && rightDismissed) return null;
    return {
      filterKey: "dedupe",
      sourceType: "dedupe",
      statusText: record.level === "high" ? "high" : "medium",
      reasonText: buildDifficultyReason(record),
      updatedAt: record.updatedAt || record.left?.lastReviewedAt || record.right?.lastReviewedAt || record.left?.updatedAt || record.right?.updatedAt || null,
    };
  }

  return null;
}

function isDifficult(record) {
  return Boolean(getDifficultyMeta(record));
}

// ── 入口：初始化整个应用 ──────────────────────────────

/**
 * 应用初始化（index.html "type="module" 调用"
 */
export async function initApp() {
  // 监听 Firebase Auth 状"
  const unsubscribe = await onAuthChange(async (user) => {
    if (user) {
      state.user = user;
      showAppShell();
      bindShellEvents();
      await loadAndRender();
    } else {
      state.user = null;
      showLoginScreen(async (email, password) => {
        await loginUser({ email, password });
        // onAuthChange 会自动触发上面的 user 分支
      });
    }
  });

  // 离开页面时取消监"
  window.addEventListener("beforeunload", unsubscribe);
}

// ── App Shell 事件绑定（登录后执行一次）──────────────

function bindShellEvents() {
  // Tab 切换
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // FAB 唤起抽屉
  document.getElementById("fab-add")?.addEventListener("click", () => {
    openDrawer(handleKeyAction);
  });

  // 底部导航（目前仅 ledger 有内容）
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.dataset.nav;
      activateBottomNav(nav);
      if (nav === "ledger") switchTab("flow");
      if (nav === "dashboard") switchTab("stats");
      if (nav === "search") switchTab("cal");
      if (nav === "settings") {
        switchTab("settings");
      }
    });
  });

  // 双盲横幅：查看对比按"
  document.getElementById("banner-compare-btn")?.addEventListener("click", () => {
    showToast("双盲核对：点击任意账目卡片可对比新旧凭证图片", "info", 4000);
  });

  // 月份切换
  document.getElementById("month-picker")?.addEventListener("click", openMonthPickerPanel);

  // 日历上下月按钮（动态渲染后绑定"
  document.getElementById("pane-cal")?.addEventListener("click", (e) => {
    if (e.target.closest("#cal-prev")) navigateMonth(-1);
    if (e.target.closest("#cal-next")) navigateMonth(1);
  });
}

// ── Tab 切换 ──────────────────────────────────────────

function switchTab(tabName) {
  state.activeTab = tabName;
  if (tabName === "flow") activateBottomNav("ledger");
  if (tabName === "stats") activateBottomNav("dashboard");
  if (tabName === "cal") activateBottomNav("search");
  if (tabName === "settings") activateBottomNav("settings");

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle("border-purple-500",    active);
    btn.classList.toggle("text-purple-600",      active);
    btn.classList.toggle("dark:text-purple-400", active);
    btn.classList.toggle("font-medium",          active);
    btn.classList.toggle("border-transparent",   !active);
    btn.classList.toggle("text-gray-400",        !active);
  });

  document.querySelectorAll(".pane").forEach((pane) => {
    pane.classList.toggle("hidden", !pane.id.endsWith(tabName));
  });

  if (tabName === "cal") {
    renderCalendar(getFormalTransactions(), {
      year:  state.currentYear,
      month: state.currentMonth,
    }, () => {});
  }
  if (tabName === "stats") {
    renderStats(getFormalTransactions());
  }
  if (tabName === "settings") {
    renderSettingsPane();
  }
}

function activateBottomNav(navName) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.remove("text-purple-600", "dark:text-purple-400");
    b.classList.add("text-gray-400");
    const isActive = b.dataset.nav === navName;
    if (isActive) {
      b.classList.remove("text-gray-400");
      b.classList.add("text-purple-600", "dark:text-purple-400");
    }
  });
}
function renderSettingsPane() {
  const pane = document.getElementById("pane-settings");
  if (!pane) return;

  const currentStrategy = getDedupePromotionStrategy();
  pane.innerHTML = `
    <section class="space-y-3">
      <div class="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 p-3">
        <h3 class="text-sm font-medium text-gray-800 dark:text-gray-100">ȥ��ת������</h3>
        <p class="text-xs text-gray-400 mt-1">���� temp -> formal �ڡ�����ת���������Ϊ��Ĭ�� strict�����־ɼ����߼���</p>
        <div class="mt-3">
          <label for="settings-dedupe-strategy" class="text-[11px] text-gray-500 block mb-1">����ѡ��</label>
          <select id="settings-dedupe-strategy"
            class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200">
            <option value="strict">strict</option>
            <option value="manual_resolve">manual_resolve</option>
          </select>
          <p id="settings-dedupe-strategy-current" class="text-[11px] text-gray-500 mt-2"></p>
        </div>
      </div>
    </section>`;

  const select = pane.querySelector("#settings-dedupe-strategy");
  const currentHint = pane.querySelector("#settings-dedupe-strategy-current");
  if (!select || !currentHint) return;

  select.value = currentStrategy;
  currentHint.textContent = `��ǰ��${getDedupePromotionStrategyLabel(currentStrategy)}`;

  select.addEventListener("change", () => {
    const strategy = writeStoredDedupePromotionStrategy(select.value);
    currentHint.textContent = `��ǰ��${getDedupePromotionStrategyLabel(strategy)}`;
    showToast(`ȥ��ת���������л�Ϊ ${strategy}`, "success");
  });
}

// ── 数据加载与渲"────────────────────────────────────

async function loadAndRender() {
  if (state.isLoading) return;
  state.isLoading = true;
  setLoadingState(true);

  try {
    const monthStr = `${state.currentYear}-${String(state.currentMonth + 1).padStart(2, "0")}`;
    state.transactions = await fetchLedger({ month: monthStr, limit: 200 });
    renderLedger(getFormalTransactions(), handleTxClick);
    updateMonthLabel();
  } catch (err) {
    showToast(`?????${err.message}`, "error");
    state.transactions = [];
    renderLedger(getFormalTransactions(), handleTxClick);
    updateMonthLabel();
  } finally {
    state.isLoading = false;
    setLoadingState(false);
  }
}

function updateMonthLabel() {
  const el = document.getElementById("current-month-label");
  if (el) el.textContent = `${state.currentYear}"{state.currentMonth + 1}月`;
  if (el) el.textContent = `${state.currentYear}"{state.currentMonth + 1}月`;
}

// ── 月份导航 ──────────────────────────────────────────

function navigateMonth(delta) {
  let m = state.currentMonth + delta;
  let y = state.currentYear;
  if (m > 11) { m = 0;  y++; }
  if (m < 0)  { m = 11; y--; }
  state.currentMonth = m;
  state.currentYear  = y;
  loadAndRender();
}

function showMonthPicker() {
  openMonthPickerPanel();
  return;
  // ?? prompt???????????????
  const input = prompt(
    "??????????? YYYY-MM???=????",
    `${state.currentYear}-${String(state.currentMonth + 1).padStart(2, "0")}`
  );
  if (!input) return;
  const match = input.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) { showToast("格式错误，请输入 YYYY-MM", "error"); return; }
  state.currentYear  = parseInt(match[1]);
  state.currentMonth = parseInt(match[2]) - 1;
  loadAndRender();
}

// ── 账目卡片点击 ──────────────────────────────────────

function openMonthPickerPanel() {
  const appRoot = document.getElementById("app-root");
  if (!appRoot) return;

  const overlay = document.createElement("div");
  overlay.className = "absolute inset-0 bg-black/45 z-40 flex items-center justify-center px-4 py-6";

  const panel = document.createElement("div");
  panel.className = "w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 shadow-xl";
  overlay.appendChild(panel);

  let pickerYear = state.currentYear;

  function monthBtnClass(isActive) {
    return isActive
      ? "bg-purple-600 text-white border-purple-600"
      : "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-purple-400";
  }

  function renderPicker() {
    const monthButtons = Array.from({ length: 12 }, (_, idx) => {
      const isActive = pickerYear === state.currentYear && idx === state.currentMonth;
      return `
        <button data-month="${idx}"
          class="h-10 rounded-xl border text-sm font-medium transition-colors ${monthBtnClass(isActive)}">
          ${idx + 1}"
        </button>`;
    }).join("");

    panel.innerHTML = `
      <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center justify-between">
          <button data-year-nav="-1"
            class="h-8 w-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            "
          </button>
          <span class="text-sm font-medium text-gray-900 dark:text-gray-100">${pickerYear}"/span>
          <button data-year-nav="1"
            class="h-8 w-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            "
          </button>
        </div>
      </div>
      <div class="p-4 grid grid-cols-3 sm:grid-cols-4 gap-2">
        ${monthButtons}
      </div>
      <div class="px-4 pb-4">
        <button data-close
          class="w-full h-10 rounded-xl border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
          取消
        </button>
      </div>`;

    panel.querySelectorAll("[data-year-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        pickerYear += parseInt(btn.dataset.yearNav, 10);
        renderPicker();
      });
    });

    panel.querySelectorAll("[data-month]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.currentYear = pickerYear;
        state.currentMonth = parseInt(btn.dataset.month, 10);
        overlay.remove();
        updateMonthLabel();
        loadAndRender();
      });
    });

    panel.querySelector("[data-close]")?.addEventListener("click", () => {
      overlay.remove();
    });
  }

  renderPicker();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  appRoot.appendChild(overlay);
}

async function resolveImageUrl(path) {
  try {
    if (Array.isArray(path)) path = path[0];
    console.log("图片路径:", path);
    if (!path || typeof path !== "string") return null;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      console.log("解析后URL:", path);
      return path;
    }

    const { app } = getFirebaseApp();
    if (!app) {
      console.error("getDownloadURL失败: Firebase app 未初始化", path);
      return null;
    }
    const storage = getStorage(app);
    const url = await getDownloadURL(ref(storage, path));
    console.log("解析后URL:", url);
    return url;
  } catch (err) {
    console.error("getDownloadURL失败:", path, err);
    return null;
  }
}

function extractImagePath(item) {
  if (!item) return null;
  if (typeof item === "string") return item;
  if (Array.isArray(item.images) && item.images.length > 0) return item.images[0];
  if (typeof item.image === "string") return item.image;
  return null;
}

let imageViewerScale = 1;

function ensureImageViewer() {
  let viewer = document.getElementById("imgViewer");
  if (viewer) return viewer;

  viewer = document.createElement("div");
  viewer.id = "imgViewer";
  viewer.className = "fixed inset-0 bg-black/95 hidden flex flex-col z-50";
  viewer.innerHTML = `
    <div class="flex-1 flex items-center justify-center overflow-hidden">
      <img id="viewerImg" class="max-w-full max-h-full object-contain transition-transform duration-200" />
    </div>
    <div class="h-24 bg-black/80 flex flex-col items-center justify-center gap-3">
      <input id="zoomSlider" type="range" min="1" max="4" step="0.1" value="1"
        class="w-2/3 accent-blue-500" />
      <div class="flex gap-6">
        <button id="zoomOut" class="w-12 h-12 rounded-full bg-white text-black text-xl shadow">-</button>
        <button id="zoomIn" class="w-12 h-12 rounded-full bg-white text-black text-xl shadow">+</button>
        <button id="closeViewer" class="w-12 h-12 rounded-full bg-red-500 text-white text-sm shadow">\u5173\u95ed</button>
      </div>
    </div>`;
  document.body.appendChild(viewer);

  const viewerImg = document.getElementById("viewerImg");
  const zoomSlider = document.getElementById("zoomSlider");
  const applyScale = () => {
    imageViewerScale = Math.min(4, Math.max(1, imageViewerScale));
    if (viewerImg) viewerImg.style.transform = `scale(${imageViewerScale})`;
    if (zoomSlider) zoomSlider.value = String(imageViewerScale);
  };

  document.getElementById("closeViewer")?.addEventListener("click", closeImageViewer);
  zoomSlider?.addEventListener("input", (e) => {
    imageViewerScale = parseFloat(e.target.value);
    applyScale();
  });
  document.getElementById("zoomIn")?.addEventListener("click", () => {
    imageViewerScale = Math.min(imageViewerScale + 0.2, 4);
    applyScale();
  });
  document.getElementById("zoomOut")?.addEventListener("click", () => {
    imageViewerScale = Math.max(1, imageViewerScale - 0.2);
    applyScale();
  });
  if (viewerImg) {
    viewerImg.ondblclick = () => {
      imageViewerScale = imageViewerScale === 1 ? 2 : 1;
      applyScale();
    };
    viewerImg.onerror = () => {
      viewerImg.onerror = null;
      viewerImg.src = FALLBACK_IMAGE_URL;
    };
  }
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeImageViewer();
  });

  return viewer;
}

function openImageViewer(src) {
  const viewer = ensureImageViewer();
  const img = document.getElementById("viewerImg");
  const slider = document.getElementById("zoomSlider");
  if (!viewer || !img) return;

  img.src = src || FALLBACK_IMAGE_URL;
  imageViewerScale = 1;
  img.style.transform = "scale(1)";
  if (slider) slider.value = "1";
  viewer.classList.remove("hidden");
}

function closeImageViewer() {
  const viewer = document.getElementById("imgViewer");
  if (!viewer) return;
  viewer.classList.add("hidden");
}

async function hydrateVoucherImages(containerEl) {
  ensureImageViewer();
  const imgEls = [...containerEl.querySelectorAll("img[data-image-path]")];
  await Promise.all(imgEls.map(async (img) => {
    const candidate = img.dataset.imagePath || "";
    const finalUrl = await resolveImageUrl(candidate);
    img.onload = () => console.log("图片加载成功");
    img.onerror = () => {
      console.error("图片加载失败:", img.src);
      img.onerror = null;
      img.src = FALLBACK_IMAGE_URL;
    };
    img.src = finalUrl || FALLBACK_IMAGE_URL;
    img.onclick = () => {
      if (img.src && img.src.startsWith("http")) openImageViewer(img.src);
    };
  }));
}

function handleTxClick(tx) {
  showTxDetail(tx);
}

function showTxDetail(tx) {
  const voucherDisplayPaths = getVoucherDisplayPaths(tx);
  const hasVoucher = voucherDisplayPaths.length > 0;
  const dateStr = normalizeDateStr(tx.date);

  const overlay = document.createElement("div");
  overlay.className = "absolute inset-0 bg-black/40 z-20";
  overlay.innerHTML = `
    <div class="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900 rounded-t-2xl z-30 pb-6"
         id="tx-detail-panel">
      <div class="w-8 h-1 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto mt-3 mb-4"></div>
      <div class="px-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-lg font-medium ${tx.type === "??" ? "text-teal-600" : "text-orange-600"}">
            ${tx.type === "??" ? "+" : "-"}?${fmtAmt(tx.amount)}
          </span>
          <span class="text-xs px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">${tx.status || "???"}</span>
        </div>
        <p class="text-base text-gray-900 dark:text-gray-100">${esc(tx.summary || "???")}</p>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div><span class="text-gray-400">??</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${esc(tx.category || "???")}</p></div>
          <div><span class="text-gray-400">??</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${dateStr}</p></div>
          <div><span class="text-gray-400">??</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${esc(tx.source || "--")}</p></div>
          <div><span class="text-gray-400">???</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${voucherDisplayPaths.length || 0} ?</p></div>
        </div>
        </div>
        ${hasVoucher ? renderVoucherGallery(voucherDisplayPaths, tx.legacyVoucherIds) : ""}
        <div class="flex gap-2 pt-2">
          <button data-action="unbind"
            class="flex-1 py-2 text-xs rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 ${hasVoucher ? "" : "opacity-50"}">
            精准解绑
          </button>
          <button data-action="delete"
            class="flex-1 py-2 text-xs rounded-xl border border-red-200 dark:border-red-900 text-red-500">
            删除账目
          </button>
        </div>
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  hydrateVoucherImages(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector("[data-action=unbind]")?.addEventListener("click", () => {
    if (!voucherDisplayPaths.length) {
      showToast("当前账目没有可解绑的凭证", "info");
      return;
    }
    openUnbindVoucherPicker(tx, voucherDisplayPaths, overlay);
  });

  overlay.querySelector("[data-action=delete]").addEventListener("click", async () => {
    if (!confirm(`?????${tx.summary || "???"}??`)) return;
    try {
      await deleteTransaction(tx.id);
      showToast("?????", "success");
      overlay.remove();
      await loadAndRender();
    } catch (err) {
      showToast(`?????${err.message}`, "error");
    }
  });
}
function renderVoucherGallery(storagePaths, legacyDriveIds = []) {
  const isDualBlind = APP_CONFIG.DUAL_BLIND_BANNER;
  return `
    <div>
      <p class="text-xs text-gray-400 mb-2">凭证图片 ${isDualBlind ? "· 双盲核对模式" : ""}</p>
      <div class="flex gap-2 overflow-x-auto pb-1">
        ${storagePaths.map((item, i) => {
          const imagePath = extractImagePath(item);
          const driveId = legacyDriveIds[i];
          return `
            <div class="flex-shrink-0 space-y-1">
              <img src="${FALLBACK_IMAGE_URL}" data-image-path="${esc(imagePath || "")}" class="w-20 h-20 rounded-lg object-cover border border-gray-100 dark:border-gray-700"
                   onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 80 80\\'><rect fill=\\'%23f3f4f6\\' width=\\'80\\' height=\\'80\\'/><text y=\\'45\\' x=\\'50%\\' text-anchor=\\'middle\\' font-size=\\'12\\' fill=\\'%239ca3af\\'>加载失败</text></svg>'">
              ${isDualBlind && driveId ? `
                <img src="https://drive.google.com/thumbnail?id=${esc(driveId)}&sz=w80"
                     class="w-20 h-5 rounded object-cover border border-blue-200 opacity-60"
                     title="V1 原图对比">` : ""}
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

// ── 1-9 键功能调"────────────────────────────────────

async function handleKeyAction(action) {
  switch (action) {
    case "openBatchMatching":    return openBatchMatching();
    case "openRowCorrelation":   return openGlobalInvestigationCenter({ defaultView: "records", sourceEntry: "row" });
    case "openVoucherCorrelation": return openGlobalInvestigationCenter({ defaultView: "pending", sourceEntry: "voucher" });
    case "openQuickEntry":       return openQuickEntry();
    case "openBatchText":        return openBatchText();
    case "openShadowMonitor":    return openShadowMonitor();   // "双写监控
    case "openDeduplication":    return openDeduplication();
    case "openUnbind":           return showToast("请先点击要解绑的账目卡片", "info");
    case "openConflictCourt":    return openDifficultyCenter();
    default:                     return showToast(`未知功能"{action}`, "warning");
  }
}

// ── 功能 ①：批量对账"───────────────────────────────

async function openBatchMatching() {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-4">批量对账"/h2>
      <div id="batch-drop" class="border-2 border-dashed border-gray-200 dark:border-gray-700
                                   rounded-xl p-8 text-center cursor-pointer hover:border-purple-400 transition-colors">
        <svg class="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>
        <p class="text-sm text-gray-400">点击或拖入凭证图"/p>
        <p class="text-xs text-gray-300 mt-1">支持多选，AI 自动批量匹配</p>
        <input type="file" id="batch-file-input" accept="image/*" multiple class="hidden">
      </div>
      <div id="batch-results" class="mt-4 space-y-2 max-h-48 overflow-y-auto"></div>
      <button id="batch-close" class="mt-4 w-full py-2 text-xs rounded-xl border border-gray-200 dark:border-gray-700 text-gray-500">关闭</button>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  overlay.querySelector("#batch-close").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const dropZone = overlay.querySelector("#batch-drop");
  const fileInput = overlay.querySelector("#batch-file-input");

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("border-purple-400"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("border-purple-400"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("border-purple-400");
    processBatchFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener("change", () => processBatchFiles([...fileInput.files]));

  async function processBatchFiles(files) {
    const resultsEl = overlay.querySelector("#batch-results");
    resultsEl.innerHTML = `<p class="text-xs text-gray-400 text-center py-2">AI ???... (0/${files.length})</p>`;

    let done = 0;
    for (const file of files) {
      try {
        const base64  = await fileToBase64(file);
        const aiData  = await geminiOCR({ base64, mime: file.type });
        const match   = findBestMatch(aiData, getFormalTransactions());
        done++;

        resultsEl.innerHTML += `
          <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs">
            <p class="font-medium text-gray-800 dark:text-gray-200 truncate">${esc(file.name)}</p>
            <p class="text-gray-500 mt-1">AI: ¥${aiData.amount ?? "?"} · ${esc(aiData.merchant || aiData.summary || "")}</p>
            ${match
              ? `<p class="text-teal-600 mt-1">匹配: ${esc(match.tx.summary)} (${match.score}"</p>`
              : `<p class="text-orange-500 mt-1">未找到匹配账"/p>`}
          </div>`;

        resultsEl.querySelector("p")?.remove(); // 移除进度提示
        showToast(`已处"${done}/${files.length}`, "info", 1500);
      } catch (err) {
        resultsEl.innerHTML += `<p class="text-xs text-red-500">${esc(file.name)}?${err.message}</p>`;
      }
    }
  }
}

// ── 功能 ④：快捷记账 ─────────────────────────────────

function openQuickEntry() {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">快捷记账</h2>
      <textarea id="quick-text" rows="3"
        class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800
               text-sm text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-purple-400"
        placeholder="输入一句话，例如：今天打车30，午"5，晚上卖二手收入80"></textarea>
      <div class="flex gap-2 mt-3">
        <button id="quick-voice" class="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500">
          语音
        </button>
        <button id="quick-submit" class="flex-1 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors">
          AI 解析
        </button>
      </div>
      <div id="quick-preview" class="mt-3 space-y-2"></div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#quick-voice").addEventListener("click", () => {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      showToast("当前浏览器不支持语音录入", "warning");
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.onresult = (e) => {
      overlay.querySelector("#quick-text").value = e.results[0][0].transcript;
    };
    rec.start();
    showToast("请开始说", "info", 3000);
  });

  overlay.querySelector("#quick-submit").addEventListener("click", async () => {
    const text = overlay.querySelector("#quick-text").value.trim();
    if (!text) return;
    const btn = overlay.querySelector("#quick-submit");
    btn.disabled = true;
    btn.textContent = "???...";

    try {
      const items = await geminiNLP({ text });
      const preview = overlay.querySelector("#quick-preview");
      renderParsedEntryPreview(preview, items, {
        source: "快捷文本录入",
        overlay,
      });
    } catch (err) {
      showToast(`?????${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "AI 解析";
    }
  });
}

function openBatchText() {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">批量补录</h2>
      <textarea id="batch-text-input" rows="6"
        class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800
               text-sm text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-purple-400"
        placeholder="粘贴多条账单文本..."></textarea>
      <button id="batch-text-submit"
        class="w-full mt-3 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium transition-colors">
        AI 批量解析
      </button>
      <div id="batch-text-preview" class="mt-3 space-y-2 max-h-48 overflow-y-auto"></div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#batch-text-submit").addEventListener("click", async () => {
    const text = overlay.querySelector("#batch-text-input").value.trim();
    if (!text) return;
    const btn = overlay.querySelector("#batch-text-submit");
    btn.disabled = true;
    btn.textContent = "???...";

    try {
      const items = await geminiNLP({ text });
      const preview = overlay.querySelector("#batch-text-preview");
      renderParsedEntryPreview(preview, items, {
        source: "批量文本录入",
        overlay,
        intro: `识别"${items.length} 条记录`,
      });
    } catch (err) {
      showToast(`?????${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "AI 批量解析";
    }
  });
}

function renderParsedEntryPreview(container, items, options = {}) {
  container.innerHTML = `
    ${options.intro ? `<p class="text-xs text-gray-400">${esc(options.intro)}</p>` : ""}
    ${items.map((item) => `
      <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="font-medium text-gray-800 dark:text-gray-200 truncate">${esc(item.summary || "无摘")}</p>
            <p class="text-gray-400 mt-1">${normalizeDateStr(item.date)} · ${esc(item.category || "未分")}</p>
          </div>
          <span class="${item.type === "收入" ? "text-teal-600" : "text-orange-600"} font-medium whitespace-nowrap">
            ${item.type === "收入" ? "+" : "-"}¥${fmtAmt(item.amount)}
          </span>
        </div>
      </div>`).join("")}
    <div class="grid grid-cols-2 gap-2 pt-1">
      <button id="entry-save-formal" class="py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium transition-colors">
        写入正式"      </button>
      <button id="entry-save-temp" class="py-2 rounded-xl border border-amber-300 text-amber-700 dark:text-amber-300 text-xs font-medium transition-colors">
        暂存到临时库
      </button>
    </div>`;

  container.querySelector("#entry-save-formal")?.addEventListener("click", async () => {
    await persistParsedItems(items, {
      source: options.source,
      recordBucket: "formal",
      overlay: options.overlay,
    });
  });

  container.querySelector("#entry-save-temp")?.addEventListener("click", async () => {
    await persistParsedItems(items, {
      source: options.source,
      recordBucket: "temp",
      overlay: options.overlay,
    });
  });
}

async function persistParsedItems(items, options = {}) {
  const recordBucket = options.recordBucket || "formal";
  const isTemp = recordBucket === "temp";

  for (const item of items) {
    await submitTransaction({
      date: item.date,
      month: (item.date || "").slice(0, 7),
      type: item.type,
      category: item.category,
      amount: item.amount,
      summary: item.summary,
      source: options.source || "AI 录入",
      recordBucket,
      lifecycleState: "active",
      pendingReason: null,
      decisionSource: "manual",
      decisionNote: buildAuditNote("", isTemp ? "save parsed entry to temp bucket" : "save parsed entry to formal ledger"),
    });
  }

  showToast(
    isTemp ? `已暂"${items.length} 条临时记录` : `已写"${items.length} 条正式记录`,
    "success",
  );
  options.overlay?.remove();
  await loadAndRender();
}
async function openPendingVoucherPool() {
  const overlay = createModalOverlay();
  document.getElementById("app-root").appendChild(overlay);

  async function renderPool() {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">待匹"/ 待续关联</h2>
            <p class="text-xs text-gray-400 mt-1">展示 lifecycleState = pending_link 的凭证，先可视化池子，再进入重新关联或排查"/p>
          </div>
          <button id="pending-pool-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
        </div>
        <div id="pending-pool-list" class="space-y-2 max-h-[60vh] overflow-y-auto">
          <p class="text-xs text-gray-400 text-center py-8">???...</p>
        </div>
      </div>`;

    const listEl = overlay.querySelector("#pending-pool-list");
    const vouchers = await fetchPendingVouchers({ limit: 100 });

    if (!vouchers.length) {
      listEl.innerHTML = `
        <div class="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center">
          <p class="text-sm text-gray-500">当前没有待匹配凭"/p>
          <p class="text-xs text-gray-400 mt-1">精准解绑后的凭证、后续待续关联凭证会先进入这里"/p>
        </div>`;
    } else {
      listEl.innerHTML = vouchers.map((voucher) => renderPendingVoucherCard(voucher)).join("");
      hydrateVoucherImages(overlay);

      listEl.querySelectorAll("[data-open-preview]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const voucher = vouchers.find((item) => item.id === btn.dataset.openPreview);
          if (voucher) openPendingVoucherPreview(voucher);
        });
      });

      listEl.querySelectorAll("[data-open-inspector]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const voucher = vouchers.find((item) => item.id === btn.dataset.openInspector);
          if (voucher) openPendingVoucherInspector(voucher);
        });
      });

      listEl.querySelectorAll("[data-open-relink]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const voucher = vouchers.find((item) => item.id === btn.dataset.openRelink);
          if (!voucher) return;
          await openVoucherRelinkPicker(voucher, renderPool);
        });
      });
    }

    overlay.querySelector("#pending-pool-close")?.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    }, { once: true });
  }

  try {
    await renderPool();
  } catch (err) {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5 text-center">
        <p class="text-sm text-red-500">加载待匹配池失败</p>
        <p class="text-xs text-gray-400 mt-2">${esc(err.message)}</p>
      </div>`;
  }
}

function renderPendingVoucherCard(voucher) {
  const sourceLabel = voucher.migratedFrom || voucher.source || voucher.decisionSource || "--";
  const linkedCount = Array.isArray(voucher.linkedTransactionIds) ? voucher.linkedTransactionIds.length : 0;
  return `
    <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
      <div class="flex gap-3">
        <img src="${esc(voucher.thumbnailUrl || voucher.publicUrl || FALLBACK_IMAGE_URL)}"
          data-image-path="${esc(voucher.storagePath || "")}" class="w-16 h-16 rounded-xl object-cover border border-gray-100 dark:border-gray-700 flex-shrink-0">
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">pending_link</span>
            <span class="text-[10px] text-gray-400">${formatReviewTime(voucher.latestAt)}</span>
          </div>
          <p class="text-xs font-medium text-gray-800 dark:text-gray-200 mt-2 break-all">${esc(getVoucherLabel(voucher.storagePath || voucher.legacyDriveId || voucher.id))}</p>
          <p class="text-[10px] text-gray-400 mt-1">来源"{esc(sourceLabel)}</p>
          <p class="text-[10px] text-gray-400 mt-1">关联状态：${linkedCount ? `仍有 ${linkedCount} 条弱关联` : "未绑"}</p>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 mt-3">
        <button data-open-preview="${esc(voucher.id)}" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">查看</button>
        <button data-open-relink="${esc(voucher.id)}" class="py-2 rounded-lg bg-teal-600 text-white text-[11px] font-medium">重新关联</button>
        <button data-open-inspector="${esc(voucher.id)}" class="py-2 rounded-lg border border-amber-200 text-[11px] text-amber-700 dark:text-amber-300">进入排查</button>
      </div>
    </div>`;
}

function openPendingVoucherPreview(voucher) {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">凭证查看</h2>
        <button id="pending-preview-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <img src="${esc(voucher.publicUrl || voucher.thumbnailUrl || FALLBACK_IMAGE_URL)}" data-image-path="${esc(voucher.storagePath || "")}" class="w-full h-64 rounded-xl object-contain bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
      <p class="text-xs text-gray-400 mt-3 break-all">${esc(voucher.storagePath || voucher.id)}</p>
    </div>`;
  document.getElementById("app-root").appendChild(overlay);
  hydrateVoucherImages(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#pending-preview-close")?.addEventListener("click", () => overlay.remove());
}

function openPendingVoucherInspector(voucher) {
  const overlay = createModalOverlay();
  const linkedCount = Array.isArray(voucher.linkedTransactionIds) ? voucher.linkedTransactionIds.length : 0;
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">待匹配排"/h2>
        <button id="pending-inspector-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="space-y-3 text-xs">
        <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
          <p class="text-gray-400">storagePath</p>
          <p class="text-gray-700 dark:text-gray-200 break-all mt-1">${esc(voucher.storagePath || "--")}</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
            <p class="text-gray-400">最近更新时"/p>
            <p class="text-gray-700 dark:text-gray-200 mt-1">${formatReviewTime(voucher.latestAt)}</p>
          </div>
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
            <p class="text-gray-400">关联状"/p>
            <p class="text-gray-700 dark:text-gray-200 mt-1">${linkedCount ? `${linkedCount} 条残留关联` : "待重新关"}</p>
          </div>
        </div>
        <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
          <p class="text-gray-400">pendingReason</p>
          <p class="text-gray-700 dark:text-gray-200 mt-1">${esc(voucher.pendingReason || "--")}</p>
        </div>
        <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
          <p class="text-gray-400">decisionNote</p>
          <p class="text-gray-700 dark:text-gray-200 mt-1 whitespace-pre-wrap break-words">${esc(voucher.decisionNote || "暂无留痕")}</p>
        </div>
      </div>
    </div>`;
  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#pending-inspector-close")?.addEventListener("click", () => overlay.remove());
}

function buildVoucherMatchDraft(voucher) {
  const amount = pickFirstNumber([
    voucher.amount,
    voucher.totalAmount,
    voucher.ocrAmount,
    extractAmountFromText(voucher.decisionNote),
  ]);
  const date = pickFirstDate([
    voucher.date,
    voucher.billDate,
    voucher.ocrDate,
    voucher.uploadedAt,
    voucher.updatedAt,
  ]);
  const summary = pickFirstText([
    voucher.summary,
    voucher.merchant,
    voucher.ocrSummary,
    voucher.ocrMerchant,
    getVoucherLabel(voucher.storagePath || voucher.legacyDriveId || voucher.id),
  ]);

  return { amount, date, summary };
}

function pickFirstNumber(values = []) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function pickFirstDate(values = []) {
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeDateStr(value);
    if (normalized) return normalized;
  }
  return "";
}

function pickFirstText(values = []) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function extractAmountFromText(text) {
  const match = String(text || "").match(/(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : 0;
}

function formatMatchReason(reason) {
  const map = {
    exact_amount: "金额一",
    close_amount: "金额接近",
    same_day: "日期同日",
    near_day: "日期接近",
    same_month: "同月",
    same_summary: "摘要一",
    summary_overlap: "摘要命中",
    summary_near: "摘要相近",
  };
  return map[reason] || "弱命";
}

function renderRankedMatchCard(candidate) {
  return `
    <button data-relink-target="${esc(candidate.tx.id)}" class="w-full text-left rounded-xl border border-gray-100 dark:border-gray-700 px-3 py-3 hover:border-teal-300 transition-colors">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded-full ${candidate.tx.recordBucket === "temp" ? "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300" : "bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-300"}">${candidate.tx.recordBucket === "temp" ? "temp" : "formal"}</span>
            <span class="text-[10px] text-gray-400">${normalizeDateStr(candidate.tx.date)}</span>
          </div>
          <p class="text-xs font-medium text-gray-800 dark:text-gray-200 mt-2 truncate">${esc(candidate.tx.summary || "无摘")}</p>
          <p class="text-[10px] text-gray-400 mt-1">${esc(candidate.tx.category || "未分")} · ${esc(candidate.tx.source || "--")}</p>
          <p class="text-[10px] text-gray-400 mt-1">${candidate.reasons.length ? esc(summarizeMatchReasons(candidate.reasons)) : "命中信息不足，按弱候选展"}</p>
        </div>
        <div class="text-right flex-shrink-0">
          <span class="text-xs font-medium ${candidate.tx.type === "收入" ? "text-teal-600" : "text-orange-600"}">${candidate.tx.type === "收入" ? "+" : "-"}¥${fmtAmt(candidate.tx.amount)}</span>
          <p class="text-[10px] text-gray-400 mt-1">${candidate.score}"/p>
        </div>
      </div>
    </button>`;
}

async function openTempPromotionReview(tx, onPromoted) {
  const formalRecords = (await fetchLedger({ limit: 300 }))
    .filter((item) => !item?._deleted && item.recordBucket !== "temp" && item.id !== tx.id);
  const risk = findDuplicateCandidates(tx, formalRecords, { maxCandidates: 5 });

  if (!risk.hasRisk) {
    await promoteTempTransaction(tx.id, {
      decisionSource: "manual",
      decisionNote: "promote temp transaction after duplicate check: clean",
    });
    showToast("临时记录已转", "success");
    if (typeof onPromoted === "function") await onPromoted();
    await loadAndRender();
    return;
  }

  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">转正前去重提"/h2>
          <p class="text-xs text-gray-400 mt-1">系统发现可能重复的正式记录。你可以取消转正，或坚持继续并留下操作痕迹"/p>
        </div>
        <button id="promote-review-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="rounded-xl bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-500 mb-3">
        <span class="text-red-500 font-medium">高疑"${risk.highCount}</span>
        <span class="mx-2 text-gray-300">|</span>
        <span class="text-amber-500 font-medium">中疑"${risk.mediumCount}</span>
      </div>
      <div class="space-y-2 max-h-[44vh] overflow-y-auto">
        ${risk.candidates.map((item) => `
          <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] px-2 py-0.5 rounded-full ${item.level === "high" ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300" : "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300"}">${item.level === "high" ? "高疑" : "中疑"}</span>
              <span class="text-[10px] text-gray-400">${item.score}"/span>
            </div>
            <p class="text-xs font-medium text-gray-800 dark:text-gray-200 mt-2">${esc(item.tx.summary || "无摘")}</p>
            <p class="text-[10px] text-gray-400 mt-1">${normalizeDateStr(item.tx.date)} · ${esc(item.tx.category || "未分")} · ¥${fmtAmt(item.tx.amount)}</p>
            <p class="text-[10px] text-gray-400 mt-1">${esc(summarizeDuplicateReasons(item.reasons, item.score))}</p>
          </div>`).join("")}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-4">
        <button id="promote-review-cancel" class="py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500">取消转正</button>
        <button id="promote-review-continue" class="py-2 rounded-xl bg-teal-600 text-white text-xs font-medium">坚持转正</button>
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#promote-review-close")?.addEventListener("click", close);
  overlay.querySelector("#promote-review-cancel")?.addEventListener("click", close);
  overlay.querySelector("#promote-review-continue")?.addEventListener("click", async () => {
    const btn = overlay.querySelector("#promote-review-continue");
    btn.disabled = true;
    btn.textContent = "???...";
    try {
      const strategy = getDedupePromotionStrategy();
      const resolveAsDone = strategy === "manual_resolve";
      await promoteTempTransaction(tx.id, {
        decisionSource: "manual",
        decisionNote: `promote temp with duplicate override strategy=${strategy} high=${risk.highCount} medium=${risk.mediumCount}`,
        difficultyState: resolveAsDone ? "done" : null,
        difficultyDoneReason: resolveAsDone ? DEDUPE_MANUAL_RESOLVE_REASON : null,
        difficultyDoneAt: resolveAsDone ? new Date().toISOString() : null,
      });
      close();
      showToast(resolveAsDone ? "转正完成（已按人工裁定关闭本条去重困难）" : "临时记录已转", "success");
      if (typeof onPromoted === "function") await onPromoted();
      await loadAndRender();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "坚持转正";
      showToast(`?????${err.message}`, "error");
    }
  });
}

async function openVoucherRelinkPicker(voucher, onDone) {
  const overlay = createModalOverlay();
  document.getElementById("app-root").appendChild(overlay);
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">重新关联凭证</h2>
          <p class="text-xs text-gray-400 mt-1">候选范围已扩展到全局正式账和临时库，并按分数排序展示"/p>
        </div>
        <button id="relink-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div id="relink-list" class="space-y-2 max-h-[58vh] overflow-y-auto">
        <p class="text-xs text-gray-400 text-center py-8">加载候选中...</p>
      </div>
    </div>`;

  const formalCandidates = (await fetchLedger({ limit: 300 }))
    .filter((tx) => !tx?._deleted && tx.recordBucket !== "temp");
  const tempCandidates = (await fetchTempTransactions({ limit: 100 }))
    .filter((tx) => !tx?._deleted);
  const candidateMap = new Map();
  [...formalCandidates, ...tempCandidates].forEach((tx) => {
    if (!tx?.id) return;
    candidateMap.set(tx.id, tx);
  });

  const draft = buildVoucherMatchDraft(voucher);
  const rankedCandidates = findRankedMatches(draft, [...candidateMap.values()], {
    threshold: 12,
    maxCandidates: 12,
  });
  const listEl = overlay.querySelector("#relink-list");

  if (!rankedCandidates.length) {
    listEl.innerHTML = `<p class="text-sm text-gray-500 text-center py-8">当前没有可排序的候选记"/p>`;
  } else {
    listEl.innerHTML = rankedCandidates.map((candidate) => renderRankedMatchCard(candidate)).join("");

    listEl.querySelectorAll("[data-relink-target]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await relinkVoucherToTransaction({
            voucherId: voucher.id,
            storagePath: voucher.storagePath,
            txId: btn.dataset.relinkTarget,
          });
          showToast("凭证已重新关", "success");
          overlay.remove();
          if (typeof onDone === "function") await onDone();
          await loadAndRender();
        } catch (err) {
          btn.disabled = false;
          showToast(`???????${err.message}`, "error");
        }
      });
    });
  }

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#relink-close")?.addEventListener("click", () => overlay.remove());
}
async function openTempRecordPool() {
  const overlay = createModalOverlay();
  document.getElementById("app-root").appendChild(overlay);

  async function renderPool() {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">临时录入"/h2>
            <p class="text-xs text-gray-400 mt-1">临时记录不混入正式账本，可先编辑，再转正"/p>
          </div>
          <button id="temp-pool-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
        </div>
        <div id="temp-pool-list" class="space-y-2 max-h-[60vh] overflow-y-auto">
          <p class="text-xs text-gray-400 text-center py-8">???...</p>
        </div>
      </div>`;

    const listEl = overlay.querySelector("#temp-pool-list");
    const tempRecords = (await fetchTempTransactions({ limit: 100 })).filter((tx) => !tx?._deleted);

    if (!tempRecords.length) {
      listEl.innerHTML = `
        <div class="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center">
          <p class="text-sm text-gray-500">当前没有临时记录</p>
          <p class="text-xs text-gray-400 mt-1">从快捷记账或批量补录里选择“暂存到临时库”后，会先出现在这里"/p>
        </div>`;
    } else {
      listEl.innerHTML = tempRecords.map((tx) => renderTempRecordCard(tx)).join("");

      listEl.querySelectorAll("[data-temp-edit]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tx = tempRecords.find((item) => item.id === btn.dataset.tempEdit);
          if (tx) await openTempEditDialog(tx, renderPool);
        });
      });

      listEl.querySelectorAll("[data-temp-promote]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tx = tempRecords.find((item) => item.id === btn.dataset.tempPromote);
          if (!tx) return;
          btn.disabled = true;
          try {
            await openTempPromotionReview(tx, renderPool);
          } catch (err) {
            showToast(`?????${err.message}`, "error");
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    overlay.querySelector("#temp-pool-close")?.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    }, { once: true });
  }

  try {
    await renderPool();
  } catch (err) {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5 text-center">
        <p class="text-sm text-red-500">加载临时库失"/p>
        <p class="text-xs text-gray-400 mt-2">${esc(err.message)}</p>
      </div>`;
  }
}
function renderTempRecordCard(tx) {
  return `
    <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">temp</span>
            <span class="text-[10px] text-gray-400">${normalizeDateStr(tx.date)}</span>
          </div>
          <p class="text-sm font-medium text-gray-800 dark:text-gray-200 mt-2 truncate">${esc(tx.summary || "无摘")}</p>
          <p class="text-[10px] text-gray-400 mt-1">${esc(tx.category || "未分")} · ${esc(tx.source || "--")}</p>
          <p class="text-[10px] text-gray-400 mt-1">最近复核：${formatReviewTime(tx.lastReviewedAt || tx.updatedAt || tx.createdAt)}</p>
        </div>
        <span class="text-xs font-medium ${tx.type === "收入" ? "text-teal-600" : "text-orange-600"}">${tx.type === "收入" ? "+" : "-"}¥${fmtAmt(tx.amount)}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <button data-temp-edit="${esc(tx.id)}" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">编辑</button>
        <button data-temp-promote="${esc(tx.id)}" class="py-2 rounded-lg bg-teal-600 text-white text-[11px] font-medium">转正</button>
      </div>
    </div>`;
}

async function openTempEditDialog(tx, onSaved) {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">编辑临时记录</h2>
        <button id="temp-edit-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="space-y-3">
        <input id="temp-edit-date" value="${esc(normalizeDateStr(tx.date))}" class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
        <select id="temp-edit-type" class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100">
          <option value="支出" ${tx.type === "支出" ? "selected" : ""}>支出</option>
          <option value="收入" ${tx.type === "收入" ? "selected" : ""}>收入</option>
        </select>
        <input id="temp-edit-category" value="${esc(tx.category || "")}" placeholder="分类" class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
        <input id="temp-edit-summary" value="${esc(tx.summary || "")}" placeholder="摘要" class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
        <input id="temp-edit-amount" value="${esc(String(tx.amount ?? ""))}" placeholder="金额" class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
      </div>
      <div class="grid grid-cols-2 gap-2 mt-4">
        <button id="temp-edit-cancel" class="py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500">取消</button>
        <button id="temp-edit-save" class="py-2 rounded-xl bg-purple-600 text-white text-xs font-medium">保存</button>
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#temp-edit-close")?.addEventListener("click", close);
  overlay.querySelector("#temp-edit-cancel")?.addEventListener("click", close);

  overlay.querySelector("#temp-edit-save")?.addEventListener("click", async () => {
    const date = overlay.querySelector("#temp-edit-date").value.trim();
    const type = overlay.querySelector("#temp-edit-type").value;
    const category = overlay.querySelector("#temp-edit-category").value.trim();
    const summary = overlay.querySelector("#temp-edit-summary").value.trim();
    const amount = Number(overlay.querySelector("#temp-edit-amount").value);

    if (!date || !summary || !Number.isFinite(amount)) {
      showToast("请补全日期、摘要和有效金额", "warning");
      return;
    }

    const saveBtn = overlay.querySelector("#temp-edit-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "???...";
    try {
      await updateTransaction(tx.id, {
        date,
        month: date.slice(0, 7),
        type,
        category,
        summary,
        amount,
        decisionSource: "manual",
        decisionNote: buildAuditNote(tx.decisionNote, "edit temp transaction"),
      });
      showToast("临时记录已更", "success");
      close();
      if (typeof onSaved === "function") await onSaved();
      await loadAndRender();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
      showToast(`?????${err.message}`, "error");
    }
  });
}

async function openGlobalInvestigationCenter({ defaultView = "all", sourceEntry = "row" } = {}) {
  const overlay = createModalOverlay();
  document.getElementById("app-root").appendChild(overlay);

  const runtimeEnv = (typeof window !== "undefined" && window.__ENV__) || {};
  const toPositiveInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  };
  const toNonNegativeInt = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
  };
  const cloneJson = (value, fallback = null) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  };
  const SEARCH_SCOPE_BASE_LIMITS = Object.freeze({
    formal: toPositiveInt(runtimeEnv.GLOBAL_CENTER_LIMIT_FORMAL, 300),
    temp: toPositiveInt(runtimeEnv.GLOBAL_CENTER_LIMIT_TEMP, 120),
    pendingLink: toPositiveInt(runtimeEnv.GLOBAL_CENTER_LIMIT_PENDING, 120),
  });
  const SEARCH_SCOPE_STEPS = Object.freeze({
    formal: toPositiveInt(runtimeEnv.GLOBAL_CENTER_STEP_FORMAL, 200),
    temp: toPositiveInt(runtimeEnv.GLOBAL_CENTER_STEP_TEMP, 60),
    pendingLink: toPositiveInt(runtimeEnv.GLOBAL_CENTER_STEP_PENDING, 60),
  });
  const SEARCH_SCOPE_MAX_LIMITS = Object.freeze({
    formal: toPositiveInt(runtimeEnv.GLOBAL_CENTER_MAX_FORMAL, 2000),
    temp: toPositiveInt(runtimeEnv.GLOBAL_CENTER_MAX_TEMP, 1000),
    pendingLink: toPositiveInt(runtimeEnv.GLOBAL_CENTER_MAX_PENDING, 1000),
  });
  const sanitizeLimit = (value, base, max) => {
    const num = toPositiveInt(value, base);
    return Math.max(base, Math.min(num, max));
  };
  const normalizePendingMode = (value) => (value === "fallback-step" ? "fallback-step" : "cursor");
  const forcePendingFallbackStep = Boolean(runtimeEnv.GLOBAL_CENTER_FORCE_PENDING_FALLBACK_STEP);
  const restoredSession = (
    globalCenterSessionMemory
    && globalCenterSessionMemory.sourceEntry === sourceEntry
  )
    ? cloneJson(globalCenterSessionMemory, null)
    : null;
  const sessionRestoredAtOpen = Boolean(restoredSession);

  let activeView = String(restoredSession?.activeView || defaultView || "all");
  let searchKeyword = String(restoredSession?.searchKeyword || "");
  let scopeRequest = {
    formal: sanitizeLimit(
      restoredSession?.scopeRequest?.formal,
      SEARCH_SCOPE_BASE_LIMITS.formal,
      SEARCH_SCOPE_MAX_LIMITS.formal,
    ),
    temp: sanitizeLimit(
      restoredSession?.scopeRequest?.temp,
      SEARCH_SCOPE_BASE_LIMITS.temp,
      SEARCH_SCOPE_MAX_LIMITS.temp,
    ),
  };
  const pendingPageSize = toPositiveInt(runtimeEnv.GLOBAL_CENTER_PENDING_PAGE_SIZE, SEARCH_SCOPE_BASE_LIMITS.pendingLink);
  const restoredPending = restoredSession?.pending || null;
  const restoredPendingList = Array.isArray(restoredPending?.list) ? restoredPending.list : [];
  const pendingCursorState = {
    list: cloneJson(restoredPendingList, []),
    nextCursor: cloneJson(restoredPending?.nextCursor || null, null),
    hasMore: typeof restoredPending?.hasMore === "boolean" ? restoredPending.hasMore : true,
    loading: false,
    initialized: !forcePendingFallbackStep && Boolean(restoredPending?.initialized),
    mode: normalizePendingMode(restoredPending?.mode),
    fallback: normalizePendingMode(restoredPending?.mode) === "fallback-step",
    fallbackReason: restoredPending?.fallbackReason || null,
    fallbackDetail: restoredPending?.fallbackDetail || null,
    fallbackLimit: sanitizeLimit(
      restoredPending?.fallbackLimit,
      pendingPageSize,
      SEARCH_SCOPE_MAX_LIMITS.pendingLink,
    ),
    fallbackStep: toPositiveInt(runtimeEnv.GLOBAL_CENTER_STEP_PENDING, SEARCH_SCOPE_STEPS.pendingLink),
    pageSize: pendingPageSize,
  };
  if (!pendingCursorState.initialized) {
    pendingCursorState.list = [];
    pendingCursorState.nextCursor = null;
    pendingCursorState.hasMore = true;
    pendingCursorState.mode = "cursor";
    pendingCursorState.fallback = false;
    pendingCursorState.fallbackReason = null;
    pendingCursorState.fallbackDetail = null;
    pendingCursorState.fallbackLimit = pendingPageSize;
  }
  let formalCacheRecords = (
    Array.isArray(restoredSession?.caches?.formalRecords)
    && Number(restoredSession?.caches?.formalLimit) === scopeRequest.formal
  )
    ? cloneJson(restoredSession.caches.formalRecords, null)
    : null;
  let tempCacheRecords = (
    Array.isArray(restoredSession?.caches?.tempRecords)
    && Number(restoredSession?.caches?.tempLimit) === scopeRequest.temp
  )
    ? cloneJson(restoredSession.caches.tempRecords, null)
    : null;
  let restoreScrollTop = toNonNegativeInt(restoredSession?.scrollTop, 0);
  let overlayOutsideCloseBound = false;

  function expandScope(sourceType) {
    const keyMap = {
      formal: ["formal"],
      temp: ["temp"],
      all: ["formal", "temp"],
    };
    const targetKeys = keyMap[sourceType] || [];
    targetKeys.forEach((key) => {
      const next = scopeRequest[key] + SEARCH_SCOPE_STEPS[key];
      scopeRequest[key] = Math.min(next, SEARCH_SCOPE_MAX_LIMITS[key]);
      if (key === "formal") formalCacheRecords = null;
      if (key === "temp") tempCacheRecords = null;
    });
  }

  function mergePendingById(existing = [], incoming = []) {
    const map = new Map();
    existing.forEach((item) => {
      if (!item?.id) return;
      map.set(item.id, item);
    });
    incoming.forEach((item) => {
      if (!item?.id) return;
      map.set(item.id, item);
    });
    return [...map.values()];
  }

  function removePendingVoucherFromState(voucher = {}) {
    const targetId = String(voucher.id || "").trim();
    const targetPath = String(voucher.storagePath || "").trim();
    if (!targetId && !targetPath) return;
    pendingCursorState.list = pendingCursorState.list.filter((item) => {
      const idMatched = targetId && String(item?.id || "").trim() === targetId;
      const pathMatched = targetPath && String(item?.storagePath || "").trim() === targetPath;
      return !(idMatched || pathMatched);
    });
    formalCacheRecords = null;
  }

  async function loadPendingCursorPage({ reset = false } = {}) {
    if (pendingCursorState.loading) return;
    if (!reset && !pendingCursorState.hasMore) return;
    pendingCursorState.loading = true;
    try {
      if (reset) {
        pendingCursorState.list = [];
        pendingCursorState.nextCursor = null;
        pendingCursorState.hasMore = true;
        pendingCursorState.fallback = false;
        pendingCursorState.mode = "cursor";
        pendingCursorState.fallbackReason = null;
        pendingCursorState.fallbackDetail = null;
        pendingCursorState.fallbackLimit = pendingCursorState.pageSize;
      }

      if (pendingCursorState.mode === "fallback-step" && !reset) {
        pendingCursorState.fallbackLimit = Math.min(
          pendingCursorState.fallbackLimit + pendingCursorState.fallbackStep,
          SEARCH_SCOPE_MAX_LIMITS.pendingLink,
        );
        const legacyList = await fetchPendingVouchers({ limit: pendingCursorState.fallbackLimit });
        const incoming = Array.isArray(legacyList) ? legacyList : [];
        pendingCursorState.list = mergePendingById([], incoming);
        pendingCursorState.nextCursor = null;
        pendingCursorState.hasMore = pendingCursorState.fallbackLimit < SEARCH_SCOPE_MAX_LIMITS.pendingLink
          && incoming.length >= pendingCursorState.fallbackLimit;
        pendingCursorState.fallback = true;
        pendingCursorState.initialized = true;
        return;
      }

      const payload = await fetchPendingVouchers({
        pageSize: pendingCursorState.pageSize,
        cursor: reset ? null : pendingCursorState.nextCursor,
        returnMeta: true,
      });
      const response = Array.isArray(payload)
        ? { list: payload, nextCursor: null, hasMore: false, fallback: true, fallbackReason: "cursor_query_failed" }
        : (payload || { list: [], nextCursor: null, hasMore: false, fallback: true, fallbackReason: "cursor_query_failed" });
      const incoming = Array.isArray(response.list) ? response.list : [];

      if (response.fallback) {
        pendingCursorState.mode = "fallback-step";
        pendingCursorState.fallback = true;
        pendingCursorState.fallbackLimit = Math.max(
          pendingCursorState.fallbackLimit,
          pendingCursorState.pageSize,
        );
        pendingCursorState.fallbackReason = response.fallbackReason || "cursor_query_failed";
        pendingCursorState.fallbackDetail = response.fallbackDetail || response.fallbackReason || null;
        pendingCursorState.list = mergePendingById([], incoming);
        pendingCursorState.nextCursor = null;
        pendingCursorState.hasMore = pendingCursorState.fallbackLimit < SEARCH_SCOPE_MAX_LIMITS.pendingLink
          && incoming.length >= pendingCursorState.fallbackLimit;
      } else {
        pendingCursorState.mode = "cursor";
        pendingCursorState.list = reset
          ? mergePendingById([], incoming)
          : mergePendingById(pendingCursorState.list, incoming);
        pendingCursorState.nextCursor = response.nextCursor || null;
        pendingCursorState.hasMore = Boolean(response.hasMore && response.nextCursor);
        pendingCursorState.fallback = false;
        pendingCursorState.fallbackReason = null;
        pendingCursorState.fallbackDetail = null;
      }
      pendingCursorState.initialized = true;
    } finally {
      pendingCursorState.loading = false;
    }
  }

  function saveSessionState(scrollTopOverride = null) {
    const listEl = overlay.querySelector("#global-center-list");
    const nextScrollTop = scrollTopOverride == null
      ? toNonNegativeInt(listEl?.scrollTop, 0)
      : toNonNegativeInt(scrollTopOverride, 0);
    globalCenterSessionMemory = {
      sourceEntry,
      activeView,
      searchKeyword,
      scopeRequest: {
        formal: scopeRequest.formal,
        temp: scopeRequest.temp,
      },
      pending: {
        list: cloneJson(pendingCursorState.list, []),
        nextCursor: cloneJson(pendingCursorState.nextCursor || null, null),
        hasMore: Boolean(pendingCursorState.hasMore),
        initialized: Boolean(pendingCursorState.initialized),
        mode: normalizePendingMode(pendingCursorState.mode),
        fallbackReason: pendingCursorState.fallbackReason || null,
        fallbackDetail: pendingCursorState.fallbackDetail || null,
        fallbackLimit: sanitizeLimit(
          pendingCursorState.fallbackLimit,
          pendingCursorState.pageSize,
          SEARCH_SCOPE_MAX_LIMITS.pendingLink,
        ),
      },
      caches: {
        formalLimit: scopeRequest.formal,
        tempLimit: scopeRequest.temp,
        formalRecords: Array.isArray(formalCacheRecords) ? cloneJson(formalCacheRecords, []) : null,
        tempRecords: Array.isArray(tempCacheRecords) ? cloneJson(tempCacheRecords, []) : null,
      },
      scrollTop: nextScrollTop,
      savedAt: new Date().toISOString(),
    };
  }

  async function loadEntries() {
    if (!pendingCursorState.initialized) {
      await loadPendingCursorPage({ reset: true });
    }

    let formalRecords = null;
    let tempRecords = null;
    const fetchTasks = [];
    if (Array.isArray(formalCacheRecords)) {
      formalRecords = cloneJson(formalCacheRecords, []);
    } else {
      fetchTasks.push(
        fetchLedger({ limit: scopeRequest.formal }).then((records) => {
          formalRecords = records;
          formalCacheRecords = cloneJson(records, []);
        }),
      );
    }
    if (Array.isArray(tempCacheRecords)) {
      tempRecords = cloneJson(tempCacheRecords, []);
    } else {
      fetchTasks.push(
        fetchTempTransactions({ limit: scopeRequest.temp }).then((records) => {
          tempRecords = records;
          tempCacheRecords = cloneJson(records, []);
        }),
      );
    }
    if (fetchTasks.length) {
      await Promise.all(fetchTasks);
    }
    formalRecords = Array.isArray(formalRecords) ? formalRecords : [];
    tempRecords = Array.isArray(tempRecords) ? tempRecords : [];

    const formal = formalRecords
      .filter((tx) => !tx?._deleted && tx.recordBucket !== "temp")
      .map((tx) => ({
        entryId: `formal:${tx.id}`,
        sourceType: "formal",
        statusText: tx.status || tx.lifecycleState || "active",
        updatedAt: tx.lastReviewedAt || tx.updatedAt || tx.createdAt || null,
        payload: tx,
      }));

    const temp = tempRecords
      .filter((tx) => !tx?._deleted)
      .map((tx) => ({
        entryId: `temp:${tx.id}`,
        sourceType: "temp",
        statusText: tx.recordBucket || "temp",
        updatedAt: tx.lastReviewedAt || tx.updatedAt || tx.createdAt || null,
        payload: tx,
      }));

    const pending = pendingCursorState.list.map((voucher) => ({
      entryId: `pending:${voucher.id}`,
      sourceType: "pending_link",
      statusText: voucher.lifecycleState || "pending_link",
      updatedAt: voucher.latestAt || voucher.lastReviewedAt || voucher.updatedAt || null,
      payload: voucher,
    }));

    return {
      entries: [...formal, ...temp, ...pending],
      scope: {
        base: {
          formal: SEARCH_SCOPE_BASE_LIMITS.formal,
          temp: SEARCH_SCOPE_BASE_LIMITS.temp,
          pendingLink: SEARCH_SCOPE_BASE_LIMITS.pendingLink,
        },
        requested: {
          formal: scopeRequest.formal,
          temp: scopeRequest.temp,
          pendingLink: pendingCursorState.mode === "fallback-step"
            ? pendingCursorState.fallbackLimit
            : pendingCursorState.list.length,
        },
        loaded: {
          formal: formal.length,
          temp: temp.length,
          pendingLink: pending.length,
        },
        canLoadMore: {
          formal: scopeRequest.formal < SEARCH_SCOPE_MAX_LIMITS.formal && formalRecords.length >= scopeRequest.formal,
          temp: scopeRequest.temp < SEARCH_SCOPE_MAX_LIMITS.temp && tempRecords.length >= scopeRequest.temp,
          pendingLink: !pendingCursorState.loading && pendingCursorState.hasMore,
        },
        steps: {
          ...SEARCH_SCOPE_STEPS,
          pendingLink: pendingCursorState.mode === "fallback-step"
            ? pendingCursorState.fallbackStep
            : pendingCursorState.pageSize,
        },
        max: SEARCH_SCOPE_MAX_LIMITS,
        nextStep: {
          formal: scopeRequest.formal < SEARCH_SCOPE_MAX_LIMITS.formal
            ? Math.min(scopeRequest.formal + SEARCH_SCOPE_STEPS.formal, SEARCH_SCOPE_MAX_LIMITS.formal)
            : null,
          temp: scopeRequest.temp < SEARCH_SCOPE_MAX_LIMITS.temp
            ? Math.min(scopeRequest.temp + SEARCH_SCOPE_STEPS.temp, SEARCH_SCOPE_MAX_LIMITS.temp)
            : null,
          pendingLink: pendingCursorState.hasMore
            ? (pendingCursorState.mode === "fallback-step"
              ? Math.min(
                pendingCursorState.fallbackLimit + pendingCursorState.fallbackStep,
                SEARCH_SCOPE_MAX_LIMITS.pendingLink,
              )
              : pendingCursorState.list.length + pendingCursorState.pageSize)
            : null,
        },
        basedOnLoadedRange: true,
        sessionRestored: sessionRestoredAtOpen,
        pendingSessionRestored: sessionRestoredAtOpen && Boolean(restoredPending?.initialized),
        pendingCursorFallback: pendingCursorState.fallback,
        pendingMode: pendingCursorState.mode,
        pendingFallbackReason: pendingCursorState.fallbackReason,
        pendingFallbackDetail: pendingCursorState.fallbackDetail,
        loading: {
          formal: false,
          temp: false,
          pendingLink: pendingCursorState.loading,
        },
        // reserve for future pagination/cursor extension per source
        nextCursor: {
          formal: null,
          temp: null,
          pendingLink: pendingCursorState.nextCursor,
        },
      },
    };
  }

  function filterByView(entries) {
    if (activeView === "all") return entries;
    if (activeView === "records") return entries.filter((entry) => entry.sourceType === "formal" || entry.sourceType === "temp");
    if (activeView === "formal") return entries.filter((entry) => entry.sourceType === "formal");
    if (activeView === "temp") return entries.filter((entry) => entry.sourceType === "temp");
    if (activeView === "pending") return entries.filter((entry) => entry.sourceType === "pending_link");
    return entries;
  }

  function getCounts(entries) {
    return {
      all: entries.length,
      records: entries.filter((entry) => entry.sourceType === "formal" || entry.sourceType === "temp").length,
      formal: entries.filter((entry) => entry.sourceType === "formal").length,
      temp: entries.filter((entry) => entry.sourceType === "temp").length,
      pending: entries.filter((entry) => entry.sourceType === "pending_link").length,
    };
  }

  function normalizeKeyword(value) {
    return String(value || "").trim().toLowerCase();
  }

  function highlightByKeyword(value, keyword) {
    const raw = String(value ?? "");
    const normalized = normalizeKeyword(keyword);
    if (!normalized) return esc(raw);
    const lowerRaw = raw.toLowerCase();
    const hitAt = lowerRaw.indexOf(normalized);
    if (hitAt < 0) return esc(raw);
    const endAt = hitAt + normalized.length;
    const before = esc(raw.slice(0, hitAt));
    const hit = esc(raw.slice(hitAt, endAt));
    const after = esc(raw.slice(endAt));
    return `${before}<mark class="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 rounded px-0.5">${hit}</mark>${after}`;
  }

  function buildSearchInfo(entry, keyword) {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!normalizedKeyword) {
      return {
        matched: true,
        score: 0,
        reasons: ["browse"],
        reasonLabels: ["默认排序"],
        hitItems: [],
      };
    }

    const payload = entry.payload || {};
    const summaryText = String(payload.summary || payload.merchant || "").toLowerCase();
    const dateText = normalizeDateStr(payload.date || payload.billDate || payload.uploadedAt || payload.updatedAt || "").toLowerCase();
    const amountText = payload.amount != null ? String(payload.amount).toLowerCase() : "";
    const voucherLabel = entry.sourceType === "pending_link"
      ? getVoucherLabel(payload.storagePath || payload.legacyDriveId || payload.id || "")
      : getVoucherLabel((payload.voucherStoragePaths || payload.voucherPaths || [])[0] || "");
    const voucherText = String(voucherLabel || "").toLowerCase() + " " + String(payload.storagePath || payload.id || "").toLowerCase();
    const statusText = String(entry.statusText || payload.lifecycleState || "").toLowerCase();
    const sourceText = String(payload.source || payload.category || payload.pendingReason || "").toLowerCase();

    let score = 0;
    const reasons = [];
    const hitItems = [];

    if (amountText && amountText.includes(normalizedKeyword)) {
      score += 45;
      reasons.push("amount");
      hitItems.push(`金额 ${amountText}`);
    }
    if (dateText && dateText.includes(normalizedKeyword)) {
      score += 35;
      reasons.push("date");
      hitItems.push(`日期 ${dateText}`);
    }
    if (summaryText && summaryText.includes(normalizedKeyword)) {
      score += 30;
      reasons.push("summary");
      hitItems.push(`摘要 ${payload.summary || payload.merchant || "-"}`);
    }
    if (voucherText && voucherText.includes(normalizedKeyword)) {
      score += 25;
      reasons.push("voucher");
      hitItems.push(`凭证 ${voucherLabel || payload.storagePath || payload.id || "-"}`);
    }
    if (sourceText && sourceText.includes(normalizedKeyword)) {
      score += 18;
      reasons.push("source");
    }
    if (statusText && statusText.includes(normalizedKeyword)) {
      score += 10;
      reasons.push("status");
    }

    const reasonLabels = {
      amount: "金额命中",
      date: "日期命中",
      summary: "摘要/关键词命中",
      voucher: "凭证标识命中",
      source: "来源文本命中",
      status: "状态命中",
      browse: "默认排序",
      weak: "弱命中",
    };
    const normalizedReasons = reasons.length ? reasons : ["weak"];
    return {
      matched: score > 0,
      score,
      reasons: normalizedReasons,
      reasonLabels: normalizedReasons.map((item) => reasonLabels[item] || "弱命中"),
      hitItems,
    };
  }

  function sortEntries(entries, keyword) {
    const toSortMillis = (value) => {
      if (!value) return 0;
      if (typeof value === "number") return value;
      if (value instanceof Date) return value.getTime();
      if (typeof value === "object" && typeof value.seconds === "number") return value.seconds * 1000;
      const ms = Date.parse(String(value));
      return Number.isFinite(ms) ? ms : 0;
    };
    const normalizedKeyword = normalizeKeyword(keyword);
    return [...entries].sort((left, right) => {
      const leftInfo = buildSearchInfo(left, normalizedKeyword);
      const rightInfo = buildSearchInfo(right, normalizedKeyword);
      if (normalizedKeyword && rightInfo.score !== leftInfo.score) {
        return rightInfo.score - leftInfo.score;
      }
      return toSortMillis(right.updatedAt) - toSortMillis(left.updatedAt);
    });
  }

  function renderActions(entry) {
    if (entry.sourceType === "formal") {
      return `
        <button data-global-action="detail" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">查看详情</button>
        <button data-global-action="done" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-amber-200 text-[11px] text-amber-700 dark:text-amber-300">标记完成</button>`;
    }
    if (entry.sourceType === "temp") {
      return `
        <button data-global-action="detail" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">查看详情</button>
        <button data-global-action="promote" data-entry-id="${entry.entryId}" class="py-2 rounded-lg bg-teal-600 text-white text-[11px] font-medium">转正</button>
        <button data-global-action="done" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-amber-200 text-[11px] text-amber-700 dark:text-amber-300">标记完成</button>`;
    }
    return `
      <button data-global-action="detail" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">查看详情</button>
      <button data-global-action="relink" data-entry-id="${entry.entryId}" class="py-2 rounded-lg bg-teal-600 text-white text-[11px] font-medium">重新关联</button>
      <button data-global-action="done" data-entry-id="${entry.entryId}" class="py-2 rounded-lg border border-amber-200 text-[11px] text-amber-700 dark:text-amber-300">忽略/完成</button>`;
  }

  function renderCard(entry, keyword) {
    const payload = entry.payload || {};
    const searchInfo = buildSearchInfo(entry, keyword);
    const amount = payload.amount != null ? `¥${fmtAmt(payload.amount)}` : "--";
    const dateValue = normalizeDateStr(payload.date || payload.billDate || payload.uploadedAt || payload.updatedAt || "");
    const title = entry.sourceType === "pending_link"
      ? getVoucherLabel(payload.storagePath || payload.legacyDriveId || payload.id || "")
      : (payload.summary || "无摘要");
    const hitAmount = searchInfo.reasons.includes("amount");
    const hitDate = searchInfo.reasons.includes("date");
    const hitTitle = searchInfo.reasons.includes("summary") || searchInfo.reasons.includes("voucher");
    const actionCount = entry.sourceType === "temp" ? 3 : 2;

    const hitChips = searchInfo.reasonLabels.map((label, idx) => {
      const reasonCode = searchInfo.reasons[idx] || "weak";
      return `<span data-hit-tag="${esc(reasonCode)}" class="px-2 py-0.5 rounded-full text-[10px] bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">${esc(label)}</span>`;
    }).join("");
    const hitItems = searchInfo.hitItems.slice(0, 2).map((item) =>
      `<span class="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">${highlightByKeyword(item, keyword)}</span>`
    ).join("");

    return `
      <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">${entry.sourceType}</span>
              <span class="text-[10px] text-gray-400">${esc(entry.statusText || "--")}</span>
              <span class="text-[10px] ${hitDate ? "text-amber-700 dark:text-amber-300 font-medium" : "text-gray-400"}" data-hit-field="date">${dateValue ? highlightByKeyword(dateValue, keyword) : "--"}</span>
            </div>
            <p class="text-sm font-medium ${hitTitle ? "text-amber-700 dark:text-amber-300" : "text-gray-800 dark:text-gray-200"} mt-2 break-words" data-hit-field="title">${highlightByKeyword(title, keyword)}</p>
            <div class="flex flex-wrap gap-1 mt-1" data-hit-reasons="${esc(searchInfo.reasonLabels.join(" | "))}">
              ${hitChips}
            </div>
            ${hitItems ? `<div class="flex flex-wrap gap-1 mt-1 text-[10px]">${hitItems}</div>` : ""}
            <p class="text-[10px] text-gray-400 mt-1">金额：<span data-hit-field="amount" class="${hitAmount ? "text-amber-700 dark:text-amber-300 font-medium" : ""}">${highlightByKeyword(amount, keyword)}</span> · 最近更新：${formatReviewTime(entry.updatedAt)}</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[10px] text-gray-400">score</p>
            <p class="text-xs font-medium text-gray-700 dark:text-gray-200">${searchInfo.score}</p>
          </div>
        </div>
        <div class="grid ${actionCount === 3 ? "grid-cols-3" : "grid-cols-2"} gap-2 mt-3">
          ${renderActions(entry)}
        </div>
      </div>`;
  }

  async function handleAction(entry, action) {
    if (entry.sourceType === "formal") {
      if (action === "detail") return showTxDetail(entry.payload);
      if (action === "done") {
        await updateTransaction(entry.payload.id, {
          difficultyState: "done",
          difficultyDoneReason: DIFFICULTY_DONE_MARKER,
          decisionSource: "manual",
          decisionNote: buildAuditNote(entry.payload.decisionNote, "global investigation mark done"),
        });
        formalCacheRecords = null;
        showToast("已标记为完成", "success");
        return renderCenter();
      }
    }

    if (entry.sourceType === "temp") {
      if (action === "detail") {
        return openTempEditDialog(entry.payload, async () => {
          tempCacheRecords = null;
          await renderCenter();
        });
      }
      if (action === "promote") {
        return openTempPromotionReview(entry.payload, async () => {
          formalCacheRecords = null;
          tempCacheRecords = null;
          await renderCenter();
        });
      }
      if (action === "done") {
        await updateTransaction(entry.payload.id, {
          difficultyState: "done",
          difficultyDoneReason: DIFFICULTY_DONE_MARKER,
          decisionSource: "manual",
          decisionNote: buildAuditNote(entry.payload.decisionNote, "global investigation mark done"),
        });
        tempCacheRecords = null;
        showToast("已标记为完成", "success");
        return renderCenter();
      }
    }

    if (entry.sourceType === "pending_link") {
      if (action === "detail") return openPendingVoucherInspector(entry.payload);
      if (action === "relink") {
        return openVoucherRelinkPicker(entry.payload, async () => {
          removePendingVoucherFromState(entry.payload);
          await renderCenter();
        });
      }
      if (action === "done") {
        await markVoucherDifficultyDone({
          voucherId: entry.payload.id,
          storagePath: entry.payload.storagePath,
          decisionNote: "global investigation mark done",
          difficultyDoneReason: DIFFICULTY_DONE_MARKER,
        });
        showToast("已标记为完成", "success");
        return renderCenter();
      }
    }
  }

  function renderViewFilter(filterKey, label, count) {
    const active = activeView === filterKey;
    return `<button data-global-view="${filterKey}" class="rounded-xl px-2 py-2 text-[10px] border ${active ? "bg-purple-600 border-purple-600 text-white" : "border-gray-200 dark:border-gray-700 text-gray-500"}">
      <span class="block font-medium">${label}</span>
      <span class="block mt-0.5">${count}</span>
    </button>`;
  }

  function renderLoadMoreButton(sourceType, label, scope) {
    const sourceKey = sourceType === "pending" ? "pendingLink" : sourceType;
    const canLoad = Boolean(scope?.canLoadMore?.[sourceKey]);
    const isLoading = Boolean(scope?.loading?.[sourceKey]);
    const isPending = sourceKey === "pendingLink";
    const pendingMode = isPending
      ? (scope?.pendingMode === "fallback-step" ? "fallback-step" : "cursor")
      : "limit";
    const requested = scope?.requested?.[sourceKey] ?? 0;
    const loaded = scope?.loaded?.[sourceKey] ?? 0;
    const step = scope?.steps?.[sourceKey] ?? 0;
    const max = scope?.max?.[sourceKey] ?? requested;
    const next = scope?.nextStep?.[sourceKey];
    const loadState = isLoading ? "loading" : (canLoad ? "ready" : "no_more");
    const disabled = isLoading || !canLoad;
    const modeText = isPending
      ? (pendingMode === "fallback-step" ? "fallback-step 降级" : "cursor 正常")
      : "limit 扩展";
    const titleText = loadState === "loading"
      ? `${label} 加载中`
      : (loadState === "no_more"
        ? `${label} 已无更多`
        : `${label} +${step}`);
    const stateText = loadState === "loading"
      ? "loading..."
      : (loadState === "no_more"
        ? "no more"
        : `next -> ${next}`);
    const statusClass = isPending && pendingMode === "fallback-step"
      ? (disabled
        ? "border-amber-200 text-amber-700 dark:text-amber-300 bg-amber-50/70 dark:bg-amber-950/30 opacity-60 cursor-not-allowed"
        : "border-amber-200 text-amber-700 dark:text-amber-300 bg-amber-50/70 dark:bg-amber-950/30")
      : (disabled
        ? "border-gray-200 dark:border-gray-700 text-gray-400 opacity-60 cursor-not-allowed"
        : "border-teal-200 text-teal-700 dark:text-teal-300 bg-teal-50/60 dark:bg-teal-950/30");
    return `<button data-global-load-more="${sourceType}" ${disabled ? "disabled" : ""}
      data-load-state="${loadState}" data-load-mode="${isPending ? pendingMode : "limit"}"
      class="rounded-xl border px-2 py-2 text-[10px] transition ${statusClass}">
        <span class="block font-medium">${titleText}${isPending ? ` (${modeText})` : ""}</span>
        <span class="block mt-0.5">loaded ${loaded} / req ${requested} / max ${max}</span>
        <span class="block mt-0.5 text-[9px]" data-loadmore-state-text>${stateText}</span>
      </button>`;
  }

  function renderPendingModeNote(scope) {
    const isFallback = scope?.pendingMode === "fallback-step";
    const modeText = isFallback ? "mode fallback-step" : "mode cursor";
    const loaded = Number(scope?.loaded?.pendingLink || 0);
    const hasMore = Boolean(scope?.canLoadMore?.pendingLink);
    const sessionText = scope?.pendingSessionRestored
      ? "会话恢复：沿用上次已加载状态"
      : "当前会话：按当前模式加载";
    let reasonText = "正常分页：nextCursor";
    if (isFallback) {
      const reason = String(scope?.pendingFallbackReason || "").toLowerCase();
      if (reason === "index_missing") {
        reasonText = "已降级：索引缺失（fallback-step）";
      } else if (reason === "cursor_query_failed") {
        reasonText = "已降级：cursor 查询失败（fallback-step）";
      } else {
        reasonText = "已降级：cursor fallback-step";
      }
    }
    const stateText = loaded <= 0
      ? "当前 pending_link 池为空"
      : (hasMore ? "仍可继续加载" : "已无更多可加载");
    return `<div id="global-pending-mode-note" class="mb-2 rounded-xl px-3 py-2 text-[10px] ${isFallback ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" : "bg-teal-50 text-teal-700 dark:bg-teal-950/30 dark:text-teal-300"}">
      <span class="font-medium">${modeText}</span>
      <span class="ml-1">${esc(reasonText)}</span>
      <span class="ml-1">· ${esc(stateText)}</span>
      <span class="ml-1">· ${esc(sessionText)}</span>
    </div>`;
  }

  async function renderCenter() {
    const prevListEl = overlay.querySelector("#global-center-list");
    if (prevListEl) {
      restoreScrollTop = toNonNegativeInt(prevListEl.scrollTop, restoreScrollTop);
    }
    const { entries, scope } = await loadEntries();
    const counts = getCounts(entries);
    const viewedEntries = filterByView(entries);
    const keyword = normalizeKeyword(searchKeyword);
    const rawKeyword = String(searchKeyword || "").trim();
    const filtered = viewedEntries.filter((entry) => buildSearchInfo(entry, keyword).matched);
    const orderedEntries = sortEntries(filtered, keyword);

    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">全局排查中心</h2>
            <p class="text-xs text-gray-400 mt-1">入口来源：${esc(sourceEntry)} · 同中心不同默认视角</p>
          </div>
          <button id="global-center-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
        </div>
        <div class="grid grid-cols-5 gap-2 mb-3">
          ${renderViewFilter("all", "全部", counts.all)}
          ${renderViewFilter("records", "记录", counts.records)}
          ${renderViewFilter("formal", "formal", counts.formal)}
          ${renderViewFilter("temp", "temp", counts.temp)}
          ${renderViewFilter("pending", "pending", counts.pending)}
        </div>
        <div class="mb-3">
          <input id="global-center-search" value="${esc(searchKeyword)}"
            placeholder="搜索金额 / 日期 / 摘要 / 凭证标识"
            class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200" />
        </div>
        <div id="global-scope-hint" class="mb-2 rounded-xl bg-gray-50 dark:bg-gray-800 px-3 py-2 text-[10px] text-gray-500">
          Scope: formal loaded ${scope.loaded.formal}/${scope.requested.formal} (base ${scope.base.formal}, max ${scope.max.formal}),
          temp loaded ${scope.loaded.temp}/${scope.requested.temp} (base ${scope.base.temp}, max ${scope.max.temp}),
          pending_link loaded ${scope.loaded.pendingLink}/${scope.requested.pendingLink} (page ${scope.steps.pendingLink}, mode ${scope.pendingMode === "fallback-step" ? "fallback-step" : "cursor"})${scope.pendingSessionRestored ? " · session-restored" : ""}
        </div>
        ${renderPendingModeNote(scope)}
        <div id="global-scope-loadmore" class="grid grid-cols-3 gap-2 mb-2">
          ${renderLoadMoreButton("formal", "formal", scope)}
          ${renderLoadMoreButton("temp", "temp", scope)}
          ${renderLoadMoreButton("pending", "pending", scope)}
        </div>
        <p class="text-[10px] text-gray-400 mb-3">${scope.pendingSessionRestored
          ? "当前结果基于已加载范围（含会话恢复状态，未自动整表重拉）。pending_link 优先 nextCursor 追加，cursor 失败时降级 fallback-step。"
          : "当前结果基于已加载范围。pending_link 优先 nextCursor 追加加载，若 cursor 查询失败自动降级为 fallback-step；formal/temp 仍为原有 limit 扩展。"}
        </p>
        <div id="global-center-list" class="space-y-2 max-h-[58vh] overflow-y-auto">
          ${orderedEntries.length
            ? orderedEntries.map((entry) => renderCard(entry, keyword)).join("")
            : `<div class="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center">
                 <p class="text-sm text-gray-500">${rawKeyword ? "没有命中结果" : "当前条件下没有命中结果"}</p>
                 <p class="text-xs text-gray-400 mt-1">${rawKeyword ? `未命中“${esc(rawKeyword)}”，可清空关键词或切换视角继续排查` : "可切换视角或更换关键词继续排查"}</p>
               </div>`}
        </div>
      </div>`;

    const closeCenter = () => {
      saveSessionState();
      overlay.remove();
    };
    overlay.querySelector("#global-center-close")?.addEventListener("click", closeCenter);
    if (!overlayOutsideCloseBound) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeCenter();
      });
      overlayOutsideCloseBound = true;
    }

    const listEl = overlay.querySelector("#global-center-list");
    if (listEl && restoreScrollTop > 0) {
      listEl.scrollTop = restoreScrollTop;
    }
    listEl?.addEventListener("scroll", () => {
      restoreScrollTop = toNonNegativeInt(listEl.scrollTop, 0);
    }, { passive: true });

    overlay.querySelectorAll("[data-global-view]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        activeView = btn.dataset.globalView || "all";
        saveSessionState();
        await renderCenter();
      });
    });

    overlay.querySelector("#global-center-search")?.addEventListener("input", async (event) => {
      searchKeyword = event.target.value || "";
      saveSessionState();
      await renderCenter();
    });

    overlay.querySelectorAll("[data-global-load-more]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.hasAttribute("disabled")) return;
        btn.setAttribute("disabled", "disabled");
        btn.setAttribute("data-load-state", "loading");
        const stateTextEl = btn.querySelector("[data-loadmore-state-text]");
        if (stateTextEl) stateTextEl.textContent = "loading...";
        const sourceType = btn.dataset.globalLoadMore || "all";
        if (sourceType === "pending") {
          await loadPendingCursorPage();
          saveSessionState();
          await renderCenter();
          return;
        }
        expandScope(sourceType);
        saveSessionState();
        await renderCenter();
      });
    });

    overlay.querySelectorAll("[data-global-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entry = orderedEntries.find((item) => item.entryId === btn.dataset.entryId);
        if (!entry) return;
        saveSessionState();
        await handleAction(entry, btn.dataset.globalAction);
      });
    });
    saveSessionState();
  }

  try {
    await renderCenter();
  } catch (err) {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5 text-center">
        <p class="text-sm text-red-500">加载全局排查中心失败</p>
        <p class="text-xs text-gray-400 mt-2">${esc(err.message)}</p>
      </div>`;
  }
}
async function openDifficultyCenter() {
  const overlay = createModalOverlay();
  document.getElementById("app-root").appendChild(overlay);
  let activeFilter = "all";
  let searchKeyword = "";

  async function loadEntries() {
    const [pendingVouchers, tempRecords, formalRecords] = await Promise.all([
      fetchPendingVouchers({ limit: 100 }),
      fetchTempTransactions({ limit: 100 }),
      fetchLedger({ limit: 300 }),
    ]);

    const dedupePairs = findDuplicatePairs(
      formalRecords.filter((tx) => !tx?._deleted && tx.recordBucket !== "temp"),
      { maxPairs: 12 },
    );

    return [
      ...pendingVouchers.map((voucher) => ({ ...voucher, kind: "voucher", entryId: `voucher:${voucher.id}` })),
      ...tempRecords.filter((tx) => !tx?._deleted).map((tx) => ({ ...tx, kind: "temp", entryId: `temp:${tx.id}` })),
      ...dedupePairs.map((pair) => ({
        ...pair,
        kind: "dedupe",
        entryId: `dedupe:${pair.left?.id}:${pair.right?.id}`,
        updatedAt: pair.left?.lastReviewedAt || pair.right?.lastReviewedAt || pair.left?.updatedAt || pair.right?.updatedAt || null,
      })),
    ].filter(isDifficult);
  }

  async function renderCenter() {
    const entries = await loadEntries();
    const filteredByType = entries.filter((entry) => {
      if (activeFilter === "all") return true;
      return getDifficultyMeta(entry)?.filterKey === activeFilter;
    });
    const visibleEntries = filteredByType.filter((entry) => matchesDifficultySearch(entry, searchKeyword));

    const counts = {
      matching: entries.filter((entry) => getDifficultyMeta(entry)?.filterKey === "matching").length,
      dedupe: entries.filter((entry) => getDifficultyMeta(entry)?.filterKey === "dedupe").length,
      temp: entries.filter((entry) => getDifficultyMeta(entry)?.filterKey === "temp").length,
    };

    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">难度处理</h2>
            <p class="text-xs text-gray-400 mt-1">只做逻辑聚合，不移动原有 pending / temp / 去重结构"/p>
          </div>
          <button id="difficulty-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
        </div>
        <div class="grid grid-cols-4 gap-2 mb-3">
          ${renderDifficultyFilter("all", "全部", entries.length, activeFilter)}
          ${renderDifficultyFilter("matching", "匹配困难", counts.matching, activeFilter)}
          ${renderDifficultyFilter("dedupe", "去重困难", counts.dedupe, activeFilter)}
          ${renderDifficultyFilter("temp", "临时未处", counts.temp, activeFilter)}
        </div>
        <div class="mb-3">
          <input id="difficulty-search" value="${esc(searchKeyword)}"
            placeholder="搜索金额 / 日期 / 摘要 / 凭证标识"
            class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200" />
        </div>
        <div id="difficulty-list" class="space-y-2 max-h-[58vh] overflow-y-auto">
          ${visibleEntries.length
            ? visibleEntries.map((entry) => renderDifficultyCard(entry)).join("")
            : `<div class="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center">
                 <p class="text-sm text-gray-500">当前筛选下没有待处理项</p>
                 <p class="text-xs text-gray-400 mt-1">先按类型筛选，再用搜索词做二次过滤"/p>
               </div>`}
        </div>
      </div>`;

    overlay.querySelector("#difficulty-close")?.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    }, { once: true });

    overlay.querySelectorAll("[data-difficulty-filter]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        activeFilter = btn.dataset.difficultyFilter;
        await renderCenter();
      });
    });

    overlay.querySelector("#difficulty-search")?.addEventListener("input", async (event) => {
      searchKeyword = event.target.value || "";
      await renderCenter();
    });

    overlay.querySelectorAll("[data-difficulty-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entry = entries.find((item) => item.entryId === btn.dataset.entryId);
        if (!entry) return;
        await handleDifficultyAction(entry, btn.dataset.difficultyAction, renderCenter);
      });
    });
  }

  try {
    await renderCenter();
  } catch (err) {
    overlay.innerHTML = `
      <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5 text-center">
        <p class="text-sm text-red-500">加载难度处理中心失败</p>
        <p class="text-xs text-gray-400 mt-2">${esc(err.message)}</p>
      </div>`;
  }
}

function renderDifficultyFilter(filterKey, label, count, activeFilter) {
  const active = filterKey === activeFilter;
  return `
    <button data-difficulty-filter="${filterKey}" class="rounded-xl px-2 py-2 text-[10px] border ${active ? "bg-purple-600 border-purple-600 text-white" : "border-gray-200 dark:border-gray-700 text-gray-500"}">
      <span class="block font-medium">${label}</span>
      <span class="block mt-0.5">${count}</span>
    </button>`;
}

function renderDifficultyCard(entry) {
  const meta = getDifficultyMeta(entry);
  if (!meta) return "";

  const title = entry.kind === "voucher"
    ? getVoucherLabel(entry.storagePath || entry.legacyDriveId || entry.id)
    : entry.kind === "temp"
      ? (entry.summary || "无摘")
      : `${entry.left?.summary || "无摘"} / ${entry.right?.summary || "无摘"}`;

  const actionButtons = [];
  if (entry.kind === "voucher") {
    actionButtons.push(renderDifficultyAction(entry.entryId, "relink", "重新关联", "bg-teal-600 text-white"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "detail", "查看详情", "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "done", "标记完成", "border border-amber-200 text-amber-700 dark:text-amber-300"));
  } else if (entry.kind === "temp") {
    actionButtons.push(renderDifficultyAction(entry.entryId, "promote", "转正", "bg-teal-600 text-white"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "detail", "查看详情", "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "done", "标记完成", "border border-amber-200 text-amber-700 dark:text-amber-300"));
  } else {
    actionButtons.push(renderDifficultyAction(entry.entryId, "detail", "对比详情", "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "view-left", "查看A", "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "view-right", "查看B", "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"));
    actionButtons.push(renderDifficultyAction(entry.entryId, "done", "忽略 / 完成", "border border-amber-200 text-amber-700 dark:text-amber-300"));
  }

  const gridColsClass = actionButtons.length >= 4
    ? "grid-cols-2"
    : actionButtons.length === 3
      ? "grid-cols-3"
      : "grid-cols-2";

  return `
    <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">${meta.sourceType}</span>
            <span class="text-[10px] text-gray-400">${meta.statusText}</span>
          </div>
          <p class="text-sm font-medium text-gray-800 dark:text-gray-200 mt-2 break-words">${esc(title)}</p>
          <p class="text-[10px] text-gray-400 mt-1">难度原因"{esc(meta.reasonText)}</p>
          <p class="text-[10px] text-gray-400 mt-1">最近操作：${formatReviewTime(meta.updatedAt)}</p>
        </div>
      </div>
      <div class="grid ${gridColsClass} gap-2 mt-3">
        ${actionButtons.join("")}
      </div>
    </div>`;
}

function renderDifficultyAction(entryId, action, label, classes) {
  return `<button data-entry-id="${entryId}" data-difficulty-action="${action}" class="py-2 rounded-lg text-[11px] font-medium ${classes}">${label}</button>`;
}

async function handleDifficultyAction(entry, action, onRefresh) {
  if (entry.kind === "voucher") {
    if (action === "relink") return openVoucherRelinkPicker(entry, onRefresh);
    if (action === "detail") return openPendingVoucherInspector(entry);
    if (action === "done") {
      await markVoucherDifficultyDone({
        voucherId: entry.id,
        storagePath: entry.storagePath,
        decisionNote: "difficulty center mark done",
        difficultyDoneReason: DIFFICULTY_DONE_MARKER,
      });
      showToast("已标记为完成", "success");
      return onRefresh();
    }
  }

  if (entry.kind === "temp") {
    if (action === "promote") return openTempPromotionReview(entry, onRefresh);
    if (action === "detail") return openTempEditDialog(entry, onRefresh);
    if (action === "done") {
      await updateTransaction(entry.id, {
        difficultyState: "done",
        difficultyDoneReason: DIFFICULTY_DONE_MARKER,
        decisionSource: "manual",
        decisionNote: buildAuditNote(entry.decisionNote, "difficulty center mark done"),
      });
      showToast("已标记为完成", "success");
      return onRefresh();
    }
  }

  if (entry.kind === "dedupe") {
    if (action === "detail") return openDedupeDifficultyDetail(entry);
    if (action === "view-left") return showTxDetail(entry.left);
    if (action === "view-right") return showTxDetail(entry.right);
    if (action === "done") {
      return openDedupeDoneDialog(entry, onRefresh);
    }
  }
}
function openDedupeDoneDialog(entry, onRefresh) {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">???????</h2>
          <p class="text-xs text-gray-400 mt-1">???????????????? difficultyDoneReason?</p>
        </div>
        <button id="dedupe-done-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">?</button>
      </div>
      <div class="space-y-3">
        <div>
          <label for="dedupe-done-reason" class="text-[11px] text-gray-500 block mb-1">????</label>
          <select id="dedupe-done-reason"
            class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200">
            ${DEDUPE_DONE_REASON_OPTIONS.map((reasonCode) => `<option value="${reasonCode}">${getDedupeDoneReasonLabel(reasonCode)}</option>`).join("")}
          </select>
        </div>
        <div id="dedupe-done-note-wrap" class="hidden">
          <label for="dedupe-done-note" class="text-[11px] text-gray-500 block mb-1">????</label>
          <textarea id="dedupe-done-note" rows="3"
            class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-200"
            placeholder="????????? other"></textarea>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-4">
        <button id="dedupe-done-cancel" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500">??</button>
        <button id="dedupe-done-confirm" class="py-2 rounded-lg bg-teal-600 text-white text-xs font-medium">????</button>
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#dedupe-done-close")?.addEventListener("click", close);
  overlay.querySelector("#dedupe-done-cancel")?.addEventListener("click", close);

  const reasonSelect = overlay.querySelector("#dedupe-done-reason");
  const noteWrap = overlay.querySelector("#dedupe-done-note-wrap");
  const noteInput = overlay.querySelector("#dedupe-done-note");
  const confirmBtn = overlay.querySelector("#dedupe-done-confirm");
  if (!reasonSelect || !noteWrap || !noteInput || !confirmBtn) return;

  const refreshOtherInput = () => {
    noteWrap.classList.toggle("hidden", reasonSelect.value !== "other");
  };
  reasonSelect.addEventListener("change", refreshOtherInput);
  refreshOtherInput();

  confirmBtn.addEventListener("click", async () => {
    const doneReason = reasonSelect.value;
    const noteText = String(noteInput.value || "").trim();
    if (doneReason === "other" && !noteText) {
      showToast("?? other ????????", "info");
      return;
    }

    const auditMessage = noteText
      ? `difficulty center mark done reason=${doneReason} note=${noteText}`
      : `difficulty center mark done reason=${doneReason}`;

    confirmBtn.disabled = true;
    confirmBtn.textContent = "???...";
    try {
      await Promise.all([
        updateTransaction(entry.left.id, {
          difficultyState: "done",
          difficultyDoneReason: doneReason,
          decisionSource: "manual",
          decisionNote: buildAuditNote(entry.left.decisionNote, auditMessage),
        }),
        updateTransaction(entry.right.id, {
          difficultyState: "done",
          difficultyDoneReason: doneReason,
          decisionSource: "manual",
          decisionNote: buildAuditNote(entry.right.decisionNote, auditMessage),
        }),
      ]);
      close();
      showToast("??????", "success");
      if (typeof onRefresh === "function") await onRefresh();
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "????";
      showToast(`?????${err.message}`, "error");
    }
  });
}

function openDedupeDifficultyDetail(entry) {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">去重困难详情</h2>
        <button id="dedupe-detail-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="space-y-3">
        <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-3">
          <p class="text-[10px] text-gray-400">难度原因</p>
          <p class="text-xs text-gray-700 dark:text-gray-200 mt-1">${esc(summarizeDuplicateReasons(entry.reasons, entry.score || 0))}</p>
        </div>
        ${renderDuplicateTxCard("A", entry.left)}
        ${renderDuplicateTxCard("B", entry.right)}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-4">
        <button id="dedupe-open-left" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300">查看A详情</button>
        <button id="dedupe-open-right" class="py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300">查看B详情</button>
      </div>
    </div>`;
  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#dedupe-detail-close")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dedupe-open-left")?.addEventListener("click", () => showTxDetail(entry.left));
  overlay.querySelector("#dedupe-open-right")?.addEventListener("click", () => showTxDetail(entry.right));
}
function openDeduplication() {
  const overlay = createModalOverlay();
  const activeTransactions = getFormalTransactions().filter((tx) => !tx?._deleted && tx.status !== "已删");
  const pairs = findDuplicatePairs(activeTransactions);
  const highCount = pairs.filter((pair) => pair.level === "high").length;
  const mediumCount = pairs.filter((pair) => pair.level === "medium").length;

  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">去重比较</h2>
          <p class="text-xs text-gray-400 mt-1">当前范围：已加载月份，排除已删除账目。只提醒，不自动处理"/p>
        </div>
        <button id="dedupe-close"
          class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="rounded-xl bg-gray-50 dark:bg-gray-800 px-3 py-2.5 text-xs text-gray-500 mb-3">
        <span class="text-red-500 font-medium">高疑"${highCount}</span>
        <span class="mx-2 text-gray-300">|</span>
        <span class="text-amber-500 font-medium">中疑"${mediumCount}</span>
      </div>
      <div id="dedupe-results" class="space-y-2 max-h-[55vh] overflow-y-auto">
        ${pairs.length
          ? pairs.map((pair, index) => renderDuplicatePair(pair, index + 1)).join("")
          : `<div class="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center">
               <p class="text-sm text-gray-500">当前月份未发现明显重复对</p>
               <p class="text-xs text-gray-400 mt-1">后续可以在这里继续接入跨库搜索、人工裁定和留痕"/p>
             </div>`}
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#dedupe-close")?.addEventListener("click", () => overlay.remove());
}

function renderDuplicatePair(pair, order) {
  const badgeClass = pair.level === "high"
    ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300"
    : "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300";
  const reasons = pair.reasons?.length
    ? summarizeDuplicateReasons(pair.reasons, pair.score || 0)
    : "多维相似";

  return `
    <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-[10px] text-gray-400">候"${order}</span>
        <span class="px-2 py-0.5 rounded-full text-[10px] font-medium ${badgeClass}">
          ${pair.level === "high" ? "高疑" : "中疑"} · ${pair.score}"        </span>
      </div>
      <div class="space-y-2">
        ${renderDuplicateTxCard("A", pair.left)}
        ${renderDuplicateTxCard("B", pair.right)}
      </div>
      <p class="text-[10px] text-gray-400 mt-2">${esc(reasons)}</p>
    </div>`;
}

function renderDuplicateTxCard(tag, tx) {
  return `
    <div class="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[10px] text-gray-400">${tag}</span>
        <span class="${tx.type === "收入" ? "text-teal-600" : "text-orange-600"} text-xs font-medium">
          ${tx.type === "收入" ? "+" : "-"}"{fmtAmt(tx.amount)}
        </span>
      </div>
      <p class="text-xs font-medium text-gray-800 dark:text-gray-200 mt-1">${esc(tx.summary || "无摘")}</p>
      <p class="text-[10px] text-gray-400 mt-1">${normalizeDateStr(tx.date)} · ${esc(tx.category || "未分")} · ${esc(tx.source || "--")}</p>
    </div>`;
}

function formatDuplicateReason(reason) {
  const map = {
    same_type: "同类",
    same_category: "同分",
    same_month: "同月",
    exact_amount_same_day: "同日同金",
    exact_amount: "同金",
    close_amount_same_day: "近似金额同日",
    same_summary: "摘要一",
  };
  return map[reason] || "相似";
}

function openUnbindVoucherPicker(tx, voucherPaths, detailOverlay) {
  const picker = createModalOverlay();
  picker.className = "absolute inset-0 bg-black/50 z-40 flex items-end justify-center pb-0";
  picker.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-t-2xl mx-4 w-full max-w-sm p-5 max-h-[78vh] overflow-hidden">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">精准解绑</h2>
          <p class="text-xs text-gray-400 mt-1">选择要从当前账目解绑的凭证。解绑后图片会回到待匹配状态"/p>
        </div>
        <button id="unbind-picker-close" class="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400">×</button>
      </div>
      <div class="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
        ${voucherPaths.map((pathValue, index) => `
          <label class="flex items-center gap-3 rounded-xl border border-gray-100 dark:border-gray-700 px-3 py-2 cursor-pointer">
            <input type="checkbox" class="rounded text-purple-600 focus:ring-purple-400" data-unbind-path="${esc(pathValue)}">
            <img src="${FALLBACK_IMAGE_URL}" data-image-path="${esc(pathValue)}" class="w-14 h-14 rounded-lg object-cover border border-gray-100 dark:border-gray-700 flex-shrink-0">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium text-gray-800 dark:text-gray-200">凭证 ${index + 1}</p>
              <p class="text-[10px] text-gray-400 mt-1 break-all">${esc(getVoucherLabel(pathValue))}</p>
            </div>
          </label>`).join("")}
      </div>
      <div class="flex gap-2 pt-4">
        <button id="unbind-picker-cancel" class="flex-1 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500">取消</button>
        <button id="unbind-picker-confirm" class="flex-1 py-2 rounded-xl bg-amber-500 text-white text-xs font-medium disabled:opacity-50" disabled>解绑 0 "/button>
      </div>
    </div>`;

  document.getElementById("app-root").appendChild(picker);
  hydrateVoucherImages(picker);

  const closePicker = () => picker.remove();
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });
  picker.querySelector("#unbind-picker-close")?.addEventListener("click", closePicker);
  picker.querySelector("#unbind-picker-cancel")?.addEventListener("click", closePicker);

  const checkboxes = [...picker.querySelectorAll("[data-unbind-path]")];
  const confirmBtn = picker.querySelector("#unbind-picker-confirm");

  function getSelectedPaths() {
    return checkboxes.filter((input) => input.checked).map((input) => input.dataset.unbindPath);
  }

  function refreshSelectionState() {
    const selectedCount = getSelectedPaths().length;
    confirmBtn.disabled = selectedCount === 0;
    confirmBtn.textContent = `解绑 ${selectedCount} 张`;
  }

  checkboxes.forEach((input) => input.addEventListener("change", refreshSelectionState));
  refreshSelectionState();

  confirmBtn.addEventListener("click", async () => {
    const selectedPaths = getSelectedPaths();
    if (!selectedPaths.length) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = "???...";
    try {
      await unbindVouchers(tx.id, selectedPaths, {
        pendingReason: "manual_unbind",
        decisionSource: "manual",
        decisionNote: `从详情页解绑 ${selectedPaths.length} 张凭证`,
      });
      closePicker();
      detailOverlay.remove();
      showToast(`已解"${selectedPaths.length} 张凭证`, "success");
      await loadAndRender();
    } catch (err) {
      confirmBtn.disabled = false;
      refreshSelectionState();
      showToast(`?????${err.message}`, "error");
    }
  });
}

function getVoucherDisplayPaths(tx) {
  if (Array.isArray(tx.voucherStoragePaths) && tx.voucherStoragePaths.length > 0) {
    return tx.voucherStoragePaths;
  }
  if (Array.isArray(tx.voucherPaths) && tx.voucherPaths.length > 0) {
    return tx.voucherPaths;
  }
  return [];
}

function getVoucherLabel(pathValue) {
  const raw = String(pathValue || "").trim();
  if (!raw) return "未命名凭";
  const clean = raw.split("?")[0];
  const segments = clean.split("/").filter(Boolean);
  return segments[segments.length - 1] || clean;
}

async function openShadowMonitor() {
  showShadowMonitor();

  try {
    const logs = await fetchShadowLogs({ limit: 50 });
    renderShadowMonitor(logs);
  } catch (err) {
    const el = document.getElementById("shadow-monitor-log");
    if (el) el.innerHTML = `<p class="text-red-500">加载日志失败"{esc(err.message)}</p>`;
  }
}

// ── 内部工具 ──────────────────────────────────────────

function createModalOverlay() {
  const el = document.createElement("div");
  el.className = "absolute inset-0 bg-black/40 z-20 flex items-end justify-center pb-0";
  return el;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function normalizeDateStr(date) {
  if (!date) return new Date().toISOString().slice(0, 10);
  if (typeof date === "string") return date.slice(0, 10);
  if (date instanceof Date)     return date.toISOString().slice(0, 10);
  if (date.seconds)             return new Date(date.seconds * 1000).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function fmtAmt(n) {
  const num = parseFloat(n) || 0;
  return num % 1 === 0
    ? num.toLocaleString("zh-CN")
    : num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
