/**
 * /api/accounts —— 主站注册账户（登录管理）同步接口
 *
 * 数据来源：SMS_KV 中主站 /api/account 写入的真实注册账号
 *   acct:u:<uid>  → 用户对象 { uid, username, displayName, salt, pass, phone,
 *                                createdAt, lastLoginAt, loginCount, favorites,
 *                                saved, tier, migrated, status, bannedAt }
 *   acct:n:<name> → uid   （用户名索引）
 *   acct:p:<phone>→ uid   （手机号索引）
 *
 * 鉴权：admin 会话（mv_admin Cookie）或 X-Admin-Token。
 *
 * 路由：
 *   GET  /api/accounts?search=&limit=     列表 + 概览统计
 *   POST /api/accounts                    { action, uid, ... }
 *        action = ban | unban | reset-password | delete | set-tier
 */

import {
  preflight, json, fail, readBody, str, isAdmin, adminTokenOf, errText, nowIso, maskPhone
} from './_utils.js';

const KV_CANDIDATES = ['SMS_KV', 'NEWS_KV'];
const PREFIX = 'acct:u:';
const CACHE_TTL_HINT = 60;

function kvOf(env) {
  for (let i = 0; i < KV_CANDIDATES.length; i++) {
    const kv = env && env[KV_CANDIDATES[i]];
    if (kv && typeof kv.get === 'function' && typeof kv.list === 'function') return kv;
  }
  return null;
}

function b64u(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
  return b64u(bits);
}

function randSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

async function listAllUsers(kv, max) {
  const out = [];
  let cursor = null;
  const cap = max || 2000;
  for (let guard = 0; guard < 20; guard++) {
    const opts = { prefix: PREFIX, limit: 1000 };
    if (cursor) opts.cursor = cursor;
    const page = await kv.list(opts);
    const keys = (page && page.keys) || [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i].name;
      try {
        const u = await kv.get(k, 'json');
        if (u && typeof u === 'object') out.push(u);
      } catch (e) { /* 跳过损坏记录 */ }
      if (out.length >= cap) return out;
    }
    if (!page || page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

function viewOf(u) {
  const favorites = Array.isArray(u.favorites) ? u.favorites.length : 0;
  const saved = Array.isArray(u.saved) ? u.saved.length : 0;
  return {
    uid: u.uid || '',
    username: u.username || '',
    displayName: u.displayName || u.username || '',
    phone: u.phone || '',
    phoneMasked: maskPhone(u.phone || ''),
    createdAt: u.createdAt || '',
    lastLoginAt: u.lastLoginAt || '',
    loginCount: Number(u.loginCount || 0) || 0,
    favorites: favorites,
    saved: saved,
    tier: u.tier || 'member',
    status: u.status || 'active',
    bannedAt: u.bannedAt || '',
    migrated: !!u.migrated,
    hasPassword: !!u.pass
  };
}

function summarize(list) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  let todayNew = 0, active7 = 0, banned = 0, withPhone = 0;
  const todayStr = nowIso().slice(0, 10);
  list.forEach(function (u) {
    if ((u.createdAt || '').slice(0, 10) === todayStr) todayNew++;
    const t = Date.parse(u.lastLoginAt || '');
    if (!isNaN(t) && now - t < 7 * day) active7++;
    if ((u.status || 'active') === 'banned' || (u.status || '') === 'disabled') banned++;
    if (u.phone) withPhone++;
  });
  return { total: list.length, todayNew: todayNew, active7: active7, banned: banned, withPhone: withPhone };
}

async function guard(request, env) {
  const sessionOk = await isAdmin(request, env);
  const token = adminTokenOf(request);
  if (!sessionOk && !token) return false;
  return true;
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!(await guard(request, env))) return fail('需要管理员权限', 401, request);
    const kv = kvOf(env);
    if (!kv) return fail('SMS_KV 未绑定，无法读取主站注册账户', 503, request, { needBinding: 'SMS_KV' });

    const url = new URL(request.url);
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('limit') || '1000', 10) || 1000));

    const all = await listAllUsers(kv, limit);
    const stats = summarize(all);
    let users = all.map(viewOf);
    if (search) {
      users = users.filter(function (u) {
        return (u.username || '').toLowerCase().indexOf(search) >= 0 ||
          (u.displayName || '').toLowerCase().indexOf(search) >= 0 ||
          (u.phone || '').indexOf(search) >= 0 ||
          (u.uid || '').toLowerCase().indexOf(search) >= 0;
      });
    }
    users.sort(function (a, b) {
      return String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || ''));
    });

    return json({ ok: true, data: { users: users, stats: stats, matched: users.length } }, 200, request, {
      'Cache-Control': 'no-store'
    });
  } catch (err) {
    return fail('读取主站账户失败：' + errText(err, '未知错误'), 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await guard(request, env))) return fail('需要管理员权限', 401, request);
    const kv = kvOf(env);
    if (!kv) return fail('SMS_KV 未绑定，无法操作主站注册账户', 503, request, { needBinding: 'SMS_KV' });

    const body = await readBody(request);
    if (!body) return fail('请求体为空', 400, request);
    const action = str(body.action, 40);
    const uid = str(body.uid, 60);
    if (!action) return fail('缺少 action', 400, request);
    if (!uid) return fail('缺少 uid', 400, request);

    const key = PREFIX + uid;
    const user = await kv.get(key, 'json');
    if (!user || typeof user !== 'object') return fail('账号不存在：' + uid, 404, request);

    if (action === 'ban') {
      user.status = 'banned';
      user.bannedAt = nowIso();
      user.bannedReason = str(body.reason, 120) || '';
      await kv.put(key, JSON.stringify(user));
      return json({ ok: true, data: { user: viewOf(user), message: '已禁止该账号登录' } }, 200, request);
    }

    if (action === 'unban') {
      user.status = 'active';
      delete user.bannedAt;
      delete user.bannedReason;
      await kv.put(key, JSON.stringify(user));
      return json({ ok: true, data: { user: viewOf(user), message: '已恢复该账号登录权限' } }, 200, request);
    }

    if (action === 'reset-password') {
      const np = str(body.password, 64) || '12345678';
      if (np.length < 6) return fail('新密码至少 6 位', 400, request);
      user.salt = randSalt();
      user.pass = await hashPassword(np, user.salt);
      user.passwordResetAt = nowIso();
      user.passwordResetBy = 'admin';
      await kv.put(key, JSON.stringify(user));
      return json({
        ok: true,
        data: { user: viewOf(user), password: np, message: '密码已重置为：' + np }
      }, 200, request);
    }

    if (action === 'set-tier') {
      const tier = str(body.tier, 20) || 'member';
      user.tier = tier;
      await kv.put(key, JSON.stringify(user));
      return json({ ok: true, data: { user: viewOf(user), message: '等级已更新为 ' + tier } }, 200, request);
    }

    if (action === 'delete') {
      await kv.delete(key);
      try { if (user.username) await kv.delete('acct:n:' + String(user.username).toLowerCase()); } catch (e) {}
      try { if (user.phone) await kv.delete('acct:p:' + String(user.phone)); } catch (e) {}
      return json({ ok: true, data: { deleted: uid, message: '账号已删除' } }, 200, request);
    }

    return fail('不支持的 action：' + action, 400, request);
  } catch (err) {
    return fail('操作失败：' + errText(err, '未知错误'), 500, request);
  }
}
