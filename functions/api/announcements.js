/**
 * functions/api/announcements.js
 * ------------------------------------------------------------------
 * 民航客机收藏馆 · 公告接口（KV 存储）
 *
 * 路由契约：
 *   POST /api/announcements                发布公告（需 X-Admin-Token）
 *        body: { title, content, scope }   scope: 'public'（对外）| 'internal'（对内）
 *   POST /api/announcements {action:'revoke', id}
 *                                          撤回公告（需 X-Admin-Token）
 *   GET  /api/announcements?scope=public   对外公告列表（免令牌，主站轮询使用）
 *   GET  /api/announcements?scope=admin    全部公告列表（需 X-Admin-Token，后台管理面板使用）
 *        可选 &status=active|revoked|all  默认 active
 *
 * 存储：KV 绑定 NEWS_KV（与快讯共用命名空间），key = announcements:list
 *       值为 JSON 数组（新的在前），单条结构：
 *       { id, title, content, scope, revoked, createdAt, createdBy, revokedAt }
 *
 * 鉴权：复用 _utils.isAdmin（优先校验服务端会话 Cookie mv_admin；
 *       会话无效时回退请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对）。
 * 容错：任何异常均返回结构化 JSON（HTTP 200 + ok:false，或 4xx/5xx 明确错误），
 *       主站侧对失败静默隐藏，不阻塞页面。
 */

import { preflight, json, fail, unauthorized, isAdmin, nowIso, genId, readBody, str, errText } from './_utils.js';

export const ANNOUNCE_KV_KEY = 'announcements:list';
const MAX_ITEMS = 100;      // 最多保留公告条数
const TITLE_MAX = 80;
const CONTENT_MAX = 1000;
const SCOPES = ['public', 'internal'];

/** 读取 KV 中的公告数组（容错：缺失/损坏返回空数组） */
async function readList(env) {
  try {
    const raw = await env.NEWS_KV.get(ANNOUNCE_KV_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function writeList(env, list) {
  await env.NEWS_KV.put(ANNOUNCE_KV_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
}

/** 对外输出：剔除内部字段，统一 camelCase */
function mapItem(it) {
  return {
    id: it.id,
    title: it.title || '',
    content: it.content || '',
    scope: it.scope || 'public',
    revoked: !!it.revoked,
    createdAt: it.createdAt || '',
    createdBy: it.createdBy || '',
    revokedAt: it.revokedAt || ''
  };
}

/** 主站期望文案字段：兼容 announcements / items / data / list 形态（对外列表额外补 text/name） */
function publicItem(it) {
  const base = mapItem(it);
  base.text = base.title;
  base.name = base.title;
  return base;
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

/** GET：scope=public 免令牌；scope=admin 需令牌 */
export async function onRequestGet({ request, env }) {
  try {
    if (!env.NEWS_KV) return fail('服务端未配置 KV 绑定（NEWS_KV）', 500, request);

    const url = new URL(request.url);
    const scope = (url.searchParams.get('scope') || 'public').toLowerCase();
    const status = (url.searchParams.get('status') || 'active').toLowerCase();

    if (SCOPES.indexOf(scope) < 0 && scope !== 'admin') {
      return fail('scope 参数不合法，仅支持 public / admin', 400, request);
    }

    const list = await readList(env);

    // 管理员视图：全部公告（含对内、含已撤回，便于撤回后仍可见记录）
    if (scope === 'admin') {
      if (!(await isAdmin(request, env))) return unauthorized(request);
      let items = list;
      if (status === 'active') items = list.filter((it) => !it.revoked);
      else if (status === 'revoked') items = list.filter((it) => !!it.revoked);
      return json({
        ok: true,
        scope: 'admin',
        status: status,
        count: items.length,
        announcements: items.map(mapItem),
        items: items.map(mapItem)
      }, 200, request);
    }

    // 对外视图：仅未撤回的对外公告（免令牌）
    const items = list.filter((it) => !it.revoked && (it.scope || 'public') === 'public');
    return json({
      ok: true,
      scope: 'public',
      count: items.length,
      announcements: items.map(publicItem),
      items: items.map(publicItem),
      list: items.map(publicItem),
      data: items.map(publicItem)
    }, 200, request);
  } catch (err) {
    return fail('读取公告失败：' + errText(err), 500, request);
  }
}

/** POST：发布 / 撤回（均需令牌） */
export async function onRequestPost({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) return unauthorized(request);
    if (!env.NEWS_KV) return fail('服务端未配置 KV 绑定（NEWS_KV）', 500, request);

    const body = await readBody(request);
    const action = str(body.action || 'publish', 20).toLowerCase();
    const list = await readList(env);

    // ---- 撤回：POST { action:'revoke', id } ----
    if (action === 'revoke') {
      const id = str(body.id, 80);
      if (!id) return fail('缺少公告 id', 400, request);
      let hit = null;
      for (let i = 0; i < list.length; i++) {
        if (String(list[i].id) === id) { hit = list[i]; break; }
      }
      if (!hit) return fail('未找到该公告（可能已被删除）', 404, request);
      if (!hit.revoked) {
        hit.revoked = true;
        hit.revokedAt = nowIso();
        await writeList(env, list);
      }
      return json({
        ok: true,
        action: 'revoke',
        revoked: true,
        id: id,
        count: list.filter((it) => !it.revoked).length,
        announcement: mapItem(hit)
      }, 200, request);
    }

    // ---- 发布：POST { title, content, scope } ----
    const title = str(body.title, TITLE_MAX);
    const content = str(body.content, CONTENT_MAX);
    let scope = str(body.scope || 'public', 20).toLowerCase();
    if (scope === 'admin' || scope === 'private') scope = 'internal';

    if (!title) return fail('公告标题不能为空', 400, request);
    if (!content) return fail('公告内容不能为空', 400, request);
    if (SCOPES.indexOf(scope) < 0) return fail('scope 参数不合法，仅支持 public / internal', 400, request);

    const item = {
      id: genId('ann'),
      title: title,
      content: content,
      scope: scope,
      revoked: false,
      createdAt: nowIso(),
      createdBy: str(body.by || '', 60),
      revokedAt: ''
    };
    list.unshift(item);
    await writeList(env, list);

    return json({
      ok: true,
      action: 'publish',
      scope: scope,
      count: list.filter((it) => !it.revoked).length,
      announcement: mapItem(item),
      item: mapItem(item)
    }, 200, request);
  } catch (err) {
    return fail('公告操作失败：' + errText(err), 500, request);
  }
}
