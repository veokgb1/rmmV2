// v2-app/worker/index.js
// 职责：主路由、CORS、速率限制、双写影子日志接收
// 依赖：./auth.js, ./gemini.js
// 导出：default { fetch }
//
// Cloudflare Worker Secrets（在 Dashboard 配置，绝不写入代码）：
//   GEMINI_API_KEY         — Gemini API 密钥
//   FIREBASE_PROJECT_ID    — Firebase 项目 ID
//   FIREBASE_FUNCTIONS_URL — Cloud Functions 基础 URL
//   WORKER_INTERNAL_SECRET — Worker → Functions 内部鉴权密钥
//   GAS_V1_URL             — V1 GAS 接口 URL（首月双写用，过渡期后删除）

import { verifyToken }          from "./auth.js";
import { geminiOCR, geminiNLP } from "./gemini.js";

// ── CORS 响应头 ───────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age":       "86400",
};

// ── 速率限制：简单内存计数器（Worker 实例级别）─────────

const rateLimitMap = new Map(); // uid → { count, resetAt }
const RATE_LIMIT_MAX    = 120;    // 每窗口最大请求数
const RATE_LIMIT_WINDOW = 60_000; // 1 分钟窗口（ms）

function checkRateLimit(uid) {
  const now = Date.now();
  const rec = rateLimitMap.get(uid);
  if (!rec || now > rec.resetAt) {
    rateLimitMap.set(uid, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count++;
  return true;
}

// ── 主入口 ────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // 1. CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // 2. 健康检查（无需认证，供 Cloudflare 监控探针使用）
    if (url.pathname === "/ping") {
      return json({ ok: true, msg: "DUKA V2 Worker online", ts: Date.now() });
    }

    // 3. 所有其他路由只接受 POST
    if (request.method !== "POST") {
      return json({ ok: false, error: "仅支持 POST 请求" }, 405);
    }

    // 4. 解析请求体
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "请求体必须是合法 JSON" }, 400);
    }

    const { action } = body;
    if (!action || typeof action !== "string") {
      return json({ ok: false, error: "缺少 action 字段" }, 400);
    }

    // 5. 验证 Firebase ID Token
    const authHeader = request.headers.get("Authorization") ?? "";
    const token      = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    const user = await verifyToken(token, env);
    if (!user) {
      return json(
        { ok: false, error: "Token 无效或已过期，请重新登录", code: 401 },
        401
      );
    }

    // 6. 速率限制
    if (!checkRateLimit(user.uid)) {
      return json(
        { ok: false, error: "请求过于频繁，请稍候再试", code: 429 },
        429
      );
    }

    // 7. 路由分发
    try {
      return await route(action, body, user, env);
    } catch (err) {
      console.error(`[Worker] 未捕获异常 action=${action}:`, err);
      return json(
        { ok: false, error: `服务器内部错误：${err.message}`, code: 500 },
        500
      );
    }
  },
};

// ── 路由表 ────────────────────────────────────────────

async function route(action, body, user, env) {
  switch (action) {

    // ── AI 功能（Key 封装在 gemini.js，不泄露到前端）──
    case "gemini_ocr":
      return json(await geminiOCR(body, env));

    case "gemini_nlp":
      return json(await geminiNLP(body, env));

    // ── 影子双写状态日志接收（铁律二）────────────────
    // 前端 api-bridge.js 的 shadowWrite() 异步完成后
    // 将结果 POST 到此端点，写入 Firestore shadow_logs 集合
    case "shadow_write_log": {
      const logEntry = {
        uid:       user.uid,
        txId:      body.txId      ?? null,
        gasStatus: body.gasStatus ?? "unknown", // "ok" | "timeout" | "error"
        gasMs:     body.gasMs     ?? null,       // 响应耗时 ms
        error:     body.error     ?? null,
        ts:        new Date().toISOString(),
      };
      // 异步写入，不 await，不阻塞当前响应
      writeShadowLog(logEntry, env).catch((e) =>
        console.error("[Worker] shadow_write_log 写入失败:", e)
      );
      return json({ ok: true });
    }

    // ── 其余业务操作转发到 Firebase Cloud Functions ──
    default:
      return forwardToFirebase(action, body, user, env);
  }
}

// ── 转发到 Firebase Cloud Functions ──────────────────

async function forwardToFirebase(action, body, user, env) {
  const baseUrl = env.FIREBASE_FUNCTIONS_URL;
  if (!baseUrl) {
    return json({ ok: false, error: "FIREBASE_FUNCTIONS_URL 未配置" }, 500);
  }

  const targetUrl = `${baseUrl}/api/${action}`;
  let resp;
  try {
    resp = await fetch(targetUrl, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-UID":           user.uid,
        "X-Can-Edit":      String(user.canEdit),
        "X-Role":          user.role,
        "X-Worker-Secret": env.WORKER_INTERNAL_SECRET ?? "",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return json(
      { ok: false, error: `转发到 Firebase 失败：${err.message}` },
      502
    );
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return json(
      { ok: false, error: `Firebase 响应解析失败，HTTP ${resp.status}` },
      502
    );
  }

  return json(data, resp.status);
}

// ── 影子日志写入 Firestore（REST API，无需 Admin SDK）──

async function writeShadowLog(entry, env) {
  const projectId   = env.FIREBASE_PROJECT_ID;
  if (!projectId) return;

  const firestoreUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/shadow_logs`;

  await fetch(firestoreUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        uid:       { stringValue:  entry.uid },
        txId:      { stringValue:  entry.txId ?? "" },
        gasStatus: { stringValue:  entry.gasStatus },
        gasMs:     { integerValue: String(entry.gasMs ?? 0) },
        error:     { stringValue:  entry.error ?? "" },
        ts:        { stringValue:  entry.ts },
      },
    }),
  });
}

// ── 工具函数 ──────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
