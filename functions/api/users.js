/**
 * /api/users —— 用户管理后端
 *
 * 管理端会话鉴权（mv_admin Cookie 或 X-Admin-Token）。
 * 存储：NEWS_KV（key: admin:users:v1）—— 后台用户登记表
 *       字段：{ id, username, phone, passwordHash, role, status, mutedUntil,
 *               violationCount, source, createdAt }
 *       状态：active | muted | banned | flagged
 *
 * 路由：
 *   GET  /api/users                      列表（admin）
 *   POST /api/users                      创建（admin；passwordHash 前端 SHA-256）
 *   POST /api/users/action               { ids:[...], action:'mute'|'unmute'|'flag'|'ban'|'unban', minutes?, reason? }
 *   GET  /api/users/:id                  单用户详情（预留）
 *   POST /api/users/:id/action           单用户操作（兼容）
 */

import { preflight, json, fail, readBody, str, isAdmin, adminTokenOf, errText, nowIso, genId, normalizePhone } from './_utils.js';

const USERS_KEY = 'admin:users:v1';
const MAX_USERS = 2000;

function kvOf(env) {
  return (env && env.NEWS_KV && typeof env.NEWS_KV.get === 'function' && typeof env.NEWS_KV.put === 'function') ? env.NEWS_KV : null;
}

async function loadUsers(env) {
  const kv = kvOf(env);
  if (!kv) return [];
  try {
    const raw = await kv.get(USERS_KEY, 'json');
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.users) ? raw.users : []);
  } catch (e) {
    return [];
  }
}

async function saveUsers(env, users) {
  const kv = kvOf(env);
  if (!kv) throw new Error('NEWS_KV 未绑定，无法持久化用户数据');
  await kv.put(USERS_KEY, JSON.stringify({ users: users }));
}

function publicView(u) {
  return {
    id: u.id,
    username: u.username,
    phone: u.phone || '',
    phoneMasked: u.phone ? (u.phone.length >= 7 ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '****') : '',
    passwordHash: u.passwordHash || '',
    role: u.role || 'guest',
    status: u.status || 'active',
    mutedUntil: u.mutedUntil || null,
    violationCount: u.violationCount || 0,
    source: u.source || 'admin',
    createdAt: u.createdAt || ''
  };
}

function normalizeAction(action) {
  const map = { mute: 'mute', unmute: 'unmute', flag: 'flag', unflag: 'flag', ban: 'ban', unban: 'unban' };
  return map[String(action || '').toLowerCase()] || null;
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  try {
    const sessionOk = await isAdmin(request, env);
    const token = adminTokenOf(request);
    if (!sessionOk && !token) return fail('需要管理员权限', 401, request);

    const kv = kvOf(env);
    if (!kv) return fail('服务端未绑定 NEWS_KV，用户管理不可用', 503, request);

    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg.length >= 3 && seg[seg.length - 2] === 'users') {
      const id = decodeURIComponent(seg[seg.length - 1]);
      const users = await loadUsers(env);
      const u = users.find(function (x) { return x.id === id; });
      if (!u) return fail('用户不存在', 404, request);
      return json({ ok: true, data: publicView(u) }, 200, request);
    }

    const users = await loadUsers(env);
    const keyword = (url.searchParams.get('q') || '').trim().toLowerCase();
    let list = users;
    if (keyword) {
      list = list.filter(function (x) {
        return (x.username || '').toLowerCase().indexOf(keyword) >= 0 ||
               (x.phone || '').indexOf(keyword) >= 0;
      });
    }
    const statusFilter = url.searchParams.get('status') || '';
    if (statusFilter && statusFilter !== 'all') {
      list = list.filter(function (x) { return (x.status || 'active') === statusFilter; });
    }
    return json({ ok: true, data: { users: list.map(publicView), total: users.length, count: list.length } }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return fail('用户列表获取失败：' + errText(e), 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const sessionOk = await isAdmin(request, env);
    const token = adminTokenOf(request);
    if (!sessionOk && !token) return fail('需要管理员权限', 401, request);

    const kv = kvOf(env);
    if (!kv) return fail('服务端未绑定 NEWS_KV，用户管理不可用', 503, request);

    const body = await readBody(request);
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);

    // 单用户操作 POST /api/users/:id/action
    if (seg.length >= 4 && seg[seg.length - 3] === 'users' && seg[seg.length - 1] === 'action') {
      const id = decodeURIComponent(seg[seg.length - 2]);
      const action = normalizeAction(body.action);
      if (!action) return fail('不支持的操作用 action', 400, request);
      const users = await loadUsers(env);
      const u = users.find(function (x) { return x.id === id; });
      if (!u) return fail('用户不存在', 404, request);
      applyAction(u, action, body);
      await saveUsers(env, users);
      return json({ ok: true, data: publicView(u) }, 200, request);
    }

    // 批量操作 POST /api/users/action
    if (seg[seg.length - 1] === 'action') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const action = normalizeAction(body.action);
      if (!action) return fail('不支持的操作用 action', 400, request);
      if (!ids.length) return fail('请选择要操作的用户', 400, request);
      const users = await loadUsers(env);
      const target = users.filter(function (x) { return ids.indexOf(x.id) >= 0; });
      if (!target.length) return fail('未匹配到所选用户', 404, request);
      target.forEach(function (u) { applyAction(u, action, body); });
      await saveUsers(env, users);
      return json({ ok: true, data: { count: target.length, ids: target.map(function (x) { return x.id; }) } }, 200, request);
    }

    // 创建 POST /api/users
    const username = str(body.username, 80).trim();
    const passwordHash = String(body.passwordHash || '').trim();
    const phone = String(body.phone || '').trim();
    const role = ['owner', 'admin', 'guest'].indexOf(String(body.role || 'guest')) >= 0 ? String(body.role) : 'guest';
    if (!username) return fail('请输入用户名', 400, request);
    if (passwordHash && !/^[a-f0-9]{32,128}$/i.test(passwordHash)) return fail('passwordHash 应为 SHA-256 十六进制串', 400, request);
    const p = normalizePhone(phone);
    if (phone && !/^\d{11}$/.test(p)) return fail('手机号格式不正确（需 11 位数字）', 400, request);

    const users = await loadUsers(env);
    if (users.length >= MAX_USERS) return fail('用户数量已达上限', 400, request);
    if (users.some(function (x) { return x.username.toLowerCase() === username.toLowerCase(); })) return fail('用户名已存在', 409, request);
    if (p && users.some(function (x) { return x.phone === p; })) return fail('手机号已被占用', 409, request);

    const user = {
      id: genId('u'),
      username: username,
      phone: p || '',
      passwordHash: passwordHash,
      role: role,
      status: 'active',
      mutedUntil: null,
      violationCount: 0,
      source: 'admin',
      createdAt: nowIso()
    };
    users.push(user);
    await saveUsers(env, users);
    return json({ ok: true, data: publicView(user) }, 201, request);
  } catch (e) {
    return fail('用户操作失败：' + errText(e), 500, request);
  }
}

function applyAction(u, action, body) {
  const now = Date.now();
  const minutes = Math.max(1, Math.min(1440 * 30, parseInt(body.minutes, 10) || 60));
  switch (action) {
    case 'mute':
      u.status = 'muted';
      u.mutedUntil = new Date(now + minutes * 60 * 1000).toISOString();
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = str(body.reason, 200) || '';
      break;
    case 'unmute':
      if (u.status === 'muted') { u.status = 'active'; u.mutedUntil = null; u.lastActionAt = nowIso(); }
      break;
    case 'flag':
      u.status = 'flagged';
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = str(body.reason, 200) || '';
      break;
    case 'ban':
      u.status = 'banned';
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = str(body.reason, 200) || '';
      break;
    case 'unban':
      if (u.status === 'banned' || u.status === 'flagged') { u.status = 'active'; u.lastActionAt = nowIso(); }
      break;
  }
}
