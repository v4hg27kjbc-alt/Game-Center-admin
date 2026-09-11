/**
 * POST /api/recommend
 * 接收用户提交的机型推荐：
 *   - 字段：nameZh / code / category / country / image / descZh / specs / uid / submittedAt
 *   - image 支持 dataURL（base64）或外链 http(s) 地址
 *   - dataURL 照片写入 R2（绑定名 BUCKET），D1（绑定名 DB）只存 image_key
 *   - 初始状态 pending
 *
 * 绑定要求：DB（D1）、BUCKET（R2，可选但建议）
 */

import {
  preflight, json, fail, readBody, str, genId, nowIso,
  parseDataUrl, imageUrlOf, errText
} from './_utils.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单张照片上限 4MB

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const body = await readBody(request);
    const nameZh = str(body.nameZh || body.name, 80);
    const code = str(body.code, 40);
    const category = str(body.category, 40);
    const country = str(body.country, 60);
    const descZh = str(body.descZh || body.desc, 2000);
    const uid = str(body.uid, 80);
    let specs = body.specs;
    if (specs && typeof specs !== 'string') specs = JSON.stringify(specs);
    specs = str(specs, 2000);
    const submittedAt = str(body.submittedAt, 40) || nowIso();

    if (!nameZh) return fail('缺少必填字段：nameZh（机型名称）', 400, request);
    if (!uid) return fail('缺少必填字段：uid（提交人匿名ID）', 400, request);

    const id = genId('rec');

    // ---- 照片处理 ----
    let imageKey = '';
    const rawImage = body.image || body.imageData || body.photo || '';
    if (rawImage) {
      const s = String(rawImage);
      if (/^https?:\/\//i.test(s)) {
        imageKey = str(s, 500); // 外链直接保留
      } else if (env.BUCKET) {
        const parsed = parseDataUrl(s);
        if (parsed && parsed.bytes && parsed.bytes.length) {
          if (parsed.bytes.length > MAX_IMAGE_BYTES) {
            return fail('照片体积过大（超过 4MB），请压缩后重试', 413, request);
          }
          imageKey = 'recommend-' + id + '.' + parsed.ext;
          await env.BUCKET.put(imageKey, parsed.bytes, {
            httpMetadata: { contentType: parsed.mime }
          });
        }
      }
      // 未绑定 BUCKET 时：忽略照片，仍保留文字推荐，避免整体失败
    }

    // ---- 写库 ----
    await env.DB.prepare(
      'INSERT INTO recommendations ' +
      '(id, uid, nameZh, code, category, country, image_key, descZh, specs, submitted_at, status, reply, reviewed_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL)"
    ).bind(id, uid, nameZh, code, category, country, imageKey, descZh, specs, submittedAt).run();

    return json({
      ok: true,
      id: id,
      status: 'pending',
      imageUrl: imageUrlOf(imageKey)
    }, 200, request);
  } catch (err) {
    return fail('推荐提交失败：' + errText(err), 500, request);
  }
}
