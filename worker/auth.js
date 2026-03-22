// v2-app/worker/auth.js
// 职责：Firebase ID Token 验证，提取 uid 和 Custom Claims
// 依赖：无
// 导出：verifyToken(token, env) → { uid, canEdit, role } | null

const JWKS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/**
 * 验证 Firebase ID Token（JWT RS256）
 * 返回解码后的 payload，验证失败返回 null
 * @param {string} token
 * @param {{ FIREBASE_PROJECT_ID: string }} env
 * @returns {Promise<{ uid: string, canEdit: boolean, role: string } | null>}
 */
export async function verifyToken(token, env) {
  if (!token || typeof token !== "string") return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // 1. 解码 Header，取 kid
    const header = JSON.parse(atob(parts[0]));
    if (header.alg !== "RS256") return null;

    // 2. 获取 Google 公钥
    const jwksResp = await fetch(JWKS_URL, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!jwksResp.ok) return null;
    const jwks = await jwksResp.json();
    const pubKeyPem = jwks[header.kid];
    if (!pubKeyPem) return null;

    // 3. 导入公钥
    const cryptoKey = await importRsaPublicKey(pubKeyPem);

    // 4. 验证签名
    const signedData = new TextEncoder().encode(
      parts[0] + "." + parts[1]
    );
    const signature = base64UrlDecode(parts[2]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedData
    );
    if (!valid) return null;

    // 5. 验证 Payload Claims
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) return null;
    if (payload.aud !== env.FIREBASE_PROJECT_ID) return null;
    if (payload.exp < now) return null;
    if (payload.iat > now + 60) return null; // 容忍 60 秒时钟偏差
    if (!payload.sub) return null;

    return {
      uid:     payload.sub,
      canEdit: payload.canEdit === true,
      role:    payload.role || "viewer",
    };
  } catch {
    return null;
  }
}

// ── 内部工具函数 ──────────────────────────────────────

async function importRsaPublicKey(pem) {
  const pemContents = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  const der = base64Decode(pemContents);

  return await crypto.subtle.importKey(
    "spki",
    extractSpkiFromCert(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function extractSpkiFromCert(certDer) {
  // X.509 TBSCertificate → SubjectPublicKeyInfo
  const view = new Uint8Array(certDer);
  let i = 0;
  i = skipTag(view, i); // 外层 SEQUENCE
  i = skipTag(view, i); // TBSCertificate SEQUENCE
  // version, serialNumber, signature, issuer, validity, subject
  for (let skip = 0; skip < 6; skip++) i = skipTag(view, i);
  // 现在 i 指向 SubjectPublicKeyInfo SEQUENCE
  const spkiLen = tlvLength(view, i);
  return certDer.slice(i, i + spkiLen);
}

function skipTag(view, offset) {
  offset++; // tag byte
  const lenByte = view[offset++];
  if (lenByte < 0x80) return offset + lenByte;
  const numBytes = lenByte & 0x7f;
  let len = 0;
  for (let n = 0; n < numBytes; n++) len = (len << 8) | view[offset++];
  return offset + len;
}

function tlvLength(view, offset) {
  let i = offset;
  i++; // tag
  const lenByte = view[i++];
  if (lenByte < 0x80) return (i - offset) + lenByte;
  const numBytes = lenByte & 0x7f;
  let len = 0;
  for (let n = 0; n < numBytes; n++) len = (len << 8) | view[i++];
  return (i - offset) + len;
}

function base64UrlDecode(str) {
  return base64Decode(str.replace(/-/g, "+").replace(/_/g, "/"));
}

function base64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
