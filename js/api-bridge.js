// v2-app/js/api-bridge.js
// 职责：统管所有网络交互（Worker、Firestore、双写容错）
// 依赖：js/core-config.js
// 导出：submitTransaction, updateTransaction, fetchLedger, deleteTransaction,
//        geminiOCR, geminiNLP, uploadVoucher, fetchShadowLogs,
//        loginUser, logoutUser, onAuthChange

import {
  APP_CONFIG,
  initFirebase,
  getFirebaseApp,
} from "./core-config.js";

// ── Firestore 动态导入缓存 ────────────────────────────
let _fsModules = null;
async function fsModules() {
  if (_fsModules) return _fsModules;
  const m = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  _fsModules = m;
  return m;
}

// ── Auth 动态导入缓存 ──────────────────────────────────
let _authModules = null;
async function authModules() {
  if (_authModules) return _authModules;
  const m = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  _authModules = m;
  return m;
}

// ── 内部 Token 缓存 ───────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;

async function getIdToken(forceRefresh = false) {
  const { auth } = getFirebaseApp();
  if (!auth?.currentUser) throw new Error("用户未登录");
  if (!forceRefresh && _cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }
  _cachedToken    = await auth.currentUser.getIdToken(true);
  _tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 分钟，比 JWT 1小时略短
  return _cachedToken;
}

// ── Worker 请求封装 ───────────────────────────────────

/**
 * 向 Cloudflare Worker 发送 POST 请求
 * @param {string} action
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function workerPost(action, payload = {}) {
  const token = await getIdToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), APP_CONFIG.REQUEST_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(APP_CONFIG.WORKER_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body:   JSON.stringify({ action, ...payload }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json();
  if (!data.ok) throw new ApiError(data.error || "Worker 返回错误", resp.status);
  return data;
}

// ── 核心业务：提交账目（含双写容错，铁律二核心）────────

/**
 * 提交新账目到 Firestore（主链路）
 * 主链路成功后，异步影子写到 V1 GAS（非阻塞）
 *
 * @param {object} txData - 账目数据
 * @returns {Promise<{ id: string }>} Firestore 文档 ID
 */
export async function submitTransaction(txData) {
  // ── 主链路：写入 Firestore ──
  const { db } = getFirebaseApp();
  const { collection, addDoc, serverTimestamp } = await fsModules();

  const docRef = await addDoc(collection(db, "transactions"), {
    ...txData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    source:    txData.source || "手动录入",
    status:    txData.status || "未关联",
    voucherPaths: txData.voucherPaths || [],
  });

  // ── 影子链路：异步向 V1 GAS 备份（铁律二）──
  // 绝不 await，绝不让失败影响主链路
  if (APP_CONFIG.SHADOW_WRITE_ENABLED && APP_CONFIG.GAS_V1_URL) {
    shadowWriteToGas(txData, docRef.id).catch(() => {
      // 静默忽略，日志已在 shadowWriteToGas 内上报
    });
  }

  return { id: docRef.id };
}

/**
 * 影子写：将新账目异步 POST 给 V1 GAS 接口，并上报日志
 * 此函数永远不抛出，永远不阻塞调用方
 *
 * @param {object} txData
 * @param {string} firestoreId
 */
async function shadowWriteToGas(txData, firestoreId) {
  const t0         = Date.now();
  let   gasStatus  = "ok";
  let   errorMsg   = null;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), APP_CONFIG.SHADOW_TIMEOUT_MS);

    try {
      const resp = await fetch(APP_CONFIG.GAS_V1_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          action: "append_rows",
          rows:   [txDataToGasRow(txData)],
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) gasStatus = "error";
    } catch (fetchErr) {
      gasStatus = fetchErr.name === "AbortError" ? "timeout" : "error";
      errorMsg  = fetchErr.message;
    } finally {
      clearTimeout(timer);
    }
  } catch (outerErr) {
    gasStatus = "error";
    errorMsg  = outerErr.message;
  }

  const gasMs = Date.now() - t0;

  // 上报日志到 Worker → Firestore shadow_logs（同样非阻塞）
  try {
    const token = await getIdToken().catch(() => "");
    if (token) {
      await fetch(APP_CONFIG.WORKER_URL, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          action:    "shadow_write_log",
          txId:      firestoreId,
          gasStatus,
          gasMs,
          error:     errorMsg,
        }),
      });
    }
  } catch {
    // 日志上报失败也静默处理，不让它影响任何用户操作
  }
}

/**
 * 将 V2 账目对象转换为 V1 GAS append_rows 格式（9列）
 */
function txDataToGasRow(txData) {
  const dateStr = normalizeDateStr(txData.date);
  return [
    dateStr,
    dateStr.slice(0, 7),          // YYYY-MM
    txData.type     || "支出",
    txData.category || "未分类",
    txData.amount   || 0,
    txData.summary  || "",
    "V2双写备份",
    "",                           // 凭证列（V1不处理 Storage 路径）
    txData.status   || "未关联",
  ];
}

// ── 读取账目列表 ──────────────────────────────────────

/**
 * 从 Firestore 读取账目列表
 * @param {{ month?: string, limit?: number, startAfter?: object }} options
 * @returns {Promise<object[]>}
 */
export async function fetchLedger({ month, limit = 100, startAfterDoc } = {}) {
  const { db } = getFirebaseApp();
  const {
    collection, query, where, orderBy,
    limit: fsLimit, startAfter, getDocs,
  } = await fsModules();

  const constraints = [
    orderBy("date", "desc"),
    fsLimit(limit),
  ];
  if (month) constraints.push(where("month", "==", month));
  if (startAfterDoc) constraints.push(startAfter(startAfterDoc));

  const q    = query(collection(db, "transactions"), ...constraints);
  const snap = await getDocs(q);

  return snap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
    _snap: doc, // 保留快照用于分页
  }));
}

/**
 * 更新账目字段
 * @param {string} txId
 * @param {object} updates
 */
export async function updateTransaction(txId, updates) {
  const { db } = getFirebaseApp();
  const { doc, updateDoc, serverTimestamp } = await fsModules();
  await updateDoc(doc(db, "transactions", txId), {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 删除账目（软删除：标记 _deleted: true）
 * @param {string} txId
 */
export async function deleteTransaction(txId) {
  await updateTransaction(txId, { _deleted: true, status: "已删除" });
}

/**
 * 解绑账目中的指定凭证（arrayRemove 原子操作）
 * @param {string}   txId
 * @param {string[]} pathsToRemove - Storage 路径数组
 */
export async function unbindVouchers(txId, pathsToRemove) {
  const { db } = getFirebaseApp();
  const { doc, updateDoc, arrayRemove, serverTimestamp } = await fsModules();
  await updateDoc(doc(db, "transactions", txId), {
    voucherPaths: arrayRemove(...pathsToRemove),
    updatedAt:    serverTimestamp(),
  });
}

// ── AI 功能（通过 Worker 代理，Key 不暴露）────────────

/**
 * OCR：识别图片内容
 * @param {{ base64: string, mime: string }} params
 * @returns {Promise<object>} AI 识别结果
 */
export async function geminiOCR({ base64, mime }) {
  const result = await workerPost("gemini_ocr", { base64, mime });
  return result.data;
}

/**
 * NLP：从文字提取账目
 * @param {{ text: string, categories?: string }} params
 * @returns {Promise<Array>} 账目数组
 */
export async function geminiNLP({ text, categories }) {
  const result = await workerPost("gemini_nlp", { text, categories });
  return Array.isArray(result.data) ? result.data : [result.data];
}

// ── 图片上传（直传 Firebase Storage）────────────────

/**
 * 上传凭证图片到 Firebase Storage
 * @param {{ file: File, txId?: string }} params
 * @returns {Promise<{ storagePath: string, publicUrl: string, thumbnailUrl: string }>}
 */
export async function uploadVoucher({ file, txId = "" }) {
  const { storage } = getFirebaseApp();
  const {
    ref, uploadBytes, getDownloadURL,
  } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js");

  const ext         = file.name.split(".").pop() || "jpg";
  const timestamp   = Date.now();
  const storagePath = `vouchers/${timestamp}_${crypto.randomUUID()}.${ext}`;
  const storageRef  = ref(storage, storagePath);

  await uploadBytes(storageRef, file, {
    contentType: file.type || "image/jpeg",
    customMetadata: { txId },
  });

  const publicUrl = await getDownloadURL(storageRef);
  return { storagePath, publicUrl, thumbnailUrl: publicUrl };
}

// ── 影子日志读取（Shadow Monitor 面板）───────────────

/**
 * 读取最近的影子写日志（供 Shadow Monitor 终端面板展示）
 * @param {{ limit?: number }} options
 * @returns {Promise<Array>}
 */
export async function fetchShadowLogs({ limit = 30 } = {}) {
  const { db } = getFirebaseApp();
  const { collection, query, orderBy, limit: fsLimit, getDocs } = await fsModules();

  const q    = query(
    collection(db, "shadow_logs"),
    orderBy("ts", "desc"),
    fsLimit(limit)
  );
  const snap = await getDocs(q);
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// ── Firebase Auth ─────────────────────────────────────

/**
 * 邮箱密码登录
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<object>} Firebase User
 */
export async function loginUser({ email, password }) {
  const { auth } = getFirebaseApp();
  const { signInWithEmailAndPassword } = await authModules();
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/**
 * 登出
 */
export async function logoutUser() {
  const { auth }  = getFirebaseApp();
  const { signOut } = await authModules();
  _cachedToken    = null;
  _tokenExpiresAt = 0;
  await signOut(auth);
}

/**
 * 监听登录状态变化
 * @param {(user: object|null) => void} callback
 * @returns {() => void} unsubscribe 函数
 */
export async function onAuthChange(callback) {
  const { auth } = getFirebaseApp();
  const { onAuthStateChanged } = await authModules();
  return onAuthStateChanged(auth, callback);
}

// ── 工具函数 ──────────────────────────────────────────

function normalizeDateStr(date) {
  if (!date) return new Date().toISOString().slice(0, 10);
  if (typeof date === "string") return date.slice(0, 10);
  if (date instanceof Date)    return date.toISOString().slice(0, 10);
  if (date.seconds)            return new Date(date.seconds * 1000).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name   = "ApiError";
    this.status = status;
  }
}
