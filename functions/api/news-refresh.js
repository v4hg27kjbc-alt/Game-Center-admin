/**
 * POST /api/news-refresh
 * 手动刷新「今日航空快讯」：管理员在后台点击「立即刷新快讯」时调用。
 * ------------------------------------------------------------------
 * 鉴权：请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对（复用 _utils.isAdmin），
 *       未授权一律返回 401 结构化 JSON。
 * 流程：依次尝试多个航空快讯 RSS 源 → 解析条目 → 写入 KV（绑定名 NEWS_KV，
 *       key = news:latest，结构 { updatedAt, date, source, items: [{ title, url, time }] }）。
 * 兜底：与定时 Worker 保持一致 —— 任一源异常记录错误并尝试下一个源；全部失败时
 *       不覆盖历史缓存，返回 502 结构化 JSON（含 errors 明细），绝不抛出异常。
 * 其余失败（非 POST、KV 未绑定、内部异常）同样返回结构化 JSON。
 *
 * 绑定要求：NEWS_KV（KV 命名空间）
 * 环境变量：ADMIN_TOKEN（管理令牌）
 */

import { preflight, json, fail, unauthorized, isAdmin, nowIso, errText } from './_utils.js';

export const NEWS_KV_KEY = 'news:latest';
const LAST_RUN_KEY = 'news:last_run';
const MAX_ITEMS = 12;
const FETCH_TIMEOUT_MS = 12000;

/** 快讯源列表：按顺序尝试，命中即用（与 worker/news-cron.js 保持一致） */
const SOURCES = [
  { name: '中国民航网', url: 'http://www.caacnews.com.cn/rss.xml' },
  { name: '民航资源网', url: 'https://www.carnoc.com/rss/news.xml' },
  {
    name: 'Google News 民航',
    url: 'https://news.google.com/rss/search?q=%E6%B0%91%E8%88%AA%E5%AE%A2%E6%9C%BA&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
  }
];

function ymd() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function stripCdata(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

function decodeEntities(s) {
  return String(s).replace(/&[a-zA-Z#0-9]+;/g, (m) => {
    if (ENT[m]) return ENT[m];
    const mm = /^&#(\d+);$/.exec(m);
    if (mm) return String.fromCharCode(parseInt(mm[1], 10));
    return m;
  });
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

function pick(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = re.exec(block);
  if (!m) return '';
  return decodeEntities(stripTags(stripCdata(m[1]))).replace(/\s+/g, ' ').trim();
}

/** 极简 RSS / Atom 解析：不依赖 DOM，取标题、链接、时间 */
function parseFeed(xml, sourceName) {
  const items = [];
  const raw = String(xml || '');
  const blocks = raw.match(/<item[\s\S]*?<\/item>/gi) || raw.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (let i = 0; i < blocks.length; i++) {
    if (items.length >= MAX_ITEMS) break;
    const b = blocks[i];
    const title = pick(b, 'title');
    if (!title) continue;
    let link = pick(b, 'link');
    if (!link) {
      const m = /<link[^>]*href="([^"]+)"/i.exec(b);
      if (m) link = decodeEntities(m[1]);
    }
    const time = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date');
    items.push({
      title: title.slice(0, 160),
      url: link || '',
      time: time || ''
    });
  }
  return items;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'MarvisNewsBot/1.0 (+https://henry126923.pages.dev)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取 → 写入 KV → 返回本次实际生效的载荷。
 * @returns {Promise<{ok: boolean, payload: object|null, errors: string[]}>}
 */
async function refreshNews(env) {
  const errors = [];
  for (const src of SOURCES) {
    try {
      const res = await fetchWithTimeout(src.url, FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const xml = await res.text();
      const items = parseFeed(xml, src.name);
      if (!items.length) {
        errors.push(src.name + '：解析结果为空');
        continue;
      }
      const payload = {
        updatedAt: nowIso(),
        date: ymd(),
        source: src.name,
        fetched: true,
        count: items.length,
        items: items
      };
      await env.NEWS_KV.put(NEWS_KV_KEY, JSON.stringify(payload), { expirationTtl: 172800 });
      await env.NEWS_KV.put(LAST_RUN_KEY, JSON.stringify({
        at: payload.updatedAt,
        ok: true,
        source: src.name,
        count: items.length,
        trigger: 'manual',
        errors: errors
      }), { expirationTtl: 172800 });
      return { ok: true, payload: payload, errors: errors };
    } catch (e) {
      errors.push(src.name + '：' + errText(e, '未知错误'));
    }
  }

  // 全部源失败：保留历史缓存，只记录失败，避免 /api/news 变空
  await env.NEWS_KV.put(LAST_RUN_KEY, JSON.stringify({
    at: nowIso(),
    ok: false,
    source: '',
    count: 0,
    trigger: 'manual',
    errors: errors
  }), { expirationTtl: 172800 });

  return { ok: false, payload: null, errors: errors };
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!isAdmin(request, env)) return unauthorized(request);
    if (!env.NEWS_KV) return fail('服务端未配置 KV 绑定（NEWS_KV）', 500, request);

    const result = await refreshNews(env);

    if (!result.ok) {
      return json({
        ok: false,
        error: '所有快讯源抓取失败，已保留历史缓存（详情见 errors）',
        updatedAt: '',
        date: ymd(),
        source: '',
        count: 0,
        items: [],
        errors: result.errors
      }, 502, request);
    }

    const p = result.payload;
    return json({
      ok: true,
      updatedAt: p.updatedAt || '',
      date: p.date || '',
      source: p.source || '',
      count: Array.isArray(p.items) ? p.items.length : 0,
      items: Array.isArray(p.items) ? p.items : [],
      warnings: result.errors,
      message: '快讯已刷新并写入 KV（news:latest）'
    }, 200, request);
  } catch (err) {
    return fail('刷新快讯失败：' + errText(err), 500, request);
  }
}

/** 非 POST 访问：明确返回 405，避免误用 GET 触发抓取 */
export async function onRequestGet({ request }) {
  return fail('请使用 POST 方式刷新快讯（需携带 X-Admin-Token 请求头）', 405, request);
}
