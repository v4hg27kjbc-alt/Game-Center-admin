/**
 * functions/api/_utils.js
 * 公共工具：跨域处理、管理员鉴权、统一 JSON 响应、请求体解析、字段映射。
 *
 * 注意：Pages Functions 不会把以 "_" 开头的文件注册为路由，
 *      因此本文件只作为模块被其他函数 import，不会暴露成接口。
 */

/** 主站域名（允许跨域访问本接口） */
export const MAIN_SITE_ORIGIN = 'https://henry126923.pages.dev';

/** 允许跨域来源白名单 */
export const ALLOWED_ORIGINS = [
  MAIN_SITE_ORIGIN,
  'https://henry126923-admincenter.pages.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

/** 生成 CORS 响应头 */
export function corsHeaders(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : MAIN_SITE_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

/** 统一 JSON 响应 */
export function json(data, status = 200, request = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (request) Object.assign(headers, corsHeaders(request));
  return new Response(JSON.stringify(data), { status, headers });
}

/** 统一错误响应（错误兜底：任何异常都返回结构化 JSON，不抛出到边缘） */
export function fail(message, status = 400, request = null, extra = null) {
  const body = { ok: false, error: String(message || '未知错误') };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return json(body, status, request);
}

/** OPTIONS 预检：命中时返回 204，否则返回 null */
export function preflight(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return null;
}

/** 读取请求头里的管理令牌 */
export function adminTokenOf(request) {
  return request.headers.get('X-Admin-Token') || '';
}

/**
 * 管理员鉴权：请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对。
 * 未配置 ADMIN_TOKEN 时一律拒绝（避免接口裸奔）。
 */
export function isAdmin(request, env) {
  const expect = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
  if (!expect) return false;
  const token = adminTokenOf(request);
  if (!token || token.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(request) {
  return fail('未授权：请在请求头携带正确的 X-Admin-Token', 401, request);
}

export function nowIso() {
  return new Date().toISOString();
}

export function genId(prefix) {
  return (prefix || 'rec') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 读取请求体：兼容 application/json 与纯文本 JSON */
export async function readBody(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.indexOf('application/json') >= 0) {
    try { return (await request.json()) || {}; } catch (e) { return {}; }
  }
  try {
    const txt = await request.text();
    if (!txt) return {};
    return JSON.parse(txt);
  } catch (e) {
    return {};
  }
}

/** 字符串清洗：去空白 + 截断 */
export function str(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return (max && s.length > max) ? s.slice(0, max) : s;
}

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic'
};

/** 解析 dataURL（data:image/jpeg;base64,xxxx）为 { mime, ext, bytes } */
export function parseDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m) return null;
  const mime = (m[1] || 'image/jpeg').toLowerCase();
  const isB64 = !!m[2];
  const payload = m[3] || '';
  const ext = MIME_EXT[mime] || 'jpg';
  if (!isB64) {
    try {
      return { mime, ext, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
    } catch (e) {
      return null;
    }
  }
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, ext, bytes };
  } catch (e) {
    return null;
  }
}

/** 图片 key → 可访问 URL */
export function imageUrlOf(imageKey) {
  const k = str(imageKey, 500);
  if (!k) return '';
  if (/^https?:\/\//i.test(k)) return k;
  return '/api/image/' + k;
}

/** D1 行 → 主站/后台通用字段（camelCase） */
export function mapRecommendation(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    nameZh: row.nameZh || '',
    code: row.code || '',
    category: row.category || '',
    country: row.country || '',
    image_key: row.image_key || '',
    image: imageUrlOf(row.image_key),
    descZh: row.descZh || '',
    specs: row.specs || '',
    submittedAt: row.submitted_at || '',
    status: row.status || 'pending',
    reply: row.reply || '',
    reviewedAt: row.reviewed_at || ''
  };
}

/** 统一异常文本 */
export function errText(err, fallback) {
  return (err && err.message) ? err.message : (fallback || '未知错误');
}
