/**
 * /api/trial-feedback —— 内测文章「选题投票 + 读后评价」只读汇总（后台）
 *
 * 数据来源：主站 /api/account 写入 SMS_KV
 *   vote:counts:v1  → { articleId: { option: 票数 } }
 *   vote:list:v1    → [{ uid, articleId, option, at }]
 *   feedback:list:v1→ [{ uid, username, articleId, score, text, at }]
 *
 * 鉴权：admin 会话（mv_admin Cookie）或 X-Admin-Token。
 *
 * 路由：
 *   GET /api/trial-feedback?limit=100   汇总投票统计 + 评价列表
 */

import { preflight, json, fail, isAdmin, adminTokenOf } from './_utils.js';

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}

async function readJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const kv = kvOf(env);
  if (!kv) return fail('存储未绑定', 500, request);

  const admin = await isAdmin(request, env);
  if (!admin) return fail('未授权', 401, request);

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') || '100', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 500) limit = 500;

  const counts = await readJson(kv, 'vote:counts:v1', {});
  const voteList = await readJson(kv, 'vote:list:v1', []);
  const feedback = await readJson(kv, 'feedback:list:v1', []);

  const voteRows = Array.isArray(voteList) ? voteList.slice(0, limit) : [];
  const fbRows = Array.isArray(feedback) ? feedback.slice(0, limit) : [];

  // 按文章聚合：票数总量 + 评价数量与均分
  const byArticle = {};
  const countObj = (counts && typeof counts === 'object' && !Array.isArray(counts)) ? counts : {};
  Object.keys(countObj).forEach(function (aid) {
    const opt = countObj[aid] || {};
    let total = 0;
    Object.keys(opt).forEach(function (k) { total += Number(opt[k] || 0) || 0; });
    byArticle[aid] = { articleId: aid, options: opt, totalVotes: total, feedbackCount: 0, avgScore: 0, _sum: 0 };
  });
  fbRows.forEach(function (f) {
    const aid = String((f && f.articleId) || '');
    if (!aid) return;
    if (!byArticle[aid]) byArticle[aid] = { articleId: aid, options: {}, totalVotes: 0, feedbackCount: 0, avgScore: 0, _sum: 0 };
    byArticle[aid].feedbackCount += 1;
    byArticle[aid]._sum += Number((f && f.score) || 0) || 0;
  });
  const articles = Object.keys(byArticle).map(function (aid) {
    const a = byArticle[aid];
    a.avgScore = a.feedbackCount ? Math.round((a._sum / a.feedbackCount) * 10) / 10 : 0;
    delete a._sum;
    return a;
  }).sort(function (x, y) {
    if (y.totalVotes !== x.totalVotes) return y.totalVotes - x.totalVotes;
    return y.feedbackCount - x.feedbackCount;
  });

  return json({
    ok: true,
    summary: {
      voteTotal: voteRows.length,
      feedbackTotal: fbRows.length,
      articleCount: articles.length,
    },
    articles: articles,
    votes: voteRows,
    feedback: fbRows,
  }, 200, request);
}

export async function onRequestOptions(context) {
  return preflight(context.request);
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method === 'GET') return onRequestGet(context);
  return fail('不支持的方法', 405, request);
}
