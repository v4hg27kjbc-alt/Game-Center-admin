/**
 * /api/feedback —— 反馈存储 + 邮件受理通知（v68）
 *
 * 绑定要求：DB（D1）
 * 建表语句：d1-migration-v67.sql（表名 feedbacks）
 *
 * 邮件通知（受理 / 结果两个节点，均为「尽力而为」，失败不影响主流程）：
 *   受理节点：POST /api/feedback 提交成功后，若填写了邮箱且邮件服务已配置 → 立即发「已受理」邮件
 *   结果节点：POST /api/feedback { action: 'notify' }（管理员）标记已处理 / 回复 → 发「已处理完成」邮件
 *
 * 环境变量（Cloudflare Pages → Settings → Environment variables）：
 *   MAIL_API_KEY       必填，邮件服务 Key；未配置时跳过发信并记录 notify_status = 'skipped_no_key'
 *   MAIL_API_ENDPOINT  可选，默认 https://api.resend.com/emails（兼容 Resend 协议的服务均可）
 *   MAIL_FROM          可选，发件人，默认 民航客机收藏馆 <onboarding@resend.dev>
 *   MAIL_REPLY_TO      可选，回信地址
 *   MAIL_ENABLED       可选，设为 off 可全局关闭邮件通知
 *
 * 接口契约：
 *   POST /api/feedback
 *     - 访客提交：{ type, content, name?, phone?, email?, uid?, submittedAt? }
 *       name（v68 新增，选填）：访客姓名；写库后在后台表格按「姓名 / 姓氏」两列展示
 *       → { ok: true, id, notify: { stage: 'accepted', status, message } }
 *       phone / email 均为选填；未填写则该字段不写库（存空串）、不发信（notify_status = 'not_applicable'）
 *     - 管理员更新：{ action: 'notify', id, status?, reply? }
 *       → { ok: true, id, status, notify: { stage: 'result', status, message } }
 *   GET /api/feedback?limit=200&status=new|done&reveal=1
 *     - 需管理员身份（会话 Cookie 或 X-Admin-Token）
 *     - 默认返回脱敏手机号 / 邮箱；reveal=1 时额外返回 phoneFull / emailFull 全文（仅管理员可见）
 *     → { ok: true, items: [...], total }
 */

import {
  preflight, json, fail, readBody, str, genId, nowIso, errText,
  isAdmin, unauthorized, maskPhone, maskEmail, isEmailLike, normalizePhone,
  sendMail, mailConfigured, feedbackMailContent, FEEDBACK_TYPES
} from './_utils.js';

const MAX_CONTENT = 2000;

export async function onRequestOptions({ request }) {
  return preflight(request);
}

/** D1 行 → 接口返回结构（默认脱敏，reveal=true 时附带全文） */
function mapFeedback(row, reveal) {
  if (!row) return null;
  const phone = String(row.phone || '').trim();
  const email = String(row.email || '').trim();
  const item = {
    id: row.id,
    type: row.type || '其他',
    content: row.content || '',
    name: String(row.name || '').trim(),
    phone: phone ? maskPhone(phone) : '',
    email: email ? maskEmail(email) : '',
    hasPhone: !!phone,
    hasEmail: !!email,
    // 填写了手机号或邮箱 → 前端据此加「可联系」标注；均未填则整列不出现
    contactable: !!(phone || email),
    status: row.status || 'new',
    reply: row.reply || '',
    uid: row.uid || '',
    notifyStatus: row.notify_status || '',
    notifyStage: row.notify_stage || '',
    notifiedAt: row.notified_at || '',
    createdAt: row.created_at || '',
    reviewedAt: row.reviewed_at || ''
  };
  if (reveal) {
    item.phoneFull = phone;
    item.emailFull = email;
  }
  return item;
}

/** 发信统一入口：返回 { status, message, id }，永不抛异常 */
async function notify(env, stage, row, reply) {
  const to = String((row && row.email) || '').trim();
  if (!to) {
    return { status: 'not_applicable', message: '访客未填写邮箱，无需邮件通知', id: '' };
  }
  if (!mailConfigured(env)) {
    return { status: 'skipped_no_key', message: '未配置 MAIL_API_KEY，已跳过邮件通知（已记录 notify_status）', id: '' };
  }
  const c = feedbackMailContent(stage, row, reply);
  return await sendMail(env, { to: to, subject: c.subject, text: c.text, html: c.html });
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);
    if (!(await isAdmin(request, env))) return unauthorized(request);

    const url = new URL(request.url);
    const limitRaw = parseInt(url.searchParams.get('limit') || '200', 10);
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 200 : limitRaw, 1), 500);
    const status = str(url.searchParams.get('status') || '', 20);
    const reveal = url.searchParams.get('reveal') === '1';

    let sql = 'SELECT * FROM feedbacks';
    const binds = [];
    if (status === 'new' || status === 'done') {
      sql += ' WHERE status = ?';
      binds.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    binds.push(limit);

    const rs = await env.DB.prepare(sql).bind(...binds).all();
    const rows = (rs && rs.results) ? rs.results : [];
    return json({
      ok: true,
      total: rows.length,
      items: rows.map((r) => mapFeedback(r, reveal))
    }, 200, request);
  } catch (err) {
    return fail('反馈列表读取失败：' + errText(err), 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return fail('服务端未配置 D1 绑定（DB）', 500, request);

    const body = await readBody(request);
    const action = str(body.action || '', 20);

    // ---- 管理员：标记已处理 / 回复（结果通知节点）----
    if (action === 'notify') {
      if (!(await isAdmin(request, env))) return unauthorized(request);
      const id = str(body.id, 60);
      if (!id) return fail('缺少必填字段：id', 400, request);

      const row = await env.DB.prepare('SELECT * FROM feedbacks WHERE id = ?').bind(id).first();
      if (!row) return fail('反馈不存在：' + id, 404, request);

      const status = (str(body.status, 20) === 'done') ? 'done' : (String(row.status || 'new'));
      const reply = (body.reply === undefined || body.reply === null) ? String(row.reply || '') : str(body.reply, MAX_CONTENT);
      const reviewedAt = nowIso();

      const m = await notify(env, 'result', row, reply);

      await env.DB.prepare(
        'UPDATE feedbacks SET status = ?, reply = ?, reviewed_at = ?, notify_status = ?, notify_stage = ?, notified_at = ? WHERE id = ?'
      ).bind(status, reply, reviewedAt, m.status, 'result', m.status === 'sent' ? nowIso() : '', id).run();

      return json({
        ok: true, id: id, status: status,
        notify: { stage: 'result', status: m.status, message: m.message || '' }
      }, 200, request);
    }

    // ---- 访客：提交反馈（受理通知节点）----
    let type = str(body.type, 20);
    if (FEEDBACK_TYPES.indexOf(type) < 0) type = '其他';
    const content = str(body.content, MAX_CONTENT);
    if (!content) return fail('缺少必填字段：content（反馈内容）', 400, request);

    // 手机号：优先使用清洗后的号码，清洗后不像号码则保留原始输入（避免静默丢数据）
    let phone = str(body.phone, 40);
    if (phone) {
      const cleaned = normalizePhone(phone);
      phone = (cleaned.replace(/\D/g, '').length >= 7) ? cleaned : phone;
    }
    // 邮箱：填了但格式明显错误时丢弃（视为未填），并记录 notify_status 便于排查
    let email = str(body.email, 120).toLowerCase();
    let emailInvalid = false;
    if (email && !isEmailLike(email)) { emailInvalid = true; email = ''; }

    const name = str(body.name, 60);
    const uid = str(body.uid, 80);
    const submittedAt = str(body.submittedAt, 40) || nowIso();
    const id = genId('fb');

    const m = await notify(env, 'accepted', {
      id: id, type: type, content: content, name: name, email: email
    }, '');

    const notifyStatus = emailInvalid ? 'skipped_invalid_email' : m.status;
    const notifyStage = email ? 'accepted' : '';

    await env.DB.prepare(
      'INSERT INTO feedbacks ' +
      '(id, type, content, name, phone, email, uid, status, reply, notify_status, notify_stage, notified_at, created_at, reviewed_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'new', '', ?, ?, ?, ?, NULL)"
    ).bind(
      id, type, content, name, phone, email, uid,
      notifyStatus, notifyStage,
      notifyStatus === 'sent' ? nowIso() : '',
      submittedAt
    ).run();

    return json({
      ok: true,
      id: id,
      status: 'new',
      name: name,
      contactable: !!(phone || email),
      notify: { stage: 'accepted', status: notifyStatus, message: m.message || '' }
    }, 200, request);
  } catch (err) {
    return fail('反馈提交失败：' + errText(err), 500, request);
  }
}
