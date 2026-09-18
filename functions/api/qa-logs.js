/**
 * POST /api/qa-logs
 * 主站「问 AI」上报检索问答质量，用于后台沉淀「AI 答不上来的问题 Top 榜」。
 *
 * 请求体：{ q, reason, hits, answered, uid }
 *   - q：用户提问原文（≤200 字）
 *   - reason：'retrieval-empty'（D1 已采纳机型 + 内置库都没检索到）
 *             或 'insufficient-context'（检索到但上下文不足以支撑回答）
 *   - hits：检索命中的机型数量
 *   - answered：最终是否给出了基于站内资料的回答
 *
 * 绑定要求：DB（D1），表 qa_logs
 */

import {
  preflight, json, fail, readBody, str, nowIso, errText
} from './_utils.js';

const REASONS = ['retrieval-empty', 'insufficient-context', 'llm-failed'];

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const body = await readBody(request);
    const q = str(body.q || body.question, 200);
    if (!q) return fail('缺少必填字段：q（提问内容）', 400, request);

    let reason = str(body.reason, 40);
    if (REASONS.indexOf(reason) < 0) reason = 'retrieval-empty';

    let hits = parseInt(body.hits, 10);
    if (isNaN(hits) || hits < 0) hits = 0;
    if (hits > 100000) hits = 100000;

    const answered = body.answered ? 1 : 0;
    const uid = str(body.uid, 80);

    await env.DB.prepare(
      'INSERT INTO qa_logs (question, reason, hits, answered, uid, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(q, reason, hits, answered, uid, nowIso()).run();

    return json({ ok: true }, 200, request);
  } catch (err) {
    return fail('问答日志写入失败：' + errText(err), 500, request);
  }
}
