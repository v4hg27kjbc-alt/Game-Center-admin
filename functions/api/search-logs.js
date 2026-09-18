/**
 * POST /api/search-logs
 * 主站「自然语言找飞机」上报检索行为，用于后台沉淀运营选题
 * （用户想找、但库里没有的机型）。
 *
 * 请求体：{ q, parsed, matched, uid }
 *   - q：用户原始口语输入（≤200 字）
 *   - parsed：AI 解析出的结构化条件（category / minRange / maxRange / engines / wideBody / airlineIds / keywords）
 *   - matched：本次命中机型数量，0 表示库里没有
 *   - uid：主站匿名标识（仅用于去重统计，不含个人信息）
 *
 * 绑定要求：DB（D1），表 search_logs
 */

import {
  preflight, json, fail, readBody, str, nowIso, errText
} from '../_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const body = await readBody(request);
    const q = str(body.q || body.term || body.query, 200);
    if (!q) return fail('缺少必填字段：q（检索词）', 400, request);

    let conds = body.parsed || body.conds || null;
    if (conds && typeof conds !== 'string') conds = JSON.stringify(conds);
    conds = str(conds, 600);

    let matched = parseInt(body.matched, 10);
    if (isNaN(matched) || matched < 0) matched = 0;
    if (matched > 100000) matched = 100000;

    const uid = str(body.uid, 80);

    await env.DB.prepare(
      'INSERT INTO search_logs (term, conds, matched, uid, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(q, conds, matched, uid, nowIso()).run();

    return json({ ok: true }, 200, request);
  } catch (err) {
    return fail('检索日志写入失败：' + errText(err), 500, request);
  }
}
