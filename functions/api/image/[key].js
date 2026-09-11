/**
 * GET /api/image/:key
 * 从 R2（绑定名 BUCKET）读取用户推荐照片并回传，供主站 / 后台展示缩略图。
 * 说明：[key] 为单段动态路由，推荐照片的 key 形如 recommend-rec_xxx.jpg
 *
 * 绑定要求：BUCKET（R2）
 */

import { preflight, fail, corsHeaders } from '../_utils.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ params, request, env }) {
  try {
    if (!env.BUCKET) return fail('服务端未配置 R2 绑定（BUCKET）', 500, request);

    const raw = Array.isArray(params.key) ? params.key.join('/') : (params.key || '');
    const key = decodeURIComponent(raw || '');
    if (!key) return fail('缺少图片 key', 400, request);

    const obj = await env.BUCKET.get(key);
    if (!obj) return fail('图片不存在或已被删除', 404, request);

    const headers = new Headers(corsHeaders(request));
    headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg');
    headers.set('Cache-Control', 'public, max-age=86400');
    if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    return fail('读取图片失败：' + ((err && err.message) ? err.message : '未知错误'), 500, request);
  }
}
