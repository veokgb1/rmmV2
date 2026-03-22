// v2-app/js/feature-logic.js
// 职责：核心业务逻辑、1-9 键响应、AI 调度、应用状态流转
// 依赖：js/core-config.js, js/api-bridge.js, js/ui-layout.js, js/match-engine.js
// 导出：initApp

import { APP_CONFIG, KEY_MAP, getFirebaseApp } from "./core-config.js";
import {
  submitTransaction, updateTransaction, fetchLedger,
  deleteTransaction, unbindVouchers,
  geminiOCR, geminiNLP, uploadVoucher,
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
import { findBestMatch, calculateMatchScore } from "./match-engine.js";

// ── 应用状态 ──────────────────────────────────────────
const state = {
  user:         null,
  transactions: [],
  currentYear:  new Date().getFullYear(),
  currentMonth: new Date().getMonth(),  // 0-indexed
  activeTab:    "flow",
  isLoading:    false,
};

const FALLBACK_IMAGE_URL = "/fallback.png";

// ── 入口：初始化整个应用 ──────────────────────────────

/**
 * 应用初始化（index.html 中 type="module" 调用）
 */
export async function initApp() {
  // 监听 Firebase Auth 状态
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

  // 离开页面时取消监听
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
        showToast("设置页开发中，当前先保留占位入口", "info");
      }
    });
  });

  // 双盲横幅：查看对比按钮
  document.getElementById("banner-compare-btn")?.addEventListener("click", () => {
    showToast("双盲核对：点击任意账目卡片可对比新旧凭证图片", "info", 4000);
  });

  // 月份切换
  document.getElementById("month-picker")?.addEventListener("click", openMonthPickerPanel);

  // 日历上下月按钮（动态渲染后绑定）
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
    renderCalendar(state.transactions, {
      year:  state.currentYear,
      month: state.currentMonth,
    }, () => {});
  }
  if (tabName === "stats") {
    renderStats(state.transactions);
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

// ── 数据加载与渲染 ────────────────────────────────────

async function loadAndRender() {
  if (state.isLoading) return;
  state.isLoading = true;
  setLoadingState(true);

  try {
    const monthStr = `${state.currentYear}-${String(state.currentMonth + 1).padStart(2, "0")}`;
    state.transactions = await fetchLedger({ month: monthStr, limit: 200 });
    renderLedger(state.transactions, handleTxClick);
    updateMonthLabel();
  } catch (err) {
    showToast(`加载失败：${err.message}`, "error");
    state.transactions = [];
    renderLedger(state.transactions, handleTxClick);
    updateMonthLabel();
  } finally {
    state.isLoading = false;
    setLoadingState(false);
  }
}

function updateMonthLabel() {
  const el = document.getElementById("current-month-label");
  if (el) el.textContent = `${state.currentYear}年${state.currentMonth + 1}月`;
  if (el) el.textContent = `${state.currentYear}年${state.currentMonth + 1}月`;
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
  // 简单 prompt（后续可替换为底部滚轮选择器）
  const input = prompt(
    "输入要查看的月份（格式 YYYY-MM，留空=本月）：",
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
          ${idx + 1}月
        </button>`;
    }).join("");

    panel.innerHTML = `
      <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center justify-between">
          <button data-year-nav="-1"
            class="h-8 w-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            ‹
          </button>
          <span class="text-sm font-medium text-gray-900 dark:text-gray-100">${pickerYear}年</span>
          <button data-year-nav="1"
            class="h-8 w-8 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            ›
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
  // 构建详情底部抽屉
  const voucherDisplayPaths = Array.isArray(tx.voucherStoragePaths) && tx.voucherStoragePaths.length > 0
    ? tx.voucherStoragePaths
    : (Array.isArray(tx.voucherPaths) ? tx.voucherPaths : []);
  const hasVoucher = voucherDisplayPaths.length > 0;
  const dateStr    = normalizeDateStr(tx.date);

  const overlay = document.createElement("div");
  overlay.className = "absolute inset-0 bg-black/40 z-20";
  overlay.innerHTML = `
    <div class="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900 rounded-t-2xl z-30 pb-6"
         id="tx-detail-panel">
      <div class="w-8 h-1 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto mt-3 mb-4"></div>
      <div class="px-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-lg font-medium ${tx.type === "收入" ? "text-teal-600" : "text-orange-600"}">
            ${tx.type === "收入" ? "+" : "-"}¥${fmtAmt(tx.amount)}
          </span>
          <span class="text-xs px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">${tx.status || "未关联"}</span>
        </div>
        <p class="text-base text-gray-900 dark:text-gray-100">${esc(tx.summary || "无摘要")}</p>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div><span class="text-gray-400">分类</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${esc(tx.category || "未分类")}</p></div>
          <div><span class="text-gray-400">日期</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${dateStr}</p></div>
          <div><span class="text-gray-400">来源</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${esc(tx.source || "--")}</p></div>
          <div><span class="text-gray-400">凭证数</span><p class="text-gray-700 dark:text-gray-300 mt-0.5">${voucherDisplayPaths.length || 0} 张</p></div>
        </div>
        ${hasVoucher ? renderVoucherGallery(voucherDisplayPaths, tx.legacyVoucherIds) : ""}
        <div class="flex gap-2 pt-2">
          <button data-action="unbind"
            class="flex-1 py-2 text-xs rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
            解绑凭证
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

  overlay.querySelector("[data-action=delete]").addEventListener("click", async () => {
    if (!confirm(`确认删除"${tx.summary}"？`)) return;
    try {
      await deleteTransaction(tx.id);
      showToast("已删除", "success");
      overlay.remove();
      await loadAndRender();
    } catch (err) {
      showToast(`删除失败：${err.message}`, "error");
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

// ── 1-9 键功能调度 ────────────────────────────────────

async function handleKeyAction(action) {
  switch (action) {
    case "openBatchMatching":    return openBatchMatching();
    case "openRowCorrelation":   return showToast("按行检查：筛选未关联记录...", "info");
    case "openVoucherCorrelation": return showToast("按凭证检查：扫描孤立凭证...", "info");
    case "openQuickEntry":       return openQuickEntry();
    case "openBatchText":        return openBatchText();
    case "openShadowMonitor":    return openShadowMonitor();   // ⑥ 双写监控
    case "openDeduplication":    return showToast("去重扫描功能开发中...", "info");
    case "openUnbind":           return showToast("请先点击要解绑的账目卡片", "info");
    case "openConflictCourt":    return showToast("断案法庭功能开发中...", "info");
    default:                     return showToast(`未知功能：${action}`, "warning");
  }
}

// ── 功能 ①：批量对账台 ───────────────────────────────

async function openBatchMatching() {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-4">批量对账台</h2>
      <div id="batch-drop" class="border-2 border-dashed border-gray-200 dark:border-gray-700
                                   rounded-xl p-8 text-center cursor-pointer hover:border-purple-400 transition-colors">
        <svg class="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>
        <p class="text-sm text-gray-400">点击或拖入凭证图片</p>
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
    resultsEl.innerHTML = `<p class="text-xs text-gray-400 text-center py-2">AI 识别中... (0/${files.length})</p>`;

    let done = 0;
    for (const file of files) {
      try {
        const base64  = await fileToBase64(file);
        const aiData  = await geminiOCR({ base64, mime: file.type });
        const match   = findBestMatch(aiData, state.transactions);
        done++;

        resultsEl.innerHTML += `
          <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs">
            <p class="font-medium text-gray-800 dark:text-gray-200 truncate">${esc(file.name)}</p>
            <p class="text-gray-500 mt-1">AI: ¥${aiData.amount ?? "?"} · ${esc(aiData.merchant || aiData.summary || "")}</p>
            ${match
              ? `<p class="text-teal-600 mt-1">匹配: ${esc(match.tx.summary)} (${match.score}分)</p>`
              : `<p class="text-orange-500 mt-1">未找到匹配账目</p>`}
          </div>`;

        resultsEl.querySelector("p")?.remove(); // 移除进度提示
        showToast(`已处理 ${done}/${files.length}`, "info", 1500);
      } catch (err) {
        resultsEl.innerHTML += `<p class="text-xs text-red-500">${esc(file.name)}：${err.message}</p>`;
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
        placeholder="输入一句话，例如：今天打车30，午饭15，晚上卖二手书50元"></textarea>
      <div class="flex gap-2 mt-3">
        <button id="quick-voice" class="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500">
          🎙️ 语音
        </button>
        <button id="quick-submit" class="flex-1 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors">
          AI 解析并录入
        </button>
      </div>
      <div id="quick-preview" class="mt-3 space-y-2"></div>
    </div>`;

  document.getElementById("app-root").appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  // 语音输入
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
    showToast("请说话...", "info", 3000);
  });

  overlay.querySelector("#quick-submit").addEventListener("click", async () => {
    const text = overlay.querySelector("#quick-text").value.trim();
    if (!text) return;
    const btn = overlay.querySelector("#quick-submit");
    btn.disabled = true;
    btn.textContent = "解析中...";

    try {
      const items = await geminiNLP({ text });
      const preview = overlay.querySelector("#quick-preview");
      preview.innerHTML = items.map((item, i) => `
        <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs flex items-center justify-between">
          <div>
            <span class="font-medium text-gray-800 dark:text-gray-200">${esc(item.summary)}</span>
            <span class="text-gray-400 ml-2">${esc(item.category)} · ${item.date}</span>
          </div>
          <span class="${item.type === "收入" ? "text-teal-600" : "text-orange-600"} font-medium">
            ${item.type === "收入" ? "+" : "-"}¥${item.amount}
          </span>
        </div>`).join("") +
        `<button id="quick-confirm"
           class="w-full py-2 mt-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium transition-colors">
           确认写入 ${items.length} 笔
         </button>`;

      preview.querySelector("#quick-confirm").addEventListener("click", async () => {
        for (const item of items) {
          await submitTransaction({
            date:     item.date,
            month:    (item.date || "").slice(0, 7),
            type:     item.type,
            category: item.category,
            amount:   item.amount,
            summary:  item.summary,
            source:   "快捷文本录入",
          });
        }
        showToast(`成功录入 ${items.length} 笔`, "success");
        overlay.remove();
        await loadAndRender();
      });
    } catch (err) {
      showToast(`解析失败：${err.message}`, "error");
    } finally {
      btn.disabled    = false;
      btn.textContent = "AI 解析并录入";
    }
  });
}

// ── 功能 ⑤：批量补录 ─────────────────────────────────

function openBatchText() {
  const overlay = createModalOverlay();
  overlay.innerHTML = `
    <div class="bg-white dark:bg-gray-900 rounded-2xl mx-4 w-full max-w-sm p-5">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">批量粘贴补录</h2>
      <textarea id="batch-text-input" rows="6"
        class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800
               text-sm text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-purple-400"
        placeholder="粘贴大段账单文字..."></textarea>
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
    btn.textContent = "解析中...";

    try {
      const items   = await geminiNLP({ text });
      const preview = overlay.querySelector("#batch-text-preview");

      preview.innerHTML = `<p class="text-xs text-gray-400">识别到 ${items.length} 笔记录</p>` +
        items.map((item) => `
          <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-xs">
            <div class="flex justify-between">
              <span class="font-medium text-gray-800 dark:text-gray-200">${esc(item.summary)}</span>
              <span class="${item.type === "收入" ? "text-teal-600" : "text-orange-600"}">
                ${item.type === "收入" ? "+" : "-"}¥${item.amount}
              </span>
            </div>
            <p class="text-gray-400 mt-0.5">${item.date} · ${esc(item.category)}</p>
          </div>`).join("") +
        `<button id="batch-text-confirm"
           class="w-full py-2 mt-1 rounded-xl bg-teal-600 text-white text-xs font-medium">
           全部写入 (${items.length} 笔)
         </button>`;

      preview.querySelector("#batch-text-confirm").addEventListener("click", async () => {
        for (const item of items) {
          await submitTransaction({
            date:     item.date,
            month:    (item.date || "").slice(0, 7),
            type:     item.type,
            category: item.category,
            amount:   item.amount,
            summary:  item.summary,
            source:   "批量文本录入",
          });
        }
        showToast(`成功录入 ${items.length} 笔`, "success");
        overlay.remove();
        await loadAndRender();
      });
    } catch (err) {
      showToast(`解析失败：${err.message}`, "error");
    } finally {
      btn.disabled    = false;
      btn.textContent = "AI 批量解析";
    }
  });
}

// ── 功能 ⑥：Shadow Sync Monitor（铁律二核心）────────

async function openShadowMonitor() {
  showShadowMonitor();

  try {
    const logs = await fetchShadowLogs({ limit: 50 });
    renderShadowMonitor(logs);
  } catch (err) {
    const el = document.getElementById("shadow-monitor-log");
    if (el) el.innerHTML = `<p class="text-red-500">加载日志失败：${esc(err.message)}</p>`;
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
