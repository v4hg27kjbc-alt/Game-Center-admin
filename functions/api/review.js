/**
 * POST /api/review
 * 管理端采纳 / 驳回推荐机型，并写回反馈文字（需鉴权：X-Admin-Token）。
 * 请求体：{ id, status: 'approved' | 'rejected', reply }
 *
 * 绑定要求：DB（D1）、环境变量：ADMIN_TOKEN
 */

import {
  preflight, json, fail, isAdmin, unauthorized, readBody,
  str, nowIso, mapRecommendation, errText
} from './_utils.js';

const ALLOW_STATUS = ['approved', 'rejected'];

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) return unauthorized(request);
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const body = await readBody(request);
    const id = str(body.id, 80);
    const status = str(body.status, 20).toLowerCase();
    const reply = str(body.reply, 2000);

    if (!id) return fail('缺少必填字段：id', 400, request);
    if (ALLOW_STATUS.indexOf(status) < 0) {
      return fail("status 仅支持 'approved'（采纳）或 'rejected'（驳回）", 400, request);
    }

    const reviewedAt = nowIso();
    const rs = await env.DB.prepare(
      'UPDATE recommendations SET status = ?, reply = ?, reviewed_at = ? WHERE id = ?'
    ).bind(status, reply, reviewedAt, id).run();

    const changed = (rs && rs.meta && typeof rs.meta.changes === 'number') ? rs.meta.changes : null;
    if (changed === 0) return fail('未找到对应推荐记录：' + id, 404, request);

    const row = await env.DB.prepare('SELECT * FROM recommendations WHERE id = ?').bind(id).first();

    return json({
      ok: true,
      id: id,
      status: status,
      reply: reply,
      reviewedAt: reviewedAt,
      item: mapRecommendation(row)
    }, 200, request);
  } catch (err) {
    return fail('审核写回失败：' + errText(err), 500, request);
  }
}
