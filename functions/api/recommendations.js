/**
 * GET /api/recommendations
 * 管理端拉取全部推荐列表（需鉴权：请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对）。
 * 可选查询参数：status=pending|approved|rejected、limit（默认 200，上限 500）
 *
 * 绑定要求：DB（D1）、环境变量：ADMIN_TOKEN
 */

import {
  preflight, json, fail, isAdmin, unauthorized,
  mapRecommendation, errText
} from './_utils.js';

const STATUS_SET = ['pending', 'approved', 'rejected'];

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!isAdmin(request, env)) return unauthorized(request);
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const url = new URL(request.url);
    const status = (url.searchParams.get('status') || '').trim();
    let limit = parseInt(url.searchParams.get('limit') || '200', 10);
    if (!limit || limit < 1) limit = 200;
    if (limit > 500) limit = 500;

    let rs;
    if (status && STATUS_SET.indexOf(status) >= 0) {
      rs = await env.DB.prepare(
        'SELECT * FROM recommendations WHERE status = ? ORDER BY submitted_at DESC LIMIT ?'
      ).bind(status, limit).all();
    } else {
      rs = await env.DB.prepare(
        'SELECT * FROM recommendations ORDER BY submitted_at DESC LIMIT ?'
      ).bind(limit).all();
    }

    const items = ((rs && rs.results) || []).map(mapRecommendation);
    const counts = { all: items.length, pending: 0, approved: 0, rejected: 0 };
    for (let i = 0; i < items.length; i++) {
      const st = items[i].status || 'pending';
      if (counts[st] === undefined) counts[st] = 0;
      counts[st]++;
    }

    return json({
      ok: true,
      count: items.length,
      counts: counts,
      items: items,
      updatedAt: new Date().toISOString()
    }, 200, request);
  } catch (err) {
    return fail('拉取推荐列表失败：' + errText(err), 500, request);
  }
}
