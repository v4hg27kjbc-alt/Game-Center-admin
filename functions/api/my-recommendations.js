/**
 * GET /api/my-recommendations?uid=xxx
 * 按匿名 ID 返回本人推荐列表（含状态 status 与管理员反馈 reply），供主站「我的推荐」展示进度。
 *
 * 绑定要求：DB（D1）
 */

import { preflight, json, fail, mapRecommendation, errText } from './_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const url = new URL(request.url);
    const uid = (url.searchParams.get('uid') || '').trim();
    if (!uid) return fail('缺少参数：uid', 400, request);

    let limit = parseInt(url.searchParams.get('limit') || '100', 10);
    if (!limit || limit < 1) limit = 100;
    if (limit > 200) limit = 200;

    const rs = await env.DB.prepare(
      'SELECT * FROM recommendations WHERE uid = ? ORDER BY submitted_at DESC LIMIT ?'
    ).bind(uid, limit).all();

    const items = ((rs && rs.results) || []).map(mapRecommendation);
    return json({ ok: true, uid: uid, count: items.length, items: items }, 200, request);
  } catch (err) {
    return fail('查询失败：' + errText(err), 500, request);
  }
}
