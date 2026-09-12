/**
 * POST /api/admin-login
 * 后台登录：校验用户名 / 密码，通过后签发 HttpOnly 会话 Cookie（mv_admin，7 天）。
 * 请求体：{ username, password }
 *
 * 契约：
 *   成功            → 200 { ok:true, username, role:'owner', expiresAt } + Set-Cookie: mv_admin=...
 *   凭据错误        → 401 { ok:false, code:'bad_credentials', error:'用户名或密码错误' }
 *   服务端未配置密码 → 200 { ok:false, code:'not_configured', error:'服务端未配置管理密码' }
 *   缺少字段        → 400 { ok:false, error:'请输入用户名和密码' }
 *   未配置签名密钥   → 500 { ok:false, error:'服务端未配置会话签名密钥（ADMIN_TOKEN）' }
 *
 * 绑定要求：NEWS_KV（可选，存放 admin:auth 密码记录）
 * 环境变量：ADMIN_TOKEN（会话签名密钥，同时作为密码兜底来源）、ADMIN_USER（默认 henry）、
 *          ADMIN_PASSWORD（回退明文密码；与 NEWS_KV 均未配置时回退用 ADMIN_TOKEN 作为密码校验）
 */

import {
  preflight, json, fail, readBody, str, errText,
  verifyAdminCredentials, signSession, sessionSetCookie
} from './_utils.js';

/** 会话有效期：7 天（秒） */
const SESSION_MAX_AGE = 604800;

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await readBody(request);
    const username = str(body.username, 80);
    const password = (body.password === undefined || body.password === null) ? '' : String(body.password);

    if (!username || !password) return fail('请输入用户名和密码', 400, request);

    const verdict = await verifyAdminCredentials(env, username, password);

    if (verdict === 'not_configured') {
      return json({
        ok: false,
        code: 'not_configured',
        error: '服务端未配置管理密码'
      }, 200, request);
    }
    if (verdict !== true) {
      return json({
        ok: false,
        code: 'bad_credentials',
        error: '用户名或密码错误'
      }, 401, request);
    }

    const exp = Date.now() + SESSION_MAX_AGE * 1000;
    const token = await signSession(env, { u: username, r: 'owner', exp: exp });
    if (!token) return fail('服务端未配置会话签名密钥（ADMIN_TOKEN）', 500, request);

    return json({
      ok: true,
      username: username,
      role: 'owner',
      expiresAt: new Date(exp).toISOString()
    }, 200, request, { 'Set-Cookie': sessionSetCookie(token, SESSION_MAX_AGE) });
  } catch (err) {
    return fail('登录失败：' + errText(err), 500, request);
  }
}
