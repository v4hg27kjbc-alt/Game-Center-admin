/**
 * POST /api/admin-logout
 * 登出：清除会话 Cookie（mv_admin）。
 * 无需鉴权（未登录调用同样返回 ok:true，保证幂等）。
 *
 * 响应：200 { ok:true } + Set-Cookie: mv_admin=; Max-Age=0
 *
 * 绑定要求：无
 */

import { preflight, json, fail, errText, sessionClearCookie } from './_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request }) {
  try {
    return json({ ok: true }, 200, request, { 'Set-Cookie': sessionClearCookie() });
  } catch (err) {
    return fail('登出失败：' + errText(err), 500, request);
  }
}
