/**
 * /api/my-feedback —— 访客自查「我的反馈记录」（v69）
 *
 * 绑定要求：DB（D1）
 * 表名：feedbacks（见 d1-migration-v67.sql / d1-migration-v68.sql）
 *
 * 用途：
 *   主站底部「我的反馈记录」按匿名标识 uid 拉取本人提交过的反馈，
 *   展示处理进度（status）与站长回复（reply）。属于自营后台闭环，不经过任何第三方平台。
 *
 * 接口契约：
 *   GET /api/my-feedback?uid=<匿名标识>&limit=50
 *     - uid 必填（主站本地生成的随机匿名标识，非账号凭证）
 *     - 无需管理员身份；仅返回该 uid 名下的反馈
 *     - 出于隐私保护，返回值不含姓名 / 手机号 / 邮箱 / uid 等个人信息
 *     → { ok: true, total, items: [{ id, type, content, status, reply, createdAt, reviewedAt }] }
 */

import { preflight, json, fail, str, errText } from './_utils.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** D1 行 → 访客可见结构（仅进度相关信息，剔除全部联系方式与身份字段） */
function mapMine(row) {
  if (!row) return null;
  return {
    id: row.id || '',
    type: row.type || '其他',
    content: row.content || '',
    status: row.status || 'new',
    reply: row.reply || '',
    createdAt: row.created_at || '',
    reviewedAt: row.reviewed_at || ''
  };
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const url = new URL(request.url);
    const uid = str(url.searchParams.get('uid') || '', 80);
    if (!uid) return fail('缺少必填参数：uid', 400, request);

    const limitRaw = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw, 1), MAX_LIMIT);

    const rs = await env.DB.prepare(
      'SELECT * FROM feedbacks WHERE uid = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(uid, limit).all();

    const rows = (rs && rs.results) ? rs.results : [];
    return json({
      ok: true,
      total: rows.length,
      items: rows.map(mapMine)
    }, 200, request);
  } catch (err) {
    return fail('我的反馈记录读取失败：' + errText(err), 500, request);
  }
}
