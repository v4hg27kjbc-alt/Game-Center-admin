/**
 * GET /api/token-usage —— Token 用量看板
 *
 * 管理端：后台会话（mv_admin Cookie）或 X-Admin-Token 鉴权。
 * 实现：转发主站 /api/admin/stats?days=N（携带主站 ADMIN_TOKEN），
 *       返回用量汇总 + 近 N 日趋势，供「Token 用量」分区渲染。
 *
 * 响应：200 { ok:true, data: { usage:{...}, byDay:[...], byModel:[...], generatedAt, storage } }
 *      主站不可用 → 502；未鉴权 → 401；未配置主站令牌 → 500
 */

import { preflight, json, fail, isAdmin, adminTokenOf, errText, str } from './_utils.js';
import { MAIN_SITE_ORIGIN } from './_utils.js';

function daysOf(queryString) {
  let days = 7;
  if (queryString) {
    const m = queryString.match(/[?&]days=(\d{1,3})/);
    if (m) days = Math.max(1, Math.min(90, parseInt(m[1], 10) || 7));
  }
  return days;
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    const sessionOk = await isAdmin(request, env);
    const token = adminTokenOf(request);
    if (!sessionOk && !token) return fail('需要管理员权限', 401, request);

    const mainToken = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
    if (!mainToken) return fail('服务端未配置主站管理令牌（ADMIN_TOKEN）', 500, request);

    const days = daysOf((request.url || '').split('?')[1] ? ('?' + (request.url || '').split('?')[1]) : '');
    const upstream = await fetch(MAIN_SITE_ORIGIN + '/api/admin/stats?days=' + days, {
      method: 'GET',
      headers: {
        'X-Admin-Token': mainToken,
        'Accept': 'application/json'
      }
    });

    let payload = null;
    const text = await upstream.text();
    try { payload = JSON.parse(text); } catch (e) { payload = null; }

    if (!upstream.ok || !payload || payload.ok !== true) {
      return fail('主站用量接口暂不可用（' + upstream.status + '）', 502, request);
    }

    const data = {
      usage: payload.usage || {},
      byDay: payload.byDay || [],
      byModel: payload.byModel || [],
      byProvider: payload.byProvider || [],
      byFeature: payload.byFeature || [],
      storage: payload.storage || 'unknown',
      generatedAt: payload.generatedAt || null
    };
    return json({ ok: true, data: data }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return fail('用量查询失败：' + errText(e), 500, request);
  }
}
