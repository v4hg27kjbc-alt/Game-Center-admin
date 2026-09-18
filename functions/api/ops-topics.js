/**
 * GET /api/ops-topics?days=30&limit=20
 * 运营选题榜（需鉴权：X-Admin-Token）：
 *   1) missingAircraft —— 用户想找但库里没有的机型 Top（来自主站自然语言找飞机检索日志）
 *   2) unansweredQuestions —— AI 答不上来的问题 Top（来自主站「问 AI」问答日志）
 *
 * 参数：
 *   days：统计窗口天数，默认 30，范围 1~180
 *   limit：每榜条数，默认 20，范围 1~50
 *
 * 绑定要求：DB（D1），表 search_logs / qa_logs
 */

import {
  preflight, json, fail, isAdmin, unauthorized, errText
} from './_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) return unauthorized(request);
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const url = new URL(request.url);
    let days = parseInt(url.searchParams.get('days') || '30', 10);
    if (!days || days < 1) days = 30;
    if (days > 180) days = 180;
    let limit = parseInt(url.searchParams.get('limit') || '20', 10);
    if (!limit || limit < 1) limit = 20;
    if (limit > 50) limit = 50;

    const since = new Date(Date.now() - days * 86400000).toISOString();

    // ---- 榜单 1：未命中检索（用户想找但库里没有） ----
    let missingRs = null;
    let unansweredRs = null;
    try {
      missingRs = await env.DB.prepare(
        'SELECT term, COUNT(*) AS cnt, MAX(created_at) AS last_at ' +
        'FROM search_logs WHERE created_at >= ? AND matched = 0 ' +
        'GROUP BY term ORDER BY cnt DESC, last_at DESC LIMIT ?'
      ).bind(since, limit).all();
    } catch (e) { missingRs = null; }

    // ---- 榜单 2：AI 答不上来的问题 ----
    try {
      unansweredRs = await env.DB.prepare(
        'SELECT question, COUNT(*) AS cnt, MAX(reason) AS reason, MAX(created_at) AS last_at ' +
        'FROM qa_logs WHERE created_at >= ? AND answered = 0 ' +
        'GROUP BY question ORDER BY cnt DESC, last_at DESC LIMIT ?'
      ).bind(since, limit).all();
    } catch (e) { unansweredRs = null; }

    // ---- 统计概览 ----
    let searchTotal = 0, searchMiss = 0, qaTotal = 0, qaMiss = 0;
    try {
      const r1 = await env.DB.prepare(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN matched = 0 THEN 1 ELSE 0 END) AS miss ' +
        'FROM search_logs WHERE created_at >= ?'
      ).bind(since).first();
      if (r1) { searchTotal = r1.total || 0; searchMiss = r1.miss || 0; }
    } catch (e) { /* 忽略 */ }
    try {
      const r2 = await env.DB.prepare(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN answered = 0 THEN 1 ELSE 0 END) AS miss ' +
        'FROM qa_logs WHERE created_at >= ?'
      ).bind(since).first();
      if (r2) { qaTotal = r2.total || 0; qaMiss = r2.miss || 0; }
    } catch (e) { /* 忽略 */ }

    const missingAircraft = ((missingRs && missingRs.results) || []).map(function (r) {
      return { term: r.term || '', count: r.cnt || 0, lastAt: r.last_at || '' };
    });
    const unansweredQuestions = ((unansweredRs && unansweredRs.results) || []).map(function (r) {
      return { question: r.question || '', count: r.cnt || 0, reason: r.reason || '', lastAt: r.last_at || '' };
    });

    return json({
      ok: true,
      days: days,
      limit: limit,
      since: since,
      stats: {
        searchTotal: searchTotal,
        searchMiss: searchMiss,
        searchMissRate: searchTotal ? Math.round((searchMiss / searchTotal) * 100) : 0,
        qaTotal: qaTotal,
        qaMiss: qaMiss,
        qaMissRate: qaTotal ? Math.round((qaMiss / qaTotal) * 100) : 0
      },
      missingAircraft: missingAircraft,
      unansweredQuestions: unansweredQuestions,
      updatedAt: new Date().toISOString()
    }, 200, request);
  } catch (err) {
    return fail('拉取运营选题失败：' + errText(err), 500, request);
  }
}
