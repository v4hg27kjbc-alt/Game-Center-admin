/**
 * /api/coupons —— 券码管理（后台）
 *
 * 数据与主站 /api/coupon（兑换）共用 SMS_KV：
 *   coupon:code:<NORM>  → 券记录 { code, couponCode, status, type, value, note, batch, prefix, createdAt, createdBy, exp, usedBy, usedByName, usedAt }
 *   coupon:index:v1     → [ 券记录摘要 ... ]（后台列表用，最长保留 5000 条）
 *
 * 鉴权：admin 会话（mv_admin Cookie）或 X-Admin-Token（isAdmin）。
 *
 * 路由：
 *   GET  /api/coupons?action=list&status=&q=&limit=200   列表 + 统计
 *   GET  /api/coupons?action=stats                       仅统计
 *   POST /api/coupons  { action: 'gen',    count, prefix, type, value, note, expDays, projectKeys }
 *   POST /api/coupons  { action: 'revoke', codes: ['GC-XXXX-XXXX', ...] }   作废（保留记录）
 *   POST /api/coupons  { action: 'delete', codes: [...], force: true }      物理删除
 */

import { preflight, json, fail, isAdmin, readBody } from './_utils.js';
import { normProjectKeys } from './_lib/data/projects.js';

const INDEX_KEY = 'coupon:index:v1';
const MAX_INDEX = 5000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 剔除 I L O U，避免肉眼混淆
const CODE_LEN = 8;

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

function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function displayOf(prefix, rest) {
  return prefix + '-' + rest.slice(0, 4) + '-' + rest.slice(4, 8);
}

function adminNameOf(request) {
  return String(request.headers.get('cf-connecting-ip') || 'admin').slice(0, 40);
}

async function handleGen(kv, request, body) {
  let count = parseInt(body.count, 10);
  if (!Number.isFinite(count) || count <= 0) count = 10;
  if (count > 200) count = 200;

  let prefix = String(body.prefix || 'GC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!prefix) prefix = 'GC';

  const projectKeys = normProjectKeys(body.projectKeys);
  const projectKeys = normProjectKeys(body.projectKeys);
  const type = String(body.type || '通用券').slice(0, 40);
  const value = String(body.value || '').slice(0, 40);
  const note = String(body.note || '').slice(0, 200);
  const expDays = parseInt(body.expDays, 10);
  const now = new Date();
  const batch = 'B' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const exp = (Number.isFinite(expDays) && expDays > 0)
    ? new Date(now.getTime() + expDays * 86400000).toISOString()
    : '';

  const idx = await readJson(kv, INDEX_KEY, []);
  const list = Array.isArray(idx) ? idx : [];
  const existing = {};
  list.forEach(function (r) { if (r && r.code) existing[String(r.code)] = true; });

  const created = [];
  for (let i = 0; i < count; i++) {
    let norm = '';
    let display = '';
    let rec = null;
    for (let t = 0; t < 6; t++) {
      const rest = randCode();
      norm = normCode(prefix + rest);
      display = displayOf(prefix, rest);
      if (existing[norm]) continue;
      const hit = await kv.get('coupon:code:' + norm);
      if (hit) { existing[norm] = true; continue; }
      rec = {
        code: norm,
        couponCode: display,
        status: 'active',
        projectKeys: projectKeys,
        type: type,
        value: value,
        note: note,
        batch: batch,
        prefix: prefix,
        createdAt: now.toISOString(),
        createdBy: adminNameOf(request),
        exp: exp,
        usedBy: '',
        usedByName: '',
        usedAt: ''
      };
      break;
    }
    if (!rec) continue;
    await kv.put('coupon:code:' + norm, JSON.stringify(rec));
    existing[norm] = true;
    created.push(rec);
  }

  const merged = created.concat(list).slice(0, MAX_INDEX);
  await kv.put(INDEX_KEY, JSON.stringify(merged));

  return json({ ok: true, batch: batch, count: created.length, coupons: created }, 200, request);
}

async function handleBatch(kv, request, body, mode) {
  const codes = Array.isArray(body.codes) ? body.codes.slice(0, 200) : [];
  if (!codes.length) return fail('请先选择券码', 400, request);
  const force = body.force === true;

  const idx = await readJson(kv, INDEX_KEY, []);
  const list = Array.isArray(idx) ? idx : [];
  const done = [];
  const skipped = [];

  for (let i = 0; i < codes.length; i++) {
    const norm = normCode(codes[i]);
    if (!norm) continue;
    const key = 'coupon:code:' + norm;
    const rec = await readJson(kv, key, null);
    if (!rec) { skipped.push({ code: codes[i], reason: '记录不存在' }); continue; }

    if (mode === 'revoke') {
      if (String(rec.status || '') === 'used') { skipped.push({ code: codes[i], reason: '已使用，不能作废' }); continue; }
      rec.status = 'revoked';
      rec.revokedAt = new Date().toISOString();
      rec.revokedBy = adminNameOf(request);
      await kv.put(key, JSON.stringify(rec));
      done.push({ code: rec.couponCode || norm, status: 'revoked' });
    } else {
      if (String(rec.status || '') === 'used' && !force) { skipped.push({ code: codes[i], reason: '已使用，需勾选强制删除' }); continue; }
      await kv.delete(key);
      done.push({ code: rec.couponCode || norm, status: 'deleted' });
    }
  }

  let next = list;
  if (mode === 'revoke') {
    next = list.map(function (r) {
      if (r && done.some(function (d) { return normCode(d.code) === normCode(r.code); })) {
        return Object.assign({}, r, { status: 'revoked' });
      }
      return r;
    });
  } else {
    const gone = {};
    done.forEach(function (d) { gone[normCode(d.code)] = true; });
    next = list.filter(function (r) { return !(r && gone[normCode(r.code)]); });
  }
  await kv.put(INDEX_KEY, JSON.stringify(next));

  return json({ ok: true, mode: mode, done: done, skipped: skipped }, 200, request);
}

function statsOf(list) {
  const s = { total: list.length, active: 0, used: 0, revoked: 0, expired: 0 };
  const now = Date.now();
  list.forEach(function (r) {
    const st = String((r && r.status) || 'active');
    if (st === 'used') { s.used += 1; return; }
    if (st === 'revoked') { s.revoked += 1; return; }
    if (r && r.exp) {
      const t = Date.parse(r.exp);
      if (Number.isFinite(t) && t < now) { s.expired += 1; return; }
    }
    s.active += 1;
  });
  return s;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const kv = kvOf(env);
  if (!kv) return fail('存储未绑定', 500, request);

  const admin = await isAdmin(request, env);
  if (!admin) return fail('未授权', 401, request);

  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || 'list');
  const list = await readJson(kv, INDEX_KEY, []);
  const rows = Array.isArray(list) ? list : [];

  if (action === 'stats') return json({ ok: true, stats: statsOf(rows) }, 200, request);

  const status = String(url.searchParams.get('status') || '');
  const q = normCode(url.searchParams.get('q') || '');
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 1000) limit = 1000;

  const now = Date.now();
  const filtered = rows.filter(function (r) {
    if (!r) return false;
    let st = String(r.status || 'active');
    if (st === 'active' && r.exp) {
      const t = Date.parse(r.exp);
      if (Number.isFinite(t) && t < now) st = 'expired';
    }
    if (status && status !== 'all' && st !== status) return false;
    if (q && normCode(r.code).indexOf(q) < 0 && normCode(r.couponCode).indexOf(q) < 0) return false;
    return true;
  });

  const out = filtered.slice(0, limit).map(function (r) {
    let st = String(r.status || 'active');
    if (st === 'active' && r.exp) {
      const t = Date.parse(r.exp);
      if (Number.isFinite(t) && t < now) st = 'expired';
    }
    return {
      code: r.couponCode || r.code,
      norm: r.code,
      status: st,
      projectKeys: Array.isArray(r.projectKeys) ? r.projectKeys : [],
      type: r.type || '',
      value: r.value || '',
      note: r.note || '',
      batch: r.batch || '',
      createdAt: r.createdAt || '',
      exp: r.exp || '',
      usedBy: r.usedBy || '',
      usedByName: r.usedByName || '',
      usedAt: r.usedAt || ''
    };
  });

  return json({ ok: true, stats: statsOf(rows), total: filtered.length, rows: out }, 200, request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = kvOf(env);
  if (!kv) return fail('存储未绑定', 500, request);

  const admin = await isAdmin(request, env);
  if (!admin) return fail('未授权', 401, request);

  const body = await readBody(request);
  if (!body || !body.action) return fail('参数不完整', 400, request);
  const action = String(body.action);

  if (action === 'gen') return handleGen(kv, request, body);
  if (action === 'revoke') return handleBatch(kv, request, body, 'revoke');
  if (action === 'delete') return handleBatch(kv, request, body, 'delete');

  return fail('未知操作', 400, request);
}

export async function onRequestOptions(context) {
  return preflight(context.request);
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method === 'GET') return onRequestGet(context);
  if (request.method === 'POST') return onRequestPost(context);
  return fail('不支持的方法', 405, request);
}
