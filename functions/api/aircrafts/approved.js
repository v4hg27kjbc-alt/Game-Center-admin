/**
 * GET /api/aircrafts/approved
 * 返回已采纳机型列表，供主站与已有机型数据合并展示（标注「该机型为用户添加」）。
 * 可选查询参数：limit（默认 200，上限 500）
 *
 * 绑定要求：DB（D1）
 */

import { preflight, json, fail, mapRecommendation, errText } from '../_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const url = new URL(request.url);
    let limit = parseInt(url.searchParams.get('limit') || '200', 10);
    if (!limit || limit < 1) limit = 200;
    if (limit > 500) limit = 500;

    const rs = await env.DB.prepare(
      "SELECT * FROM recommendations WHERE status = 'approved' " +
      'ORDER BY reviewed_at DESC, submitted_at DESC LIMIT ?'
    ).bind(limit).all();

    const items = ((rs && rs.results) || []).map(mapRecommendation);

    return json({
      ok: true,
      count: items.length,
      items: items,
      updatedAt: new Date().toISOString()
    }, 200, request);
  } catch (err) {
    return fail('拉取已采纳机型失败：' + errText(err), 500, request);
  }
}
