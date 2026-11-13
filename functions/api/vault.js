/**
 * /api/vault —— 密钥保险柜（后台，服务端加密存储）
 *
 * 背景：旧实现只把密钥存在浏览器 localStorage（db.vault），换设备/清缓存/无痕模式即全部丢失，
 *      因此在用户侧表现为"保险柜用不了"。本接口改为服务端 KV 持久化 + AES-256-GCM 加密。
 *
 * 存储（SMS_KV / NEWS_KV）：
 *   vault:item:<id>  → { id, name, type, note, iv, ct, createdAt, updatedAt, updatedBy }
 *                       iv/ct 为 base64；明文永不落库、永不出现在列表接口
 *   vault:index:v1   → [ { id, name, type, note, mask, createdAt, updatedAt } ]
 *
 * 鉴权：admin 会话（mv_admin Cookie）或 X-Admin-Token（isAdmin）。
 *
 * 路由：
 *   GET  /api/vault?action=list
 *   GET  /api/vault?action=get&id=<id>
 *   POST /api/vault { action:'add', name, type, value, note }
 *   POST /api/vault { action:'update', id, name, type, value, note }   value 省略=不改内容
 *   POST /api/vault { action:'reveal', id }   仅此接口返回明文（前端一次性展示）
 *   POST /api/vault { action:'delete', id }
 *   POST /api/vault { action:'migrate', items:[{name,type,value,note}] }  导入旧本地数据，自动去重
 */

import { preflight, json, fail, isAdmin, readBody, str, genId } from './_utils.js';

const INDEX_KEY = 'vault:index:v1';
const ITEM_PREFIX = 'vault:item:';
const MAX_ITEMS = 500;

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

/* ---------- 加密 ---------- */

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(v) {
  const s = atob(String(v || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function keyOf(env) {
  const secret = String((env && (env.VAULT_SECRET || env.TOKEN_SECRET || env.ADMIN_TOKEN)) || 'gc-vault-fallback');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gc-vault-v1|' + secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptText(env, plain) {
  const key = await keyOf(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(plain)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptText(env, ivB64, ctB64) {
  const key = await keyOf(env);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(plain);
}

/* ---------- 展示 ---------- */

function maskOf(value) {
  const v = String(value || '');
  if (!v) return '—';
  if (/^https?:\/\//i.test(v)) return v.length <= 32 ? v : v.slice(0, 32) + '…';
  if (v.length <= 10) return '••••' + v.slice(-2);
  return v.slice(0, 6) + '••••••' + v.slice(-4);
}

function nowIso() {
  return new Date().toISOString();
}

function whoOf(request) {
  const h = request && request.headers;
  const name = (h && (h.get('x-admin-user') || h.get('cf-connecting-ip'))) || 'admin';
  return String(name).slice(0, 60);
}

async function loadIndex(kv) {
  const list = await readJson(kv, INDEX_KEY, []);
  return Array.isArray(list) ? list : [];
}

async function saveIndex(kv, list) {
  await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
}

function cleanType(t) {
  const v = str(t, 20) || 'other';
  return ['token', 'secret', 'link', 'other'].indexOf(v) >= 0 ? v : 'other';
}

async function addItem(kv, env, request, body, existingIndex) {
  const name = str(body.name, 80);
  const value = String(body.value == null ? '' : body.value);
  if (!name) return { error: '请填写名称' };
  if (!value.trim()) return { error: '请填写令牌 / 密钥 / 链接内容' };
  const index = existingIndex || (await loadIndex(kv));
  if (index.length >= MAX_ITEMS) return { error: '保险柜已满（上限 ' + MAX_ITEMS + ' 条）' };

  const dup = index.find(function (it) { return it.name === name && it.mask === maskOf(value); });
  if (dup) return { ok: true, item: dup, duplicate: true };

  const id = genId('v') || ('v' + Date.now().toString(36));
  const enc = await encryptText(env, value);
  const now = nowIso();
  await kv.put(ITEM_PREFIX + id, JSON.stringify({
    id: id,
    name: name,
    type: cleanType(body.type),
    note: str(body.note, 200),
    iv: enc.iv,
    ct: enc.ct,
    createdAt: now,
    updatedAt: now,
    updatedBy: whoOf(request)
  }));
  const item = {
    id: id,
    name: name,
    type: cleanType(body.type),
    note: str(body.note, 200),
    mask: maskOf(value),
    createdAt: now,
    updatedAt: now
  };
  index.unshift(item);
  await saveIndex(kv, index);
  return { ok: true, item: item };
}

export async function onRequestOptions(context) {
  return preflight(context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isAdmin(request, env)) return fail('未授权', 401, request);
  const kv = kvOf(env);
  if (!kv) return fail('存储未配置', 500, request);

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'list';
  const id = String(url.searchParams.get('id') || '');

  if (action === 'list') {
    const list = await loadIndex(kv);
    return json({ ok: true, items: list, count: list.length }, 200, request);
  }
  if (action === 'get') {
    const raw = await kv.get(ITEM_PREFIX + id);
    if (!raw) return fail('未找到该条记录', 404, request);
    const rec = JSON.parse(raw);
    return json({
      ok: true,
      item: { id: rec.id, name: rec.name, type: rec.type, note: rec.note, createdAt: rec.createdAt, updatedAt: rec.updatedAt }
    }, 200, request);
  }
  return fail('未知操作', 400, request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!isAdmin(request, env)) return fail('未授权', 401, request);
  const kv = kvOf(env);
  if (!kv) return fail('存储未配置', 500, request);

  let body;
  try {
    body = await readBody(request);
  } catch (e) {
    return fail('请求体格式错误', 400, request);
  }
  const action = String(body.action || '');

  if (action === 'add') {
    const index = await loadIndex(kv);
    const r = await addItem(kv, env, request, body, index);
    if (r.error) return fail(r.error, 400, request);
    return json({ ok: true, item: r.item, duplicate: !!r.duplicate }, 200, request);
  }

  if (action === 'update') {
    const id = String(body.id || '');
    const raw = await kv.get(ITEM_PREFIX + id);
    if (!raw) return fail('未找到该条记录', 404, request);
    const rec = JSON.parse(raw);
    const index = await loadIndex(kv);
    if (body.name !== undefined) rec.name = str(body.name, 80) || rec.name;
    if (body.type !== undefined) rec.type = cleanType(body.type);
    if (body.note !== undefined) rec.note = str(body.note, 200);

    let mask = '—';
    if (body.value !== undefined && String(body.value).trim() !== '') {
      const enc = await encryptText(env, String(body.value));
      rec.iv = enc.iv;
      rec.ct = enc.ct;
      mask = maskOf(String(body.value));
    } else {
      try { mask = maskOf(await decryptText(env, rec.iv, rec.ct)); } catch (e) { mask = '—'; }
    }
    rec.updatedAt = nowIso();
    rec.updatedBy = whoOf(request);
    await kv.put(ITEM_PREFIX + id, JSON.stringify(rec));

    const pos = index.findIndex(function (it) { return it.id === id; });
    const item = { id: id, name: rec.name, type: rec.type, note: rec.note, mask: mask, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
    if (pos >= 0) index[pos] = item; else index.unshift(item);
    await saveIndex(kv, index);
    return json({ ok: true, item: item }, 200, request);
  }

  if (action === 'reveal') {
    const id = String(body.id || '');
    const raw = await kv.get(ITEM_PREFIX + id);
    if (!raw) return fail('未找到该条记录', 404, request);
    const rec = JSON.parse(raw);
    try {
      const value = await decryptText(env, rec.iv, rec.ct);
      return json({ ok: true, value: value, name: rec.name }, 200, request);
    } catch (e) {
      return fail('解密失败（密钥可能已变更，请重新录入该条）', 500, request);
    }
  }

  if (action === 'delete') {
    const id = String(body.id || '');
    await kv.delete(ITEM_PREFIX + id);
    const index = await loadIndex(kv);
    const next = index.filter(function (it) { return it.id !== id; });
    await saveIndex(kv, next);
    return json({ ok: true, left: next.length }, 200, request);
  }

  if (action === 'migrate') {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const index = await loadIndex(kv);
    let added = 0, skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const r = await addItem(kv, env, request, it, index);
      if (r.ok && !r.duplicate) added++;
      else skipped++;
    }
    return json({ ok: true, added: added, skipped: skipped, count: index.length }, 200, request);
  }

  if (action === 'debug') {
    return json({
      ok: true,
      kv: !!kv,
      keySource: env.VAULT_SECRET ? 'VAULT_SECRET' : (env.TOKEN_SECRET ? 'TOKEN_SECRET' : (env.ADMIN_TOKEN ? 'ADMIN_TOKEN' : 'fallback')),
      count: (await loadIndex(kv)).length
    }, 200, request);
  }

  return fail('未知操作', 400, request);
}
