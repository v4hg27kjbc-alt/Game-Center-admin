/**
 * GET /api/news
 * 返回 KV（绑定名 NEWS_KV）中的每日航空快讯缓存，由独立定时 Worker 写入。
 * 缓存 key：news:latest，值结构：{ updatedAt, date, source, items: [{ title, url, time, snippet }] }
 * 其中 snippet 为内容简介（由 news-refresh / 定时 Worker 抓取源 description 生成），原样透传给前端。
 *
 * 绑定要求：NEWS_KV（KV）
 */

import { preflight, json, fail, errText } from './_utils.js';

export const NEWS_KV_KEY = 'news:latest';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.NEWS_KV) return fail('服务端未配置 KV 绑定（NEWS_KV）', 500, request);

    const raw = await env.NEWS_KV.get(NEWS_KV_KEY);
    if (!raw) {
      return json({
        ok: true,
        updatedAt: '',
        items: [],
        fetched: false,
        message: '暂无快讯缓存，等待定时任务首次写入'
      }, 200, request);
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return fail('快讯缓存解析失败（KV 内容不是合法 JSON）', 500, request);
    }

    return json({
      ok: true,
      updatedAt: data.updatedAt || '',
      date: data.date || '',
      source: data.source || '',
      fetched: data.fetched !== false,
      count: Array.isArray(data.items) ? data.items.length : 0,
      items: Array.isArray(data.items) ? data.items : []
    }, 200, request);
  } catch (err) {
    return fail('读取快讯缓存失败：' + errText(err), 500, request);
  }
}
