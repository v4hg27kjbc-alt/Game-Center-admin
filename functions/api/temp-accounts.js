/**
 * /api/temp-accounts —— 临时账户管理后端（维护期迁移引导）
 *
 * 管理端会话鉴权（mv_admin Cookie 或 X-Admin-Token）。
 * 存储：NEWS_KV（key: admin:temp-accounts:v1）—— 与主站 /api/temp-account 共享
 *       记录：{ phone, status:'pending'|'migrated', createdAt, verifiedAt, migratedAt? }
 *
 * 路由：
 *   GET  /api/temp-accounts            列表（admin）
 *   POST /api/temp-accounts            { action:'mark-migrated', phone } 标记已迁移（admin）
 */

import { preflight, json, fail, readBody, str, isAdmin, adminTokenOf, nowIso } from './_utils.js';

const TEMP_KEY = 'admin:temp-accounts:v1';
const MAX_ACCOUNTS = 5000;

function kvOf(env) {
  return (env && env.NEWS_KV && typeof env.NEWS_KV.get === 'function' && typeof env.NEWS_KV.put === 'function') ? env.NEWS_KV : null;
}

async function loadAccounts(env) {
  const kv = kvOf(env);
  if (!kv) return [];
  try {
    const raw = await kv.get(TEMP_KEY, 'json');
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : []);
  } catch (e) {
    return [];
  }
}

async function saveAccounts(env, accounts) {
  const kv = kvOf(env);
  if (!kv) throw new Error('NEWS_KV 未绑定，无法持久化临时账户数据');
  await kv.put(TEMP_KEY, JSON.stringify({ accounts: accounts }));
}

function publicView(a) {
  return {
    phone: a.phone || '',
    phoneMasked: a.phone ? (a.phone.length >= 7 ? a.phone.slice(0, 3) + '****' + a.phone.slice(-4) : '****') : '',
    status: a.status || 'pending',
    createdAt: a.createdAt || '',
    verifiedAt: a.verifiedAt || '',
    migratedAt: a.migratedAt || ''
  };
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
    if (!kv) return fail('服务端未绑定 NEWS_KV，临时账户管理不可用', 503, request);

    const accounts = await loadAccounts(env);
    const list = accounts
      .map(publicView)
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

    return json({ ok: true, count: list.length, accounts: list }, request);
  } catch (e) {
    return fail('服务异常：' + (e && e.message ? e.message : '未知错误'), 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const sessionOk = await isAdmin(request, env);
    const token = adminTokenOf(request);
    if (!sessionOk && !token) return fail('需要管理员权限', 401, request);

    const kv = kvOf(env);
    if (!kv) return fail('服务端未绑定 NEWS_KV，临时账户管理不可用', 503, request);

    const body = await readBody(request);
    const action = str(body && body.action, '');
    if (action === 'mark-migrated') {
      const phone = str(body && body.phone, '').trim();
      if (!/^1[3-9]\d{9}$/.test(phone)) return fail('手机号格式不正确', 400, request);

      const accounts = await loadAccounts(env);
      let found = false;
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i] && accounts[i].phone === phone) {
          accounts[i].status = 'migrated';
          accounts[i].migratedAt = nowIso();
          accounts[i].updatedAt = nowIso();
          found = true;
          break;
        }
      }
      if (!found) return fail('未找到该手机号的临时账户', 404, request);
      await saveAccounts(env, accounts);
      return json({ ok: true, phone: phone, status: 'migrated' }, request);
    }

    return fail('未知操作：' + action, 400, request);
  } catch (e) {
    return fail('服务异常：' + (e && e.message ? e.message : '未知错误'), 500, request);
  }
}
