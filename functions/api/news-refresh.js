/**
 * POST /api/news-refresh
 * 手动刷新「今日航空快讯」：管理员在后台点击「立即刷新快讯」时调用。
 * ------------------------------------------------------------------
 * 鉴权：复用 _utils.isAdmin（优先校验服务端会话 Cookie mv_admin；
 *       会话无效时回退请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对），
 *       未授权返回 401 结构化 JSON；路由路径与既有约定保持不变。
 *
 * 抓取策略（v2 加固）：
 *   1) 多源「并行」抓取，单源失败不拖累其他源；
 *   2) 每个源带单源超时（SRC_TIMEOUT_MS）+ 独立重试（SOURCE_RETRIES 次，含退避），
 *      避免个别源慢响应把整体请求拖死；
 *   3) 任一源成功 → 合并多个成功源的条目、按 URL/标题去重，写入 KV（绑定名 NEWS_KV，
 *      key = news:latest，结构 { updatedAt, date, source, items: [{ title, url, time, snippet }] }），
 *      snippet 为各源 description/summary/content 清洗后的内容简介（后台与主站均据此展示）；
 *      响应保留原有字段 ok/updatedAt/date/source/count/items；
 *   4) 全部源失败 → 不再返回 502，改为读取 KV 中上一次成功的数据兜底返回，
 *      响应带 fallback:true 与逐源失败原因（sources / errors 诊断字段），
 *      供后台提示「源暂不可达，已展示上次数据」；
 *   5) 全部源失败且 KV 无历史数据时返回 HTTP 200 + ok:false + fallback:true + 诊断明细，
 *      同样不使用 5xx 状态码。
 *
 * 绑定要求：NEWS_KV（KV 命名空间）
 * 环境变量：ADMIN_TOKEN（管理令牌）
 */

import { preflight, json, fail, unauthorized, isAdmin, nowIso, errText } from './_utils.js';

export const NEWS_KV_KEY = 'news:latest';
const LAST_RUN_KEY = 'news:last_run';
const KV_TTL = 172800; // 2 天
const MAX_ITEMS_PER_SOURCE = 12; // 单源最多解析条数
const MAX_ITEMS_TOTAL = 24; // 合并去重后写入 KV 的总条数上限
const SRC_TIMEOUT_MS = 8000; // 单源单次抓取超时
const SOURCE_RETRIES = 2; // 单源尝试次数（1 次 + 1 次重试）
const RETRY_DELAY_MS = 600; // 重试前退避

/** 快讯源列表：并行尝试，各自独立超时与重试（与 worker/news-cron.js 保持一致） */
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // 部分源的字段经过 HTML 转义（如 &lt;a href=…&gt;），须先解码再剥标签，反复两次
  let s = stripCdata(m[1]);
  for (let i = 0; i < 2; i++) {
    s = stripTags(decodeEntities(s));
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 单条快讯内容简介的最大长度（字符） */
const SNIPPET_MAX = 300;

/**
 * 提取单条快讯的「内容简介」：
 *   依次尝试 description / summary / content:encoded / content，
 *   统一去标签、解码实体、压缩空白，超长截断。
 * 说明：历史实现只取 title / link / time，导致后台与主站每条快讯都没有简介可展示，
 *       此处补齐；取不到时返回空串，由上层按空简介处理。
 */
function pickSummary(block, title) {
  let s = pick(block, 'description')
    || pick(block, 'summary')
    || pick(block, 'content:encoded')
    || pick(block, 'content')
    || '';
  // 二次清洗：兜住「转义后再解码」暴露出来的残留标签
  s = decodeEntities(stripTags(decodeEntities(String(s)))).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  // 简介以标题开头 → 截去标题，剩余部分（多为来源站点名，如 Google News 的「标题+来源」）单独判断
  if (t && s.indexOf(t) === 0) {
    s = s.slice(t.length).replace(/^[\s\-–—|·:：,，.。]+/, '').trim();
  }
  const flat = s.replace(/\s+/g, '');
  if (!flat) return '';
  if (flat === t.replace(/\s+/g, '')) return '';
  // 过短（例如只剩一个来源名）视为无简介，交由「回源补抓」处理
  if (flat.length < SUMMARY_MIN_LEN) return '';
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX) + '…';
  return s;
}

/* ============================================================
   内容简介补抓：RSS 条目自带简介缺失时（如 Google News 只给标题），
   回源到新闻原文页，读取 og:description / description meta 作为简介。
   ------------------------------------------------------------
   注意：Cloudflare Workers 运行时的 TextDecoder 只能可靠解码 UTF-8，
   因此对声明为 GBK/BIG5 等非 UTF-8 的页面直接跳过，避免产出乱码简介。
   ============================================================ */
const SUMMARY_FETCH_LIMIT = 8; // 最多为前 N 条补抓原文简介
const SUMMARY_FETCH_TIMEOUT_MS = 4500; // 单篇原文抓取超时
const SUMMARY_CONCURRENCY = 4; // 并发数
const SUMMARY_MIN_LEN = 15; // 简介最短长度，过短视为无效

/** 从 HTML 头部提取 meta 简介 */
function extractMetaSummary(htmlText) {
  const head = String(htmlText || '').slice(0, 200 * 1024);
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']{10,900})["']/i,
    /<meta[^>]+content=["']([^"']{10,900})["'][^>]*property=["']og:description["']/i,
    /<meta[^>]+name=["'](?:description|Description)["'][^>]*content=["']([^"']{10,900})["']/i,
    /<meta[^>]+content=["']([^"']{10,900})["'][^>]*name=["'](?:description|Description)["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]*content=["']([^"']{10,900})["']/i
  ];
  for (const re of patterns) {
    const m = re.exec(head);
    if (!m || !m[1]) continue;
    const s = decodeEntities(stripTags(stripCdata(m[1]))).replace(/\s+/g, ' ').trim();
    if (s.length >= SUMMARY_MIN_LEN) return s.slice(0, SNIPPET_MAX);
  }
  return '';
}

/** 抓取单篇原文页的内容简介；任何异常都静默返回空串 */
async function fetchArticleSummary(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUMMARY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) return '';
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && ct.indexOf('html') < 0) return '';
    const cm = /charset=["']?([\w-]+)/i.exec(ct);
    // 非 UTF-8 页面（GBK/BIG5 等）无法在 Worker 中可靠解码，跳过以防乱码
    if (cm && !/^utf-?8$/i.test(cm[1])) return '';
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf.slice(0, 200 * 1024));
    if (!cm) {
      const meta = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(text.slice(0, 4000));
      if (meta && !/^utf-?8$/i.test(meta[1])) return '';
    }
    return extractMetaSummary(text);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** 为缺少简介的条目补抓原文简介（并发受限；失败静默跳过，不影响主流程） */
async function enrichSummaries(items) {
  const targets = items.slice(0, SUMMARY_FETCH_LIMIT);
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const it = targets[cursor++];
      if (!it || it.snippet) continue;
      const s = await fetchArticleSummary(it.url);
      if (s) it.snippet = s;
    }
  }
  const workers = [];
  for (let i = 0; i < SUMMARY_CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  return items;
}

/** 极简 RSS / Atom 解析：不依赖 DOM，取标题、链接、时间、内容简介 */
function parseFeed(xml) {
  const items = [];
  const raw = String(xml || '');
  const blocks = raw.match(/<item[\s\S]*?<\/item>/gi) || raw.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (let i = 0; i < blocks.length; i++) {
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
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
      time: time || '',
      snippet: pickSummary(b, title)
    });
  }
  return items;
}

/** 单次抓取（带超时） */
async function fetchOnce(url, ms) {
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
 * 单个源：独立超时 + 独立重试，永不抛错（失败以结构化结果返回）。
 * @returns {Promise<{name:string,url:string,ok:boolean,count:number,attempts:number,error:string,items:Array}>}
 */
async function fetchSource(src) {
  let lastError = '';
  for (let attempt = 1; attempt <= SOURCE_RETRIES; attempt++) {
    try {
      const res = await fetchOnce(src.url, SRC_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const xml = await res.text();
      const items = parseFeed(xml);
      if (!items.length) throw new Error('解析结果为空');
      return { name: src.name, url: src.url, ok: true, count: items.length, attempts: attempt, error: '', items: items };
    } catch (e) {
      lastError = errText(e, '未知错误');
      if (attempt < SOURCE_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  return { name: src.name, url: src.url, ok: false, count: 0, attempts: SOURCE_RETRIES, error: lastError || '抓取失败', items: [] };
}

/** 合并多源结果：按 url / 标题去重，保持源优先级顺序，限制总条数 */
function mergeItems(successList) {
  const seen = new Set();
  const merged = [];
  for (const s of successList) {
    for (const it of s.items) {
      const key = String(it.url || '').trim().toLowerCase() || String(it.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
      if (merged.length >= MAX_ITEMS_TOTAL) return merged;
    }
  }
  return merged;
}

/** 源名拼接：单源用原名称，多源用「A + B」 */
function sourceLabel(successList) {
  return successList.map((s) => s.name).join(' + ');
}

/** 逐源诊断（供后台展示与排障；不暴露内部堆栈） */
function diagnosticsOf(results) {
  return results.map((r) => ({
    name: r.name,
    ok: r.ok,
    count: r.count,
    attempts: r.attempts,
    error: r.error || ''
  }));
}

/** 读取 KV 上一次成功缓存（容错：内容损坏时返回 null） */
async function readCache(env) {
  try {
    const raw = await env.NEWS_KV.get(NEWS_KV_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (e) {
    return null;
  }
}

async function writeLastRun(env, payload) {
  try {
    await env.NEWS_KV.put(LAST_RUN_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL });
  } catch (e) {
    // 记录失败不影响主流程
  }
}

/** 兜底：返回 KV 中上一次成功的数据 */
async function fallbackResponse(env, request, results, errors) {
  const diagnostics = diagnosticsOf(results);
  const cached = await readCache(env);
  const cachedItems = (cached && Array.isArray(cached.items)) ? cached.items : [];

  await writeLastRun(env, {
    at: nowIso(), ok: false, source: '', count: 0, trigger: 'manual', fallback: true, errors: errors, sources: diagnostics
  });

  if (cachedItems.length) {
    return json({
      ok: true,
      updatedAt: cached.updatedAt || '',
      date: cached.date || ymd(),
      source: cached.source || '',
      count: cachedItems.length,
      items: cachedItems,
      fallback: true,
      cached: true,
      sources: diagnostics,
      errors: errors,
      message: '快讯源暂不可达，已展示上次数据（' + (cached.updatedAt || '时间未知') + '）'
    }, 200, request);
  }

  return json({
    ok: false,
    updatedAt: '',
    date: ymd(),
    source: '',
    count: 0,
    items: [],
    fallback: true,
    cached: false,
    sources: diagnostics,
    errors: errors,
    error: '所有快讯源暂不可达，且暂无历史缓存',
    message: '快讯源暂不可达，且暂无历史缓存，请稍后重试'
  }, 200, request);
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) return unauthorized(request);
    if (!env.NEWS_KV) return fail('服务端未配置 KV 绑定（NEWS_KV）', 500, request);

    // 1) 多源并行抓取：每个源各自超时 + 各自重试，单个源失败不影响其他源
    const results = await Promise.all(SOURCES.map((src) => fetchSource(src)));
    const okList = results.filter((r) => r.ok && r.items.length);
    const errors = results.filter((r) => !r.ok).map((r) => r.name + '：' + (r.error || '抓取失败'));
    const diagnostics = diagnosticsOf(results);

    // 2) 全部失败：不返回 502，读取 KV 上次成功数据兜底
    if (!okList.length) {
      return fallbackResponse(env, request, results, errors);
    }

    // 3) 合并去重后写入 KV；对缺少简介的条目回源原文补抓（失败静默跳过）
    const items = mergeItems(okList);
    await enrichSummaries(items);
    const payload = {
      updatedAt: nowIso(),
      date: ymd(),
      source: sourceLabel(okList),
      fetched: true,
      count: items.length,
      items: items
    };
    await env.NEWS_KV.put(NEWS_KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL });
    await writeLastRun(env, {
      at: payload.updatedAt, ok: true, source: payload.source, count: items.length,
      trigger: 'manual', sources: diagnostics, errors: errors
    });

    return json({
      ok: true,
      updatedAt: payload.updatedAt,
      date: payload.date,
      source: payload.source,
      count: items.length,
      items: items,
      fallback: false,
      cached: false,
      partial: errors.length > 0,
      sources: diagnostics,
      errors: errors,
      warnings: errors,
      message: errors.length
        ? '快讯已更新（' + okList.length + ' 个源成功，' + errors.length + ' 个源失败）'
        : '快讯已刷新并写入 KV（news:latest）'
    }, 200, request);
  } catch (err) {
    // 4) 内部异常同样兜底：优先用 KV 上次数据，避免后台直接报「拉取失败」
    try {
      const cached = await readCache(env);
      const cachedItems = (cached && Array.isArray(cached.items)) ? cached.items : [];
      if (cachedItems.length) {
        return json({
          ok: true,
          updatedAt: cached.updatedAt || '',
          date: cached.date || ymd(),
          source: cached.source || '',
          count: cachedItems.length,
          items: cachedItems,
          fallback: true,
          cached: true,
          sources: [],
          errors: [errText(err, '未知错误')],
          message: '刷新异常，已展示上次数据'
        }, 200, request);
      }
    } catch (e) {
      // 忽略兜底读取异常，走下面的结构化错误
    }
    return json({
      ok: false,
      updatedAt: '',
      date: ymd(),
      source: '',
      count: 0,
      items: [],
      fallback: true,
      cached: false,
      sources: [],
      errors: [errText(err, '未知错误')],
      error: '刷新快讯失败：' + errText(err, '未知错误')
    }, 200, request);
  }
}

/** 非 POST 访问：明确返回 405，避免误用 GET 触发抓取 */
export async function onRequestGet({ request }) {
  return fail('请使用 POST 方式刷新快讯（需携带 X-Admin-Token 请求头）', 405, request);
}
