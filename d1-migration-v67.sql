-- ============================================================
-- 民航收藏馆后台 D1 迁移脚本（v67）
-- 数据库：aircraft-recommend（id: 656bd7d6-d222-42f9-8957-3fbac0ce408e）
-- 用途：新建反馈存储表 feedbacks（承接主站「反馈与建议」的
--       手机号 / 通知邮箱 与 邮件受理通知状态）
-- 执行方式：Cloudflare 控制台 → D1 → aircraft-recommend → Console，逐条执行；
--           或 wrangler d1 execute aircraft-recommend --remote --file=./d1-migration-v67.sql
-- 说明：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 均为增量、非破坏性操作，
--       不会删除或修改任何现有数据（不含 DROP / DELETE / UPDATE）。
-- 注意：请在部署新版本 Pages（含 functions/api/feedback.js）之前执行本脚本。
-- ============================================================

-- ① 反馈表（主站 POST /api/feedback 写入；后台 GET /api/feedback 读取）
CREATE TABLE IF NOT EXISTS feedbacks (
  id            TEXT PRIMARY KEY,           -- 反馈编号，形如 fb_xxxxx
  type          TEXT,                       -- 功能建议 / Bug 反馈 / 内容纠错 / 体验优化 / 其他
  content       TEXT,                       -- 反馈内容
  phone         TEXT,                       -- 手机号（选填；未填写为空串，不作占位展示）
  email         TEXT,                       -- 接收受理通知的邮箱（选填；同上）
  uid           TEXT,                       -- 主站匿名标识（统计去重）
  status        TEXT DEFAULT 'new',         -- new=待处理 / done=已处理
  reply         TEXT,                       -- 管理员回复（随结果通知邮件发送）
  notify_status TEXT,                       -- 邮件通知状态：
                                            --   not_applicable      访客未填邮箱，无需通知
                                            --   skipped_no_key      未配置 MAIL_API_KEY，已跳过
                                            --   skipped_invalid_email 邮箱格式非法，已忽略
                                            --   sent                发送成功
                                            --   failed             发送失败（可重试）
  notify_stage  TEXT,                       -- accepted=已发受理通知 / result=已发结果通知
  notified_at   TEXT,                       -- 最近一次发信成功时间（ISO 字符串）
  created_at    TEXT,                       -- 提交时间（ISO 字符串）
  reviewed_at   TEXT                        -- 后台处理时间（ISO 字符串）
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks (created_at);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status  ON feedbacks (status);

-- ② 校验（可选）
-- PRAGMA table_info(feedbacks);
-- SELECT name FROM sqlite_master WHERE type='table' AND name='feedbacks';
-- SELECT status, notify_status, COUNT(*) FROM feedbacks GROUP BY status, notify_status;

-- ============================================================
-- ③ 备用：仅当库中「已存在」feedbacks 表但缺列时执行（全新库请跳过本节）
--    若某列已存在会报 duplicate column name，可忽略继续；请按需逐条执行，不要整段无脑粘贴。
-- ------------------------------------------------------------
-- ALTER TABLE feedbacks ADD COLUMN phone TEXT;
-- ALTER TABLE feedbacks ADD COLUMN email TEXT;
-- ALTER TABLE feedbacks ADD COLUMN uid TEXT;
-- ALTER TABLE feedbacks ADD COLUMN status TEXT DEFAULT 'new';
-- ALTER TABLE feedbacks ADD COLUMN reply TEXT;
-- ALTER TABLE feedbacks ADD COLUMN notify_status TEXT;
-- ALTER TABLE feedbacks ADD COLUMN notify_stage TEXT;
-- ALTER TABLE feedbacks ADD COLUMN notified_at TEXT;
-- ALTER TABLE feedbacks ADD COLUMN created_at TEXT;
-- ALTER TABLE feedbacks ADD COLUMN reviewed_at TEXT;
-- ============================================================
