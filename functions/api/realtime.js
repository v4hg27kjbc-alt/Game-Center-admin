/**
 * /api/realtime —— 收费管理 · 实时用户与营收概览（后台 v3.3）
 *
 * 鉴权：管理端会话（mv_admin Cookie）或 X-Admin-Token
 *
 * 路由：
 *   GET /api/realtime?action=overview   实时用户 + 在线统计 + 营收快照
 *   GET /api/realtime?action=user&uid=  单用户详情（含券码 / 订单）
 *
 * 数据来源：与主站共用 SMS_KV
 *   acct:u:<uid>      主站账号记录（lastLoginAt / lastActiveAt / coupons / orders）
 *   order:index:v1    订单索引
 *   coupon:index:v1   券码索引
 */
import { preflight, json, isAdmin, nowIso } from './_utils.js';

const ONLINE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟内有过活动 = 在线
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}

async function readJson(kv, key, dft) {
  try {
    const t = await kv.get(key);
    return t ? JSON.parse(t) : dft;
  } catch (e) { return dft; }
}

function ts(v) {
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? 0 : t;
}

/** 扫描主站账号（最多 maxPages 页 × 500 条，足够中小站点的实时视图） */
async function scanUsers(kv, maxPages) {
  const out = [];
  let cursor = null;
  for (let round = 0; round < (maxPages || 6); round++) {
    let page;
    try {
      page = await kv.list({ prefix: 'acct:u:', limit: 500, cursor: cursor || undefined });
    } catch (e) { break; }
    const keys = (page && page.keys) || [];
    // 批量读取（KV 无批量接口，控制并发 12）
    for (let i = 0; i < keys.length; i += 12) {
      const slice = keys.slice(i, i + 12);
      const rows = await Promise.all(slice.map(async (k) => {
        const raw = await kv.get(k.name);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      }));
      rows.forEach((u) => { if (u && u.uid) out.push(u); });
    }
    if (!page || page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

function briefUser(u, now) {
  const lastActive = u.lastActiveAt || u.lastLoginAt || '';
  const lastTs = ts(lastActive);
  const coupons = Array.isArray(u.coupons) ? u.coupons : [];
  const orders = Array.isArray(u.orders) ? u.orders : [];
  const paid = coupons.length > 0 || orders.length > 0 || !!u.paid;
  return {
    uid: String(u.uid || ''),
    username: String(u.username || u.displayName || ''),
    phone: String(u.phone || ''),
    createdAt: String(u.createdAt || ''),
    lastLoginAt: String(u.lastLoginAt || ''),
    lastActiveAt: String(lastActive),
    loginCount: Number(u.loginCount || 0) || 0,
    coupons: coupons.length,
    orders: orders.length,
    paid: paid,
    online: lastTs > 0 && (now - lastTs) < ONLINE_WINDOW_MS,
    lastActiveAgo: lastTs ? Math.max(0, Math.round((now - lastTs) / 1000)) : -1
  };
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401, request);
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, error: 'kv_missing', message: '服务端未绑定 SMS_KV' }, 503, request);

  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || 'overview');

  // ---- 单用户详情 ----
  if (action === 'user') {
    const uid = String(url.searchParams.get('uid') || '').trim();
    if (!uid) return json({ ok: false, error: 'bad_uid' }, 400, request);
    const u = await readJson(kv, 'acct:u:' + uid, null);
    if (!u) return json({ ok: false, error: 'not_found' }, 404, request);
    const now = Date.now();
    const idx = await readJson(kv, 'order:index:v1', []);
    const myOrders = (Array.isArray(idx) ? idx : []).filter((o) => String(o.uid || o.userUid || '') === uid);
    return json({
      ok: true,
      user: briefUser(u, now),
      coupons: Array.isArray(u.coupons) ? u.coupons : [],
      orders: myOrders,
      raw: {
        status: u.status || 'active',
        mutedUntil: u.mutedUntil || '',
        violationCount: u.violationCount || 0,
        phoneVerified: !!u.phoneVerified
      }
    }, 200, request);
  }

  // ---- 概览：实时用户 + 营收 ----
  const now = Date.now();
  const users = await scanUsers(kv, 6);
  const list = users.map((u) => briefUser(u, now));

  const online = list.filter((x) => x.online).length;
  const active24h = list.filter((x) => x.lastActiveAgo >= 0 && x.lastActiveAgo * 1000 < RECENT_WINDOW_MS).length;

  const orderIdx = await readJson(kv, 'order:index:v1', []);
  const orders = Array.isArray(orderIdx) ? orderIdx : [];
  const couponIdx = await readJson(kv, 'coupon:index:v1', []);
  const coupons = Array.isArray(couponIdx) ? couponIdx : [];

  const startOfDay = (function () {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  const stat = { total: orders.length, pending: 0, confirmed: 0, rejected: 0, refunded: 0, todayOrders: 0, revenue: 0, refundAmount: 0 };
  orders.forEach((o) => {
    const st = String(o.status || 'pending');
    if (stat[st] !== undefined) stat[st]++;
    const price = Number(o.price || o.amount || 5) || 5;
    if (st === 'confirmed') stat.revenue += price;
    if (st === 'refunded') stat.refundAmount += price;
    if (ts(o.createdAt) >= startOfDay) stat.todayOrders++;
  });

  list.sort((a, b) => (b.lastActiveAgo >= 0 ? 1 : 0) - (a.lastActiveAgo >= 0 ? 1 : 0) || a.lastActiveAgo - b.lastActiveAgo);

  return json({
    ok: true,
    time: nowIso(),
    online: online,
    active24h: active24h,
    totalUsers: list.length,
    paidUsers: list.filter((x) => x.paid).length,
    orders: stat,
    coupons: {
      total: coupons.length,
      used: coupons.filter((c) => String(c.status || '') === 'used').length,
      active: coupons.filter((c) => String(c.status || '') === 'active').length
    },
    users: list.slice(0, 300)
  }, 200, request);
}
