/**
 * 独立 Worker：每日定时抓取航空快讯并写入 KV
 * ------------------------------------------------------------------
 * 职责：Cron Triggers 触发 → 依次尝试多个快讯源 → 解析出条目 →
 *       写入 KV（绑定名 NEWS_KV，key = news:latest）→ 记录本次执行结果。
 * 兜底：任一源异常只记录错误并尝试下一个源；全部失败时保留历史缓存不覆盖，
 *       仅写入失败记录（news:last_run），保证 /api/news 不会返回空数据。
 *
 * 绑定要求：NEWS_KV（KV 命名空间）
 * 环境变量：TRIGGER_KEY（可选，用于手动触发 /run 时鉴权）
 * 部署：wrangler.toml 中配置 [triggers] crons = ["0 22 * * *"]（UTC 22:00 = 北京时间 06:00）
 */

const NEWS_KV_KEY = 'news:latest';
const LAST_RUN_KEY = 'news:last_run';
const MAX_ITEMS = 12;
const FETCH_TIMEOUT_MS = 12000;

/* 内容简介（snippet）：RSS 自带简介缺失时回源原文页抓取 og:description / description meta。
   注意：Workers 运行时 TextDecoder 仅能可靠解码 UTF-8，遇 GBK/BIG5 页面直接跳过以防乱码。 */
const SNIPPET_MAX = 300; // 简介最长字数
const SUMMARY_FETCH_LIMIT = 8; // 最多为前 N 条补抓原文简介
const SUMMARY_FETCH_TIMEOUT_MS = 4500; // 单篇原文抓取超时
const SUMMARY_CONCURRENCY = 4; // 并发数
const SUMMARY_MIN_LEN = 15; // 简介最短有效长度

/**
 * 快讯源列表：按顺序尝试，命中即用。
 * 若某个源失效，直接替换或追加更稳定的 RSS 地址即可。
 */
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
  // 部分源的字段经过 HTML 转义（如 &lt;a href=…&gt;），须先解码再剥标签，反复两次
  let s = stripCdata(m[1]);
  for (let i = 0; i < 2; i++) {
    s = stripTags(decodeEntities(s));
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 解析条目自带的内容简介（description/summary/content）；与标题重复的视为无简介 */
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
  // 与标题高度重合（如 Google News 只给「标题 + 来源名」）→ 无有效简介，交由「回源补抓」处理
  const nt = t.replace(/[\s\-–—|·:：,，.。]+/g, '');
  const ns = s.replace(/[\s\-–—|·:：,，.。]+/g, '');
  if (nt && ns === nt) return '';
  if (nt && ns.indexOf(nt) === 0 && ns.length - nt.length < 20) return '';
  if (nt && nt.indexOf(ns) === 0 && nt.length - ns.length < 20) return '';
  if (ns.length < SUMMARY_MIN_LEN) return '';
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX) + '…';
  return s;
}

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
      time: time || '',
      source: sourceName,
      snippet: pickSummary(b, title)
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

/** 主体流程：抓取 → 写入 KV → 记录结果；返回本次实际生效的载荷 */
async function run(env) {
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
      // 回源补齐内容简介（并发受限，失败静默跳过）
      await enrichSummaries(items);
      const payload = {
        updatedAt: new Date().toISOString(),
        date: ymd(),
        source: src.name,
        fetched: true,
        count: items.length,
        items: items
      };
      await env.NEWS_KV.put(NEWS_KV_KEY, JSON.stringify(payload), { expirationTtl: 172800 });
      await env.NEWS_KV.put(LAST_RUN_KEY, JSON.stringify({
        at: payload.updatedAt, ok: true, source: src.name, count: items.length, errors: errors
      }), { expirationTtl: 172800 });
      return payload;
    } catch (e) {
      errors.push(src.name + '：' + ((e && e.message) ? e.message : '未知错误'));
    }
  }

  // 全部源失败：保留历史缓存，只记录失败，避免 /api/news 变空
  const prev = await env.NEWS_KV.get(NEWS_KV_KEY);
  await env.NEWS_KV.put(LAST_RUN_KEY, JSON.stringify({
    at: new Date().toISOString(), ok: false, source: '', count: 0, errors: errors
  }), { expirationTtl: 172800 });

  if (prev) {
    try { return JSON.parse(prev); } catch (e) { /* 旧缓存损坏则走下面的空载荷 */ }
  }
  return {
    updatedAt: '',
    date: ymd(),
    source: '',
    fetched: false,
    count: 0,
    items: [],
    message: '本轮抓取失败且无历史缓存',
    errors: errors
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export default {
  /** Cron 定时触发入口 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  /** 手动触发 / 健康检查：GET /run?key=TRIGGER_KEY 立即抓取；GET / 查看上次执行记录 */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const key = url.searchParams.get('key') || '';
      if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
        return jsonResponse({ ok: false, error: '未授权：请携带正确的 key 参数' }, 401);
      }
      try {
        const payload = await run(env);
        return jsonResponse({ ok: true, payload: payload });
      } catch (e) {
        return jsonResponse({ ok: false, error: (e && e.message) ? e.message : '抓取失败' }, 500);
      }
    }

    try {
      const last = await env.NEWS_KV.get(LAST_RUN_KEY);
      return jsonResponse({
        ok: true,
        service: 'aviation-news-cron',
        cronHint: '每日 0 22 * * *（UTC）',
        lastRun: last ? JSON.parse(last) : null
      });
    } catch (e) {
      return jsonResponse({ ok: false, error: (e && e.message) ? e.message : '读取执行记录失败' }, 500);
    }
  }
};
