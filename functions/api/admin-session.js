/**
 * GET /api/admin-session
 * 会话检测：读取会话 Cookie 并校验签名 / 有效期，返回当前登录态。
 * 未登录不返回 401（前端用它仅刷新状态行，不应触发错误提示）。
 *
 * 响应：200 { ok:true, authenticated:true|false, username }
 *
 * 绑定要求：无
 * 环境变量：ADMIN_TOKEN（会话签名密钥；未配置时 authenticated 恒为 false）
 */

import { preflight, json, verifySession } from './_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    const s = await verifySession(request, env);
    return json({
      ok: true,
      authenticated: !!s,
      username: s ? String(s.u || '') : ''
    }, 200, request);
  } catch (err) {
    return json({ ok: true, authenticated: false, username: '' }, 200, request);
  }
}
