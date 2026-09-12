/**
 * POST /api/admin-password
 * 修改密码：校验旧密码后写入新密码（KV 随机 salt + sha256 哈希存储）。
 * 请求体：{ username, oldPassword, newPassword }
 *
 * 契约：
 *   未登录          → 401 { ok:false, error:'未授权：...' }
 *   新密码过短      → 400 { ok:false, error:'新密码至少 4 位' }
 *   旧密码错误      → 401 { ok:false, error:'原密码不正确' }
 *   服务端未配置密码 → 400 { ok:false, code:'not_configured', error:'服务端未配置管理密码' }
 *   保存失败        → 500 { ok:false, error:'服务端密码保存失败...' }
 *   成功            → 200 { ok:true, username, updatedAt }
 *
 * 鉴权：服务端会话 Cookie 优先，回退 X-Admin-Token（复用 _utils.isAdmin）
 * 绑定要求：NEWS_KV（存放 admin:auth）
 * 环境变量：ADMIN_TOKEN（会话签名密钥）、ADMIN_USER（默认 henry）、ADMIN_PASSWORD（回退明文密码）
 */

import {
  preflight, json, fail, unauthorized, isAdmin, readBody, str, errText,
  verifyAdminCredentials, setAdminPassword
} from './_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) return unauthorized(request);

    const body = await readBody(request);
    const username = str(body.username, 80);
    const oldPassword = (body.oldPassword === undefined || body.oldPassword === null) ? '' : String(body.oldPassword);
    const newPassword = (body.newPassword === undefined || body.newPassword === null) ? '' : String(body.newPassword);

    if (!newPassword || newPassword.length < 4) {
      return json({ ok: false, error: '新密码至少 4 位' }, 400, request);
    }

    const verdict = await verifyAdminCredentials(env, username, oldPassword);
    if (verdict === 'not_configured') {
      return json({ ok: false, code: 'not_configured', error: '服务端未配置管理密码' }, 400, request);
    }
    if (verdict !== true) {
      return json({ ok: false, error: '原密码不正确' }, 401, request);
    }

    const done = await setAdminPassword(env, username, newPassword);
    if (!done) return fail('服务端密码保存失败（需配置 KV 绑定 NEWS_KV）', 500, request);

    return json({
      ok: true,
      username: username,
      updatedAt: new Date().toISOString()
    }, 200, request);
  } catch (err) {
    return fail('修改密码失败：' + errText(err), 500, request);
  }
}
