/**
 * /api/maintenance —— 后台「维护控制」代理接口
 *
 * 管理端会话鉴权（mv_admin Cookie 或 X-Admin-Token）。
 * 所有读写最终落到主站 /api/maintenance（带主站 ADMIN_TOKEN）：
 *   GET  /api/maintenance               读当前状态/配置（转发主站 GET）
 *   POST /api/maintenance/config        保存维护配置（enabled/emoji/assetUrl/message/...）
 *   POST /api/maintenance/blocklist     保存黑名单（items 手机号/访客ID）
 *   POST /api/maintenance/verify-password  仅校验超管密码（不落地）
 * 超管密码：后台 SUPER_ADMIN_PASSWORD 环境变量；未配置时跳过（仅需管理令牌）。
 */

import { preflight, json, fail, readBody, isAdmin, adminTokenOf, errText } from './_utils.js';
import { MAIN_SITE_ORIGIN } from './_utils.js';

function constantTimeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

async function gate(request, env) {
  const sessionOk = await isAdmin(request, env);
  const token = adminTokenOf(request);
  if (!sessionOk && !token) return fail('需要管理员权限', 401, request);
  return null;
}

function superPasswordOk(body, env) {
  const expect = (env && env.SUPER_ADMIN_PASSWORD) ? String(env.SUPER_ADMIN_PASSWORD) : '';
  if (!expect) return true; // 未配置超管密码 → 放行
  const provided = (body && typeof body.superPassword === 'string') ? body.superPassword : '';
  return constantTimeEqual(provided, expect);
}

export async function onRequestGet({ request, env }) {
  try {
    const g = await gate(request, env);
    if (g) return g;
    const mainToken = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
    if (!mainToken) return fail('服务端未配置主站管理令牌（ADMIN_TOKEN）', 500, request);
    const upstream = await fetch(MAIN_SITE_ORIGIN + '/api/maintenance', {
      headers: { 'X-Admin-Token': mainToken, 'Accept': 'application/json' }
    });
    const text = await upstream.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (e) { payload = null; }
    if (!upstream.ok || !payload) return fail('主站维护接口暂不可用（' + upstream.status + '）', 502, request);
    const maint = payload.maintenance || {};
    const config = {
      maintenanceEnabled: !!maint.enabled,
      aiGate: !!payload.aiGate,
      message: maint.message || '站点维护中，请稍后再来',
      assetUrl: maint.assetUrl || maint.emoji || '',
      blocklist: Array.isArray(payload.blocklist) ? payload.blocklist : []
    };
    return json({ ok: true, status: payload.status || 'ok', config: config, source: payload.source || 'default' }, upstream.status, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return fail('维护状态读取失败：' + errText(e), 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const g = await gate(request, env);
    if (g) return g;

    const mainToken = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
    if (!mainToken) return fail('服务端未配置主站管理令牌（ADMIN_TOKEN）', 500, request);

    let body = null;
    try { body = await readBody(request); } catch (e) { return fail('请求体解析失败', 400, request); }
    const action = String(body && body.action || '');

    if (action === 'verify-password') {
      const expect = (env && env.SUPER_ADMIN_PASSWORD) ? String(env.SUPER_ADMIN_PASSWORD) : '';
      if (!expect) return json({ ok: true, configured: false, message: '未配置超管密码，当前无需验证' }, 200, request);
      if (!superPasswordOk(body, env)) return fail('super_password_required', '超管密码错误', 403, request);
      return json({ ok: true, configured: true, message: '超管密码验证通过' }, 200, request);
    }

    if (action !== 'save-config' && action !== 'save-blocklist') {
      return fail('未知操作：' + action, 400, request);
    }

    if (!superPasswordOk(body, env)) {
      return fail('super_password_required', '修改维护配置需要超管密码', 403, request);
    }

    const rawConfig = (action === 'save-config' && body.config && typeof body.config === 'object') ? body.config : null;
    // 后台前端契约使用 maintenanceEnabled，主站契约使用 enabled —— 转发前映射对齐
    const configForMain = rawConfig ? {
      enabled: !!rawConfig.maintenanceEnabled,
      emoji: rawConfig.emoji,
      assetUrl: rawConfig.assetUrl,
      message: rawConfig.message,
      aiGate: !!rawConfig.aiGate,
      appealUrl: rawConfig.appealUrl,
      blockReason: rawConfig.blockReason,
      subMessage: rawConfig.subMessage
    } : null;
    const payload = {
      action: action,
      config: configForMain,
      items: action === 'save-blocklist' ? body.items : undefined,
      superPassword: body.superPassword
    };
    if (action === 'save-config' && !configForMain) {
      return fail('缺少 config 字段', 400, request);
    }

    const upstream = await fetch(MAIN_SITE_ORIGIN + '/api/maintenance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': mainToken,
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    let out = null;
    try { out = JSON.parse(text); } catch (e) { out = null; }
    if (!upstream.ok || !out) return fail('主站写入失败（' + upstream.status + '）' + (text ? '：' + String(text).slice(0, 200) : ''), 502, request);
    return json(out, upstream.status, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return fail('维护配置保存失败：' + errText(e), 500, request);
  }
}
