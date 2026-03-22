// v2-app/js/ui-layout.js
// 职责：纯 UI 渲染层（DOM 操作、卡片流、日历、九宫格抽屉、Shadow Monitor 面板）
// 依赖：js/core-config.js
// 导出：renderLedger, renderCalendar, renderStats, renderShadowMonitor,
//        openDrawer, closeDrawer, showShadowMonitor, closeShadowMonitor,
//        showToast, showLoginScreen, showAppShell, setLoadingState

import { KEY_MAP, STATUS_META, CATEGORY_ICON, APP_CONFIG } from "./core-config.js";

// ── DOM 节点缓存（init 后填充）───────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── 应用骨架挂载 ──────────────────────────────────────

/**
 * 渲染登录页（未登录时调用）
 * @param {(email:string, password:string) => void} onLogin
 */
export function showLoginScreen(onLogin) {
  const root = $("#app-root");
  root.innerHTML = `
    <div class="h-full w-full flex items-center justify-center px-4 py-8 sm:px-6 lg:px-8 bg-gradient-to-b from-gray-50 to-white dark:from-gray-950 dark:to-gray-900">
      <div class="w-full max-w-md">
        <div class="text-center mb-6 sm:mb-8">
          <div class="w-12 h-12 rounded-2xl bg-purple-100 dark:bg-purple-900 flex items-center justify-center mx-auto mb-3 shadow-sm">
            <svg class="w-6 h-6 text-purple-600 dark:text-purple-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
          </div>
          <h1 class="text-xl font-medium text-gray-900 dark:text-gray-100">RMM 账本 V2</h1>
          <p class="text-sm text-gray-400 mt-1">DUKA · Firebase Edition</p>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-4 shadow-sm">
          <div>
            <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">邮箱</label>
            <input id="login-email" type="email" autocomplete="email"
              class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-400"
              placeholder="your@email.com">
          </div>
          <div>
            <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">密码</label>
            <input id="login-password" type="password" autocomplete="current-password"
              class="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-400">
          </div>
          <button id="login-btn"
            class="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 active:scale-95 text-white text-sm font-medium transition-all">
            登录
          </button>
          <p id="login-error" class="text-xs text-red-500 text-center hidden"></p>
        </div>
      </div>
    </div>`;

  const loginTitle = root.querySelector("h1");
  if (loginTitle) loginTitle.textContent = "RMM 账本 V2";
  const loginSubtitle = root.querySelector(".text-center p");
  if (loginSubtitle) loginSubtitle.textContent = "DUKA · Firebase Edition";
  const loginLabels = root.querySelectorAll("label");
  if (loginLabels[0]) loginLabels[0].textContent = "邮箱";
  if (loginLabels[1]) loginLabels[1].textContent = "密码";
  const emailInput = $("#login-email");
  if (emailInput) emailInput.placeholder = "you@example.com";

  const btn = $("#login-btn");
  if (btn) btn.textContent = "登录";
  const err = $("#login-error");
  btn.addEventListener("click", async () => {
    const email    = $("#login-email").value.trim();
    const password = $("#login-password").value;
    if (!email || !password) return;
    btn.disabled    = true;
    btn.textContent = "登录中...";
    err.classList.add("hidden");
    try {
      await onLogin(email, password);
    } catch (e) {
      err.textContent = e.message || "登录失败，请检查邮箱和密码";
      err.classList.remove("hidden");
      btn.disabled    = false;
      btn.textContent = "登录";
    }
  });
}

/**
 * 渲染主 App Shell（登录后调用一次）
 */
export function showAppShell() {
  const root = $("#app-root");
  root.innerHTML = `
    <!-- 双盲核对横幅（首月过渡期组件） -->
    <div id="dual-blind-banner" class="${APP_CONFIG.DUAL_BLIND_BANNER ? "" : "hidden"} bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800 px-4 py-2.5 flex items-center gap-3">
      <span class="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
        <svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>
      </span>
      <span class="text-xs text-blue-700 dark:text-blue-300 font-medium">双盲核对模式启用</span>
      <span class="text-xs text-blue-500 dark:text-blue-400">首月过渡期 · 新老图片同步验证中</span>
      <button id="banner-compare-btn"
        class="ml-auto text-xs px-3 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-medium transition-colors">
        查看对比
      </button>
    </div>

    <!-- 顶部统计头 -->
    <header class="bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 px-4 pt-3 pb-3 flex-shrink-0">
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-base font-medium text-gray-900 dark:text-gray-100">RMM 账本 V2</h1>
        <button id="month-picker" class="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
          <span id="current-month-label">2026年3月</span>
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
        </button>
      </div>
      <div class="flex gap-5">
        <div class="flex flex-col">
          <span class="text-xs text-gray-400">收入</span>
          <span id="stat-income" class="text-sm font-medium text-teal-600 dark:text-teal-400">¥0</span>
        </div>
        <div class="flex flex-col">
          <span class="text-xs text-gray-400">支出</span>
          <span id="stat-expense" class="text-sm font-medium text-orange-600 dark:text-orange-400">¥0</span>
        </div>
        <div class="flex flex-col">
          <span class="text-xs text-gray-400">结余</span>
          <span id="stat-balance" class="text-sm font-medium text-gray-900 dark:text-gray-100">¥0</span>
        </div>
      </div>
    </header>

    <!-- Tab 导航 -->
    <nav class="flex bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
      <button data-tab="flow"  class="tab-btn flex-1 py-2 text-xs border-b-2 border-purple-500 text-purple-600 dark:text-purple-400 font-medium">流水</button>
      <button data-tab="cal"   class="tab-btn flex-1 py-2 text-xs border-b-2 border-transparent text-gray-400">日历</button>
      <button data-tab="stats" class="tab-btn flex-1 py-2 text-xs border-b-2 border-transparent text-gray-400">统计</button>
    </nav>

    <!-- 内容区 -->
    <main class="flex-1 overflow-hidden relative">
      <div id="pane-flow"  class="pane absolute inset-0 overflow-y-auto overscroll-contain px-3 py-2"></div>
      <div id="pane-cal"   class="pane hidden absolute inset-0 overflow-y-auto overscroll-contain px-3 py-2"></div>
      <div id="pane-stats" class="pane hidden absolute inset-0 overflow-y-auto overscroll-contain px-3 py-3"></div>
    </main>

    <!-- 悬浮 FAB -->
    <button id="fab-add"
      class="absolute bottom-[60px] right-3 w-11 h-11 rounded-full bg-purple-600 hover:bg-purple-700 active:scale-90 shadow-lg flex items-center justify-center transition-all z-10">
      <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
      </svg>
    </button>

    <!-- 底部导航 -->
    <nav class="flex bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 flex-shrink-0 h-[60px]">
      <button data-nav="ledger"  class="nav-btn flex-1 flex flex-col items-center justify-center gap-0.5 text-purple-600 dark:text-purple-400">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
        <span class="text-[9px] font-medium">账本</span>
      </button>
      <button data-nav="dashboard" class="nav-btn flex-1 flex flex-col items-center justify-center gap-0.5 text-gray-400">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
        <span class="text-[9px]">看板</span>
      </button>
      <button data-nav="search" class="nav-btn flex-1 flex flex-col items-center justify-center gap-0.5 text-gray-400">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        <span class="text-[9px]">查询</span>
      </button>
      <button data-nav="settings" class="nav-btn flex-1 flex flex-col items-center justify-center gap-0.5 text-gray-400">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        <span class="text-[9px]">设置</span>
      </button>
    </nav>

    <!-- 九宫格抽屉遮罩 -->
    <div id="drawer-overlay" class="hidden absolute inset-0 bg-black/40 z-20" id="drawer-overlay"></div>

    <!-- 九宫格抽屉 -->
    <div id="drawer-panel"
      class="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900 rounded-t-2xl z-30
             translate-y-full transition-transform duration-300 ease-out">
      <div class="w-8 h-1 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto mt-3 mb-3"></div>
      <p class="text-center text-xs text-gray-400 mb-3">功能面板</p>
      <div id="drawer-grid" class="grid grid-cols-3 gap-2 px-3 pb-6"></div>
    </div>

    <!-- Shadow Monitor 终端面板 -->
    <div id="shadow-monitor-overlay" class="hidden absolute inset-0 bg-black/50 z-40"></div>
    <div id="shadow-monitor-panel"
      class="absolute bottom-0 left-0 right-0 bg-gray-950 rounded-t-2xl z-50
             translate-y-full transition-transform duration-300 ease-out"
      style="height: 65%">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
          <span class="text-xs text-green-400 font-mono font-medium">shadow_sync_monitor</span>
        </div>
        <button id="shadow-monitor-close" class="text-gray-500 hover:text-gray-300">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="px-4 py-2 border-b border-gray-800">
        <p class="text-[10px] text-gray-500 font-mono">$ tail -f shadow_logs | grep --color=always 'ok\|timeout\|error'</p>
      </div>
      <div id="shadow-monitor-log"
        class="overflow-y-auto font-mono text-[11px] leading-relaxed px-4 py-3 space-y-1.5"
        style="height: calc(100% - 80px)">
        <p class="text-gray-600">-- 加载日志中 --</p>
      </div>
    </div>

    <!-- Toast 通知 -->
    <div id="toast-container" class="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none"></div>
  `;
}

// ── 流水卡片流渲染 ────────────────────────────────────

/**
 * 渲染账目列表到流水面板
 * @param {object[]} transactions
 * @param {(tx: object) => void} onTxClick
 */
export function renderLedger(transactions, onTxClick) {
  const pane = $("#pane-flow");
  if (!pane) return;

  if (!transactions.length) {
    pane.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-300 dark:text-gray-600 py-20">
      <svg class="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
      <p class="text-sm">本月暂无记录</p>
    </div>`;
    return;
  }

  // 按日期分组
  const grouped = groupByDate(transactions);
  const html    = [];

  for (const [dateLabel, items] of grouped) {
    const dayIncome  = items.filter((t) => t.type === "收入").reduce((s, t) => s + (t.amount || 0), 0);
    const dayExpense = items.filter((t) => t.type === "支出").reduce((s, t) => s + (t.amount || 0), 0);

    html.push(`
      <div class="flex items-center justify-between px-1 pt-2 pb-1">
        <span class="text-[10px] text-gray-400 uppercase tracking-wide">${dateLabel}</span>
        <span class="text-[10px] text-gray-400">
          ${dayIncome  ? `<span class="text-teal-500">+${fmtAmt(dayIncome)}</span>` : ""}
          ${dayExpense ? `<span class="text-orange-500 ml-1">-${fmtAmt(dayExpense)}</span>` : ""}
        </span>
      </div>`);

    for (const tx of items) {
      html.push(renderTxCard(tx));
    }
  }

  pane.innerHTML = html.join("") + `<div class="h-16"></div>`;

  // 绑定点击事件
  pane.querySelectorAll(".tx-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      const tx = transactions.find((t) => t.id === id);
      if (tx) onTxClick(tx);
    });
  });

  // 更新统计头
  updateStatsHeader(transactions);
}

function renderTxCard(tx) {
  const meta    = STATUS_META[tx.status] || STATUS_META["未关联"];
  const icon    = CATEGORY_ICON[tx.category] || "📋";
  const isIncome = tx.type === "收入";
  const amtColor = isIncome
    ? "text-teal-600 dark:text-teal-400"
    : "text-orange-600 dark:text-orange-400";
  const amtPrefix = isIncome ? "+" : "-";
  const hasVoucher =
    (Array.isArray(tx.voucherStoragePaths) && tx.voucherStoragePaths.length > 0) ||
    (Array.isArray(tx.voucherPaths) && tx.voucherPaths.length > 0);

  return `
    <div class="tx-card bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700
                rounded-xl px-3 py-2.5 mb-1.5 flex items-center gap-2.5 cursor-pointer
                active:bg-gray-50 dark:active:bg-gray-700 transition-colors"
         data-id="${tx.id}">
      <div class="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0
                  ${isIncome ? "bg-teal-50 dark:bg-teal-950" : "bg-orange-50 dark:bg-orange-950"}">
        <span style="font-size:16px">${icon}</span>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">${esc(tx.summary || "无摘要")}</p>
        <p class="text-[10px] text-gray-400 mt-0.5">${esc(tx.category || "")} · ${esc(tx.source || "")}</p>
      </div>
      <div class="text-right flex-shrink-0">
        <p class="text-sm font-medium ${amtColor}">${amtPrefix}¥${fmtAmt(tx.amount)}</p>
        <p class="text-[10px] mt-0.5 ${meta.color} flex items-center justify-end gap-1">
          ${hasVoucher ? `<span class="w-1.5 h-1.5 rounded-full inline-block ${meta.dot}"></span>` : ""}
          ${meta.label}
        </p>
      </div>
    </div>`;
}

// ── 日历视图渲染 ──────────────────────────────────────

/**
 * 渲染日历视图
 * @param {object[]} transactions
 * @param {{ year: number, month: number }} current - 当前年月（month 0-indexed）
 * @param {(dateStr: string) => void} onDayClick
 */
export function renderCalendar(transactions, { year, month }, onDayClick) {
  const pane = $("#pane-cal");
  if (!pane) return;

  const txByDay = {};
  transactions.forEach((tx) => {
    const d = normalizeDateStr(tx.date);
    if (!txByDay[d]) txByDay[d] = { income: 0, expense: 0, items: [] };
    if (tx.type === "收入") txByDay[d].income  += tx.amount || 0;
    else                    txByDay[d].expense += tx.amount || 0;
    txByDay[d].items.push(tx);
  });

  const today     = new Date();
  const firstDay  = new Date(year, month, 1).getDay(); // 0=Sun
  const daysCount = new Date(year, month + 1, 0).getDate();
  const monthStr  = `${year}年${month + 1}月`;

  const dayCells = [];
  const DOW      = ["日", "一", "二", "三", "四", "五", "六"];

  // 空格
  for (let i = 0; i < firstDay; i++) {
    dayCells.push(`<div></div>`);
  }

  for (let d = 1; d <= daysCount; d++) {
    const dateStr   = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayData   = txByDay[dateStr];
    const isToday   = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
    const hasIncome = dayData?.income  > 0;
    const hasExp    = dayData?.expense > 0;

    dayCells.push(`
      <div class="cal-day flex flex-col items-center cursor-pointer rounded-lg py-1
                  ${isToday ? "bg-purple-600 text-white" : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200"}"
           data-date="${dateStr}">
        <span class="text-[11px] font-${isToday ? "medium" : "normal"}">${d}</span>
        <div class="flex gap-0.5 mt-0.5 h-1">
          ${hasIncome ? `<span class="w-1 h-1 rounded-full ${isToday ? "bg-white/70" : "bg-teal-500"}"></span>` : ""}
          ${hasExp    ? `<span class="w-1 h-1 rounded-full ${isToday ? "bg-white/70" : "bg-orange-500"}"></span>` : ""}
        </div>
      </div>`);
  }

  pane.innerHTML = `
    <div class="flex items-center justify-between mb-3 px-1">
      <button id="cal-prev" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <span class="text-sm font-medium text-gray-900 dark:text-gray-100">${monthStr}</span>
      <button id="cal-next" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>
    <div class="grid grid-cols-7 gap-1 mb-2">
      ${DOW.map((d) => `<div class="text-center text-[10px] text-gray-400 py-1">${d}</div>`).join("")}
      ${dayCells.join("")}
    </div>
    <div id="cal-day-detail" class="mt-3"></div>`;

  pane.querySelectorAll(".cal-day").forEach((cell) => {
    cell.addEventListener("click", () => {
      const dateStr = cell.dataset.date;
      const dayData = txByDay[dateStr];
      renderCalDayDetail(dateStr, dayData?.items || []);
      onDayClick(dateStr);
    });
  });
}

function renderCalDayDetail(dateStr, items) {
  const el = $("#cal-day-detail");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<p class="text-xs text-gray-400 text-center py-4">${dateStr} 无记录</p>`;
    return;
  }
  el.innerHTML = `
    <p class="text-[10px] text-gray-400 px-1 mb-2">${dateStr} · ${items.length} 笔</p>
    ${items.map((tx) => renderTxCard(tx)).join("")}`;
}

// ── 统计视图渲染 ──────────────────────────────────────

/**
 * 渲染统计页
 * @param {object[]} transactions
 */
export function renderStats(transactions) {
  const pane = $("#pane-stats");
  if (!pane) return;

  const catTotals = {};
  transactions
    .filter((t) => t.type === "支出")
    .forEach((t) => {
      catTotals[t.category || "未分类"] =
        (catTotals[t.category || "未分类"] || 0) + (t.amount || 0);
    });

  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const maxAmt = sorted[0]?.[1] || 1;

  const BAR_COLORS = ["#7F77DD", "#1D9E75", "#D85A30", "#BA7517", "#378ADD", "#999"];

  pane.innerHTML = `
    <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">本月支出分类</p>
    <div class="space-y-2.5">
      ${sorted.map(([cat, amt], i) => `
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-gray-500 w-10 flex-shrink-0 text-right">${cat}</span>
          <div class="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500"
                 style="width:${Math.round((amt / maxAmt) * 100)}%;background:${BAR_COLORS[i % BAR_COLORS.length]}"></div>
          </div>
          <span class="text-[10px] text-gray-500 w-14 text-right">¥${fmtAmt(amt)}</span>
        </div>`).join("")}
    </div>`;
}

// ── Shadow Monitor 终端面板 ───────────────────────────

/**
 * 渲染影子写日志到终端面板
 * @param {object[]} logs - 日志数组（由 api-bridge.fetchShadowLogs 返回）
 */
export function renderShadowMonitor(logs) {
  const el = $("#shadow-monitor-log");
  if (!el) return;

  if (!logs.length) {
    el.innerHTML = `<p class="text-gray-600">-- 暂无日志，等待首笔双写触发 --</p>`;
    return;
  }

  el.innerHTML = logs.map((log) => {
    const status = log.gasStatus;
    const color  = status === "ok" ? "text-green-400" :
                   status === "timeout" ? "text-yellow-400" : "text-red-400";
    const symbol = status === "ok" ? "✓" : status === "timeout" ? "⏱" : "✗";
    const ms     = log.gasMs != null ? `${log.gasMs}ms` : "--";
    const ts     = (log.ts || "").replace("T", " ").slice(0, 19);
    const txShort = (log.txId || "").slice(0, 8);
    const errPart = log.error
      ? `<span class="text-red-500"> ${esc(log.error.slice(0, 60))}</span>`
      : "";

    return `<div class="flex items-start gap-2">
      <span class="${color} font-bold flex-shrink-0">${symbol}</span>
      <div>
        <span class="text-gray-500">[${ts}]</span>
        <span class="text-blue-400 ml-1">${txShort}</span>
        <span class="${color} ml-1">${status}</span>
        <span class="text-gray-500 ml-1">${ms}</span>
        ${errPart}
      </div>
    </div>`;
  }).join("");

  // 滚动到底部（最新日志）
  el.scrollTop = el.scrollHeight;
}

// ── 抽屉开关 ──────────────────────────────────────────

/**
 * 渲染并打开九宫格功能抽屉
 * @param {(action: string) => void} onKeyAction
 */
export function openDrawer(onKeyAction) {
  const overlay = $("#drawer-overlay");
  const panel   = $("#drawer-panel");
  const grid    = $("#drawer-grid");
  if (!overlay || !panel || !grid) return;

  // 渲染九宫格按钮
  grid.innerHTML = KEY_MAP.map((key) => `
    <button class="drawer-key flex flex-col items-center gap-1.5 bg-gray-50 dark:bg-gray-800
                   border border-gray-100 dark:border-gray-700 rounded-xl py-3 px-2
                   active:bg-gray-100 dark:active:bg-gray-700 transition-colors"
            data-action="${key.action}">
      <svg class="w-5 h-5 text-purple-500 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="${key.icon}"/>
      </svg>
      <span class="text-[10px] font-medium text-gray-700 dark:text-gray-300 text-center leading-tight">${key.label}</span>
      <span class="text-[9px] text-gray-400">⌘${key.id}</span>
    </button>`).join("");

  // 绑定点击
  grid.querySelectorAll(".drawer-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeDrawer();
      onKeyAction(btn.dataset.action);
    });
  });

  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    panel.style.transform = "translateY(0)";
  });

  overlay.onclick = closeDrawer;
}

export function closeDrawer() {
  const overlay = $("#drawer-overlay");
  const panel   = $("#drawer-panel");
  if (!overlay || !panel) return;
  panel.style.transform = "translateY(100%)";
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

// ── Shadow Monitor 开关 ───────────────────────────────

export function showShadowMonitor() {
  const overlay = $("#shadow-monitor-overlay");
  const panel   = $("#shadow-monitor-panel");
  if (!overlay || !panel) return;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    panel.style.transform = "translateY(0)";
  });
  $("#shadow-monitor-close")?.addEventListener("click", closeShadowMonitor, { once: true });
  overlay.onclick = closeShadowMonitor;
}

export function closeShadowMonitor() {
  const overlay = $("#shadow-monitor-overlay");
  const panel   = $("#shadow-monitor-panel");
  if (!overlay || !panel) return;
  panel.style.transform = "translateY(100%)";
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

// ── Toast 通知 ────────────────────────────────────────

/**
 * 显示顶部 Toast 提示
 * @param {string} message
 * @param {"info"|"success"|"error"|"warning"} type
 * @param {number} duration ms
 */
export function showToast(message, type = "info", duration = 3000) {
  const container = $("#toast-container");
  if (!container) return;

  const colors = {
    success: "bg-teal-600 text-white",
    error:   "bg-red-600 text-white",
    warning: "bg-amber-500 text-white",
    info:    "bg-gray-800 dark:bg-gray-700 text-white",
  };

  const el = document.createElement("div");
  el.className = `px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg pointer-events-auto
                  transition-all duration-300 opacity-0 translate-y-1 ${colors[type] || colors.info}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.remove("opacity-0", "translate-y-1");
  });

  setTimeout(() => {
    el.classList.add("opacity-0");
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/**
 * 设置加载状态（全局 spinner 或骨架屏）
 * @param {boolean} loading
 */
export function setLoadingState(loading) {
  const pane = $("#pane-flow");
  if (!pane) return;
  if (loading) {
    pane.innerHTML = `<div class="space-y-2 pt-2">
      ${Array(5).fill(0).map(() => `
        <div class="bg-white dark:bg-gray-800 rounded-xl p-3 flex items-center gap-3 animate-pulse">
          <div class="w-9 h-9 rounded-[10px] bg-gray-100 dark:bg-gray-700 flex-shrink-0"></div>
          <div class="flex-1 space-y-1.5">
            <div class="h-3 bg-gray-100 dark:bg-gray-700 rounded-full w-3/4"></div>
            <div class="h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full w-1/2"></div>
          </div>
          <div class="w-14 space-y-1.5 text-right">
            <div class="h-3 bg-gray-100 dark:bg-gray-700 rounded-full"></div>
            <div class="h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full w-2/3 ml-auto"></div>
          </div>
        </div>`).join("")}
    </div>`;
    return;
  }

  // Clear stale skeleton when a request ends but render path did not repaint.
  if (pane.querySelector(".animate-pulse")) {
    pane.innerHTML = "";
  }
}

// ── 内部工具 ──────────────────────────────────────────

function updateStatsHeader(transactions) {
  const income  = transactions.filter((t) => t.type === "收入").reduce((s, t) => s + (t.amount || 0), 0);
  const expense = transactions.filter((t) => t.type === "支出").reduce((s, t) => s + (t.amount || 0), 0);
  const balance = income - expense;
  const si = $("#stat-income"),  se = $("#stat-expense"), sb = $("#stat-balance");
  if (si) si.textContent = `¥${fmtAmt(income)}`;
  if (se) se.textContent = `¥${fmtAmt(expense)}`;
  if (sb) {
    sb.textContent = `¥${fmtAmt(Math.abs(balance))}`;
    sb.className   = `text-sm font-medium ${balance >= 0 ? "text-gray-900 dark:text-gray-100" : "text-red-500"}`;
  }
}

function groupByDate(transactions) {
  const map   = new Map();
  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const tx of transactions) {
    const dateStr = normalizeDateStr(tx.date);
    const label   = dateStr === today ? `今天 · ${dateStr.slice(5).replace("-", "月")}日`
                  : dateStr === yest  ? `昨天 · ${dateStr.slice(5).replace("-", "月")}日`
                  : dateStr.slice(5).replace("-", "月") + "日";
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(tx);
  }
  return map;
}

function normalizeDateStr(date) {
  if (!date) return new Date().toISOString().slice(0, 10);
  if (typeof date === "string")  return date.slice(0, 10);
  if (date instanceof Date)      return date.toISOString().slice(0, 10);
  if (date.seconds)              return new Date(date.seconds * 1000).toISOString().slice(0, 10);
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
