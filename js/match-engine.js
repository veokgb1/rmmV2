// v2-app/js/match-engine.js
// 职责：智能匹配算法，原 GAS calculateMatchScore 的 V2 纯 JS 移植
// 依赖：无（纯函数，零副作用，可独立单元测试）
// 导出：calculateMatchScore, findBestMatch, explainScore

// ── 匹配阈值常量 ─────────────────────────────────────

export const MATCH_THRESHOLD      = 60;  // 分数 >= 此值视为匹配
export const MATCH_HIGH_THRESHOLD = 90;  // 高置信度阈值

// ── 公开 API ──────────────────────────────────────────

/**
 * 计算 AI 识别结果与一条账目记录的匹配分
 * 满分 145（金额60 + 日期20 + 摘要65），>= 60 视为匹配
 *
 * @param {{ date?: string, amount?: number, summary?: string }} aiData
 * @param {{ date?: any,   amount?: number, summary?: string }} txData
 * @returns {number} 匹配分 0–145
 */
export function calculateMatchScore(aiData, txData) {
  let score = 0;

  // ── 金额匹配（最高 60 分）────────────────────────
  const aiAmt   = Math.abs(parseFloat(aiData.amount)  || 0);
  const rowAmt  = Math.abs(parseFloat(txData.amount)  || 0);
  const absDiff = Math.abs(aiAmt - rowAmt);

  if (aiAmt !== 0 && rowAmt !== 0) {
    if (absDiff <= 0.01) {
      score += 60; // 精确匹配
    } else {
      const maxAmt = Math.max(aiAmt, rowAmt);
      if (maxAmt <= 100 && absDiff <= 5) {
        score += 42; // 小额宽松匹配
      } else if (absDiff / maxAmt <= 0.20) {
        score += Math.round(50 * (1 - absDiff / maxAmt / 0.20)); // 比例匹配
      }
    }
  }

  // ── 日期匹配（最高 20 分）────────────────────────
  const aiDateStr  = normalizeDate(aiData.date);
  const txDateStr  = normalizeDate(txData.date);

  if (aiDateStr && txDateStr) {
    const daysDiff = Math.abs(
      new Date(aiDateStr).getTime() - new Date(txDateStr).getTime()
    ) / 86_400_000;

    if      (daysDiff === 0) score += 20;
    else if (daysDiff <= 3)  score += 15;
    else if (daysDiff <= 15) score += 10;
  }

  // ── 摘要文本匹配（最高 65 分）────────────────────
  const clean = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[\s,，.。!！?？、()（）【】[\]]/g, "");

  const aiText  = clean(aiData.summary);
  const rowText = clean(txData.summary);

  if (aiText.length > 0 && rowText.length > 0) {
    if (aiText.includes(rowText) || rowText.includes(aiText)) {
      score += 65;
    } else {
      const matchedChars = [...rowText].filter((c) => aiText.includes(c)).length;
      const matchRate    = matchedChars / rowText.length;
      if      (matchRate >= 0.8) score += 65;
      else if (matchRate >= 0.5) score += 30;
    }
  }

  return Math.round(score);
}

/**
 * 在候选账目列表中找出最佳匹配
 *
 * @param {object}   aiData       - AI 识别结果
 * @param {object[]} transactions - Firestore 账目数组
 * @param {number}   [threshold]  - 最低匹配阈值，默认 MATCH_THRESHOLD
 * @returns {{ tx: object, score: number, hasConflict: boolean, conflictPaths: string[] } | null}
 */
export function findBestMatch(aiData, transactions, threshold = MATCH_THRESHOLD) {
  let bestTx    = null;
  let bestScore = 0;

  for (const tx of transactions) {
    const score = calculateMatchScore(aiData, tx);
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestTx    = tx;
    }
  }

  if (!bestTx) return null;

  const hasConflict   = Array.isArray(bestTx.voucherPaths) && bestTx.voucherPaths.length > 0;
  const conflictPaths = hasConflict ? bestTx.voucherPaths : [];

  return {
    tx: bestTx,
    score: bestScore,
    confidence: bestScore >= MATCH_HIGH_THRESHOLD ? "high" : "medium",
    hasConflict,
    conflictPaths,
  };
}

/**
 * 可读性解释（调试 / Shadow Monitor 面板展示用）
 *
 * @param {object} aiData
 * @param {object} txData
 * @returns {{ totalScore: number, matched: boolean, confidence: string, detail: string }}
 */
export function explainScore(aiData, txData) {
  const totalScore = calculateMatchScore(aiData, txData);
  return {
    totalScore,
    matched:    totalScore >= MATCH_THRESHOLD,
    confidence: totalScore >= MATCH_HIGH_THRESHOLD ? "高" : totalScore >= MATCH_THRESHOLD ? "中" : "低",
    detail:     `AI ¥${aiData.amount ?? "?"} / 账目 ¥${txData.amount ?? "?"} | "${aiData.summary ?? ""}" vs "${txData.summary ?? ""}"`,
  };
}

// ── 内部工具 ──────────────────────────────────────────

/**
 * 将各种日期格式统一为 YYYY-MM-DD 字符串
 * 支持：Date 对象、Firestore Timestamp { seconds }、ISO 字符串
 */
function normalizeDate(date) {
  if (!date) return "";
  if (date instanceof Date)        return date.toISOString().slice(0, 10);
  if (typeof date === "object" && date.seconds) {
    return new Date(date.seconds * 1000).toISOString().slice(0, 10);
  }
  if (typeof date === "string")    return date.slice(0, 10);
  return "";
}
