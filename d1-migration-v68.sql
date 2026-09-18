-- ============================================================
-- 民航收藏馆后台 D1 迁移脚本（v68）
-- 数据库：aircraft-recommend（id: 656bd7d6-d222-42f9-8957-3fbac0ce408e）
-- 用途：feedbacks 表新增「姓名」列（主站反馈弹窗选填；后台表格按「姓名 / 姓氏」两列展示）
-- 执行方式：Cloudflare 控制台 → D1 → aircraft-recommend → Console 执行本行 SQL；
--           或 wrangler d1 execute aircraft-recommend --remote --file=./d1-migration-v68.sql
-- 说明：ADD COLUMN 为增量、非破坏性操作，不删除、不修改任何现有数据（不含 DROP / DELETE / UPDATE）。
--       若该列已存在会报 duplicate column name，忽略即可继续。
-- 注意：请在部署含 v68 functions/api/feedback.js 的 Pages 版本「之前」执行本脚本。
-- 前置：feedbacks 表由 d1-migration-v67.sql 创建，若尚未建表请先执行 v67 脚本。
-- ============================================================

ALTER TABLE feedbacks ADD COLUMN name TEXT;   -- 访客姓名（选填；未填写为空串，不作占位展示）

-- 校验（可选）
-- PRAGMA table_info(feedbacks);
-- SELECT id, name, phone, email, created_at FROM feedbacks ORDER BY created_at DESC LIMIT 5;
