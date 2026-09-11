/**
 * GET /api/image/:key
 * 读取用户推荐照片并回传，供主站 / 后台展示缩略图。
 * 读取顺序：优先 R2（绑定名 BUCKET）；R2 未绑定 / 未命中 / 异常时回退 KV（绑定名 NEWS_KV），
 * KV 中以 base64 字符串存取，存储 key 与 R2 方案完全一致。
 * 说明：[key] 为单段动态路由，推荐照片的 key 形如 recommend-rec_xxx.jpg
 *
 * 绑定要求：BUCKET（R2）或 NEWS_KV（KV），二者至少配置一个
 */

import { preflight, fail, corsHeaders } from '../_utils.js';

// base64 字符串转二进制字节（KV 兜底读取用）
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 按 key 后缀兜底推断 Content-Type
function guessMime(key) {
  const s = String(key || '').toLowerCase();
  if (s.endsWith('.png')) return 'image/png';
  if (s.endsWith('.webp')) return 'image/webp';
  if (s.endsWith('.gif')) return 'image/gif';
  if (s.endsWith('.bmp')) return 'image/bmp';
  if (s.endsWith('.heic')) return 'image/heic';
  if (s.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

// 解析 KV 中存储的照片：兼容 JSON 包装 { mime, size, b64 } 与纯 base64 字符串
function decodeKvImage(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.b64 === 'string') {
      return { mime: o.mime || '', bytes: base64ToBytes(o.b64) };
    }
  } catch (e) { /* 非 JSON，按纯 base64 处理 */ }
  try {
    return { mime: '', bytes: base64ToBytes(raw) };
  } catch (e) {
    return null;
  }
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ params, request, env }) {
  try {
    if (!env.BUCKET && !env.NEWS_KV) {
      return fail('服务端未配置照片存储绑定（BUCKET 或 NEWS_KV）', 500, request);
    }

    const raw = Array.isArray(params.key) ? params.key.join('/') : (params.key || '');
    const key = decodeURIComponent(raw || '');
    if (!key) return fail('缺少图片 key', 400, request);

    let body = null;
    let contentType = '';
    let etag = '';

    // 1) 优先读 R2
    if (env.BUCKET) {
      try {
        const obj = await env.BUCKET.get(key);
        if (obj) {
          body = obj.body;
          contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || '';
          etag = obj.httpEtag || '';
        }
      } catch (e) { /* R2 读取异常：继续走 KV 兜底 */ }
    }

    // 2) R2 不可用或未命中时回退 KV
    if (!body && env.NEWS_KV) {
      try {
        const stored = decodeKvImage(await env.NEWS_KV.get(key));
        if (stored && stored.bytes && stored.bytes.length) {
          body = stored.bytes;
          contentType = stored.mime || '';
        }
      } catch (e) { /* KV 读取异常：按未找到处理 */ }
    }

    if (!body) return fail('图片不存在或已被删除', 404, request);

    const headers = new Headers(corsHeaders(request));
    headers.set('Content-Type', contentType || guessMime(key));
    headers.set('Cache-Control', 'public, max-age=86400');
    if (etag) headers.set('ETag', etag);

    return new Response(body, { status: 200, headers });
  } catch (err) {
    return fail('读取图片失败：' + ((err && err.message) ? err.message : '未知错误'), 500, request);
  }
}
