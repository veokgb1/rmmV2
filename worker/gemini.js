// v2-app/worker/gemini.js
// 职责：封装所有 Gemini API 调用，Key 永不离开 Worker
// 依赖：无
// 导出：geminiOCR(body, env), geminiNLP(body, env)

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE  =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ── 公开接口 ──────────────────────────────────────────

/**
 * OCR：识别收据/发票图片
 * @param {{ base64: string, mime: string }} body
 * @param {{ GEMINI_API_KEY: string }} env
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
export async function geminiOCR(body, env) {
  const { base64, mime } = body;
  if (!base64 || !mime) {
    return { ok: false, error: "base64 和 mime 字段必填" };
  }

  const prompt = `分析这张发票/收据图片。只输出纯JSON，不要任何说明或代码块标记：
{"merchant":"商户名","amount":总金额数字或null,"date":"YYYY-MM-DD或null","items":["商品描述"],"invoice_type":"发票类型","summary":"一句话摘要"}
若不是有效票据则 amount 设 null。`;

  return callGemini({ prompt, base64, mime }, env);
}

/**
 * NLP：从自然语言文本提取账目
 * @param {{ text: string, categories?: string }} body
 * @param {{ GEMINI_API_KEY: string }} env
 * @returns {Promise<{ ok: boolean, data?: Array, error?: string }>}
 */
export async function geminiNLP(body, env) {
  const { text, categories } = body;
  if (!text || typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "text 字段必填且不能为空" };
  }

  const today = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  })
    .format(new Date())
    .replace(/\//g, "-");

  const catList =
    categories ||
    "餐饮,交通,购物,娱乐,医疗,教育,住房,水电气,办公,工资,投资,奖金,其他支出,其他收入";

  const prompt = `你是专业记账助手。从用户输入提取所有账目记录。
今天：${today}  可用分类：${catList}
规则：
1. 无明确日期则使用今天
2. 负数金额取绝对值并将类型改为"收入"
3. 只从可用分类列表中选择分类
4. 只输出纯JSON数组，不要代码块标记
格式：[{"date":"YYYY-MM-DD","type":"支出"|"收入","category":"分类","amount":正数,"summary":"描述"}]
用户输入："""${text}"""`;

  return callGemini({ prompt, base64: null, mime: null }, env);
}

// ── 内部实现 ──────────────────────────────────────────

/**
 * 统一 Gemini 调用入口
 * @param {{ prompt: string, base64: string|null, mime: string|null }} params
 * @param {{ GEMINI_API_KEY: string }} env
 */
async function callGemini({ prompt, base64, mime }, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY 未在 Worker Secrets 中配置" };
  }

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const parts = [];
  if (base64 && mime) {
    parts.push({ inline_data: { mime_type: mime, data: base64 } });
  }
  parts.push({ text: prompt });

  let resp;
  try {
    resp = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (err) {
    return { ok: false, error: `网络请求失败：${err.message}` };
  }

  let json;
  try {
    json = await resp.json();
  } catch {
    return { ok: false, error: `Gemini 响应解析失败，HTTP ${resp.status}` };
  }

  if (!resp.ok) {
    return {
      ok:    false,
      error: `Gemini API 错误 ${resp.status}：${json?.error?.message || "未知"}`,
    };
  }

  const raw =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch {
    return {
      ok:    false,
      error: `AI 返回格式无法解析：${cleaned.slice(0, 120)}`,
    };
  }
}
