// v2-app/js/match-engine.js
// Pure matching and duplicate-inspection helpers.

export const MATCH_THRESHOLD = 60;
export const MATCH_HIGH_THRESHOLD = 90;
export const DUPLICATE_MEDIUM_THRESHOLD = 78;
export const DUPLICATE_HIGH_THRESHOLD = 98;

export function calculateMatchScore(aiData, txData) {
  let score = 0;

  const aiAmt = Math.abs(parseFloat(aiData.amount) || 0);
  const rowAmt = Math.abs(parseFloat(txData.amount) || 0);
  const absDiff = Math.abs(aiAmt - rowAmt);

  if (aiAmt !== 0 && rowAmt !== 0) {
    if (absDiff <= 0.01) {
      score += 60;
    } else {
      const maxAmt = Math.max(aiAmt, rowAmt);
      if (maxAmt <= 100 && absDiff <= 5) {
        score += 42;
      } else if (absDiff / maxAmt <= 0.2) {
        score += Math.round(50 * (1 - absDiff / maxAmt / 0.2));
      }
    }
  }

  const aiDateStr = normalizeDate(aiData.date);
  const txDateStr = normalizeDate(txData.date);

  if (aiDateStr && txDateStr) {
    const daysDiff = Math.abs(
      new Date(aiDateStr).getTime() - new Date(txDateStr).getTime()
    ) / 86400000;

    if (daysDiff === 0) score += 20;
    else if (daysDiff <= 3) score += 15;
    else if (daysDiff <= 15) score += 10;
  }

  const aiText = normalizeText(aiData.summary);
  const rowText = normalizeText(txData.summary);

  if (aiText && rowText) {
    if (aiText.includes(rowText) || rowText.includes(aiText)) {
      score += 65;
    } else {
      const matchedChars = [...rowText].filter((c) => aiText.includes(c)).length;
      const matchRate = matchedChars / rowText.length;
      if (matchRate >= 0.8) score += 65;
      else if (matchRate >= 0.5) score += 30;
    }
  }

  return Math.round(score);
}

export function findBestMatch(aiData, transactions, threshold = MATCH_THRESHOLD) {
  let bestTx = null;
  let bestScore = 0;

  for (const tx of transactions) {
    const score = calculateMatchScore(aiData, tx);
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestTx = tx;
    }
  }

  if (!bestTx) return null;

  const conflictPaths = Array.isArray(bestTx.voucherPaths)
    ? bestTx.voucherPaths
    : [];

  return {
    tx: bestTx,
    score: bestScore,
    confidence: bestScore >= MATCH_HIGH_THRESHOLD ? "high" : "medium",
    hasConflict: conflictPaths.length > 0,
    conflictPaths,
  };
}


export function findRankedMatches(
  aiData,
  transactions,
  {
    threshold = 18,
    maxCandidates = 8,
  } = {},
) {
  const ranked = [];

  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (isRecordDeleted(tx)) continue;

    const score = calculateMatchScore(aiData, tx);
    const reasons = buildMatchReasons(aiData, tx);
    if (score < threshold && reasons.length === 0) continue;

    ranked.push({
      tx,
      score,
      reasons,
      confidence:
        score >= MATCH_HIGH_THRESHOLD
          ? "high"
          : score >= MATCH_THRESHOLD
            ? "medium"
            : "low",
    });
  }

  return ranked.sort((left, right) => right.score - left.score).slice(0, maxCandidates);
}export function explainScore(aiData, txData) {
  const totalScore = calculateMatchScore(aiData, txData);
  return {
    totalScore,
    matched: totalScore >= MATCH_THRESHOLD,
    confidence:
      totalScore >= MATCH_HIGH_THRESHOLD
        ? "high"
        : totalScore >= MATCH_THRESHOLD
          ? "medium"
          : "low",
    detail: `AI ${aiData.amount ?? "?"} / TX ${txData.amount ?? "?"} | "${aiData.summary ?? ""}" vs "${txData.summary ?? ""}"`,
  };
}

export function findDuplicateCandidates(
  draft,
  transactions,
  {
    highThreshold = DUPLICATE_HIGH_THRESHOLD,
    mediumThreshold = DUPLICATE_MEDIUM_THRESHOLD,
    maxCandidates = 3,
  } = {},
) {
  const candidates = [];

  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (isRecordDeleted(tx)) continue;

    const scored = scoreDuplicateCandidate(draft, tx);
    if (!scored.level) continue;
    if (
      scored.level === "high" ||
      scored.level === "medium" ||
      scored.score >= mediumThreshold
    ) {
      candidates.push({
        tx,
        score: scored.score,
        level:
          scored.score >= highThreshold || scored.level === "high"
            ? "high"
            : "medium",
        reasons: scored.reasons,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const sliced = candidates.slice(0, maxCandidates);
  const high = sliced.filter((item) => item.level === "high");
  const medium = sliced.filter((item) => item.level === "medium");

  return {
    hasRisk: sliced.length > 0,
    highCount: candidates.filter((item) => item.level === "high").length,
    mediumCount: candidates.filter((item) => item.level === "medium").length,
    candidates: sliced,
  };
}

export function findDuplicatePairs(
  transactions,
  {
    highThreshold = DUPLICATE_HIGH_THRESHOLD,
    mediumThreshold = DUPLICATE_MEDIUM_THRESHOLD,
    maxPairs = 24,
  } = {},
) {
  const active = (Array.isArray(transactions) ? transactions : []).filter(
    (tx) => !isRecordDeleted(tx),
  );
  const pairs = [];

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const scored = scoreDuplicateCandidate(active[i], active[j]);
      if (scored.score < mediumThreshold || !scored.level) continue;
      pairs.push({
        left: active[i],
        right: active[j],
        score: scored.score,
        level:
          scored.score >= highThreshold || scored.level === "high"
            ? "high"
            : "medium",
        reasons: scored.reasons,
      });
    }
  }

  return pairs.sort((a, b) => b.score - a.score).slice(0, maxPairs);
}

function scoreDuplicateCandidate(left, right) {
  let score = calculateMatchScore(left, right);
  const reasons = [];

  const sameType = (left.type || "") === (right.type || "") && left.type;
  const sameCategory =
    (left.category || "") === (right.category || "") && left.category;
  const leftDate = normalizeDate(left.date);
  const rightDate = normalizeDate(right.date);
  const sameDay = leftDate && rightDate && leftDate === rightDate;
  const sameMonth =
    leftDate && rightDate && leftDate.slice(0, 7) === rightDate.slice(0, 7);
  const exactAmount = almostEqual(left.amount, right.amount, 0.01);
  const closeAmount = almostEqual(left.amount, right.amount, 5);
  const sameSummary =
    normalizeText(left.summary) &&
    normalizeText(left.summary) === normalizeText(right.summary);

  if (sameType) {
    score += 6;
    reasons.push("same_type");
  }
  if (sameCategory) {
    score += 5;
    reasons.push("same_category");
  }
  if (sameMonth) {
    score += 4;
    reasons.push("same_month");
  }
  if (exactAmount && sameDay) {
    score += 18;
    reasons.push("exact_amount_same_day");
  } else if (exactAmount) {
    score += 10;
    reasons.push("exact_amount");
  } else if (closeAmount && sameDay) {
    score += 6;
    reasons.push("close_amount_same_day");
  }
  if (sameSummary) {
    score += 18;
    reasons.push("same_summary");
  }

  const level =
    sameSummary && exactAmount && sameDay
      ? "high"
      : score >= DUPLICATE_HIGH_THRESHOLD
        ? "high"
        : score >= DUPLICATE_MEDIUM_THRESHOLD
          ? "medium"
          : null;

  return { score: Math.round(score), level, reasons };
}

function isRecordDeleted(tx) {
  return Boolean(tx?._deleted) || String(tx?.status || "") === "已删除";
}


function buildMatchReasons(aiData, txData) {
  const reasons = [];

  const aiAmt = Math.abs(parseFloat(aiData.amount) || 0);
  const txAmt = Math.abs(parseFloat(txData.amount) || 0);
  const absDiff = Math.abs(aiAmt - txAmt);
  if (aiAmt && txAmt) {
    if (absDiff <= 0.01) reasons.push("exact_amount");
    else if (absDiff <= 5) reasons.push("close_amount");
  }

  const aiDate = normalizeDate(aiData.date);
  const txDate = normalizeDate(txData.date);
  if (aiDate && txDate) {
    const daysDiff = Math.abs(new Date(aiDate).getTime() - new Date(txDate).getTime()) / 86400000;
    if (daysDiff === 0) reasons.push("same_day");
    else if (daysDiff <= 3) reasons.push("near_day");
    else if (aiDate.slice(0, 7) === txDate.slice(0, 7)) reasons.push("same_month");
  }

  const aiText = normalizeText(aiData.summary);
  const txText = normalizeText(txData.summary);
  if (aiText && txText) {
    if (aiText === txText) reasons.push("same_summary");
    else if (aiText.includes(txText) || txText.includes(aiText)) reasons.push("summary_overlap");
    else {
      const matchedChars = [...txText].filter((c) => aiText.includes(c)).length;
      const matchRate = txText.length ? matchedChars / txText.length : 0;
      if (matchRate >= 0.5) reasons.push("summary_near");
    }
  }

  return reasons;
}function almostEqual(left, right, tolerance) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s,，。:：;；!?！？、（）()[\]【】"'`]+/g, "");
}

function normalizeDate(date) {
  if (!date) return "";
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === "object" && date.seconds) {
    return new Date(date.seconds * 1000).toISOString().slice(0, 10);
  }
  if (typeof date === "string") return date.slice(0, 10);
  return "";
}
