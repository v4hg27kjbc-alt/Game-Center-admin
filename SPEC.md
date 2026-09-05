---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: fbb3d0100d73840269ed17c69ec05f26_630e298ea37d11f1bc17525400826444
    ReservedCode1: J8w16EzAUwDsPvJFYJ0/YoPr7Ktzg6NdNDlZS1NiEvMAHestx7VnMBgbPzdxfi7qL3gRLe+u5ljDb8Jp2l3JeecG+YH8pfn8FnYwPmGWGh2SK291DnYXs74YkL9xgUj41pfN2FKnr4bWzEw5oK20OLjwBuYRaEksJ1TkeWlzFJmcMaUoMwS34PBiTqg=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: fbb3d0100d73840269ed17c69ec05f26_630e298ea37d11f1bc17525400826444
    ReservedCode2: J8w16EzAUwDsPvJFYJ0/YoPr7Ktzg6NdNDlZS1NiEvMAHestx7VnMBgbPzdxfi7qL3gRLe+u5ljDb8Jp2l3JeecG+YH8pfn8FnYwPmGWGh2SK291DnYXs74YkL9xgUj41pfN2FKnr4bWzEw5oK20OLjwBuYRaEksJ1TkeWlzFJmcMaUoMwS34PBiTqg=
---

# aviation-admin 后台管理系统 · 规格模板（Spec Template）

- 版本：v0.2
- 日期：2026-08-29
- 状态：**本地离线可用，未上线**（原生网页未接入，等待确认）
- 定位：为多个静态网页提供统一的自有反馈后台，替代 GitHub Issues 等第三方渠道

---

## 1. 系统定位

| 项目 | 说明 |
|---|---|
| 目的 | 网页反馈直达作者自有后台，多站点（多网页）共用一套后台 |
| 当前形态 | 本地离线运行（`python3 server.py`） |
| 上线形态 | 待确认后接入原生网页并部署（Cloudflare Workers + D1 或自托管） |
| 铁律 | 未获用户确认前，不修改原生网页、不上线 |

## 2. 技术栈与运行环境

- 后端：Python 3 标准库 `http.server`，零第三方依赖
- 前端：原生 HTML / CSS / JS 单页应用
- 数据：本地 `data/*.json` 文件持久化
- 端口：`8756`（可在 `server.py` 顶部常量修改）
- 环境：macOS（`python3` 可直接运行），理论上跨平台

## 3. 目录结构与职责

```
aviation-admin/
├── server.py          # 后端：静态文件服务 + JSON API（唯一后端入口）
├── static/
│   ├── index.html     # 单页管理后台（登录/看板/反馈/站点/设置）
│   ├── style.css      # 深色玻璃拟态，与主网页一致的光效（AI 按钮扫光等）
│   └── app.js         # 前端逻辑（鉴权、渲染、交互、AI 总结）
├── data/              # 运行时自动生成的数据文件
│   ├── sites.json     # 站点列表
│   ├── feedbacks.json # 反馈数据
│   ├── analytics.json # 浏览/行为数据（主网页埋点上报，供 AI 总结）
│   └── settings.json  # 系统设置（密码、AI 开关与模型配置）
├── SPEC.md            # 本文档（规格模板）
└── README.md          # 快速上手
```

## 4. 数据模型

### 4.1 sites（站点）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 唯一标识（自增数字字符串） |
| name | string | 站点显示名（如「民航客机收藏馆」） |
| url | string | 站点网址 |
| siteKey | string | 网页接入密钥（如 `site_xxxx`，提交反馈时使用） |
| createdAt | string | 创建时间 ISO 字符串 |

### 4.2 feedbacks（反馈）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 唯一标识 |
| siteId | string | 所属站点 id |
| type | string | 类型：建议 / 问题 / 咨询 / 其他 |
| content | string | 反馈内容 |
| contact | string | 选填联系方式 |
| status | string | `new`（待处理）/ `done`（已处理） |
| createdAt | string | 提交时间 ISO 字符串 |

### 4.3 settings（设置）

| 字段 | 类型 | 说明 |
|---|---|---|
| password | string | 管理员密码（默认 `admin123`，明文存储，上线前需改哈希） |
| createdAt | string | 创建时间 |
| aiEnabled | bool | AI 自动总结开关，默认 `false`（待推送上线时打开） |
| aiEndpoint | string | 智谱 GLM 接口地址 |
| aiModel | string | 模型名 `glm-4-flash`（与主网页 AI 一致） |
| aiApiKey | string | 智谱 API Key（与主网页 AI_CONFIG 一致） |

### 4.4 analytics（浏览/行为数据）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 唯一标识 |
| siteId | string | 所属站点 id |
| type | string | 事件类型（默认 `view`，可扩展 `click` 等） |
| meta | object | 附加信息（如 `{page: "home"}`） |
| createdAt | string | 上报时间 |

## 5. API 规格

鉴权约定：管理类接口需带请求头 `X-Token: <token>`（登录后返回）；公开写接口 `POST /api/feedback` 除外。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | /api/login | 无 | 入参 `{password}` → `{ok, token}` |
| GET | /api/sites | 是 | 站点列表 |
| POST | /api/sites | 是 | 新增站点 `{name, url}`，自动生成 siteKey |
| DELETE | /api/sites?id=xxx | 是 | 删除站点并级联删除其反馈 |
| GET | /api/feedbacks?siteId=xxx | 是 | 该站点反馈列表（不传 siteId 返回全部） |
| POST | /api/feedback | 无 | 公开写接口 `{siteKey, type, content, contact}` |
| PATCH | /api/feedbacks | 是 | 更新状态 `{id, status}` |
| DELETE | /api/feedbacks?id=xxx | 是 | 删除反馈 |
| GET | /api/stats?siteId=xxx | 是 | `{today, total, pending, typeDist, browseToday, browseTotal}` |
| GET | /api/ai-status | 是 | AI 功能状态 `{aiEnabled, model, note}` |
| GET | /api/ai-summary?siteId=xxx | 是 | AI 自动总结 `{summary, generatedAt}`；未启用时返回 403 |
| POST | /api/analytics | 无 | 公开写接口 `{siteKey, type, meta}`，浏览/行为埋点上报 |
| POST | /api/password | 是 | 改密码 `{old, new}` |
| GET | /api/backup | 是 | 下载全部数据 JSON |
| POST | /api/restore | 是 | 上传 JSON 覆盖恢复数据 |

**公开写接口调用示例（网页端接入预留）**

```js
fetch('http://localhost:8756/api/feedback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteKey: 'site_xxxx',   // 站点管理中对应的 siteKey
    type: '建议',
    content: '反馈内容',
    contact: '选填'
  })
});
```

## 6. 前端页面规格

| 页面/视图 | 内容 |
|---|---|
| 登录页 | 密码输入框 + 提示默认密码 admin123 |
| 数据看板（默认页） | AI 自动总结卡片（暂禁用）+ 统计卡：今日反馈 / 累计反馈 / 待处理 / 累计浏览；反馈类型分布条形图（CSS 实现） |
| 反馈管理 | 表格（时间/类型/内容/联系方式/状态）；chips 筛选（全部/待处理/已处理）；搜索框；标记已处理 / 删除；导出 CSV |
| 站点管理 | 站点列表 + 添加站点弹窗（名称/网址）+ 删除 |
| 系统设置 | 修改密码；数据备份（下载 JSON）；数据恢复（上传 JSON） |
| 顶部栏 | 当前站点选择器（单站点 / 全部）+ 退出按钮 |

风格约束：深色玻璃拟态，与民航收藏馆主网页一致——航空蓝深空背景、玻璃卡片、蓝紫渐变 AI 按钮（右上角 AI 徽标 + 呼吸脉冲）、AI 按钮扫光动画；适配 768px / 480px 移动端。

## 6.1 AI 自动总结（当前占位，推送上线时启用）

- 功能：汇总当前站点反馈与浏览数据（analytics），调用智谱 `glm-4-flash` 生成 3-5 条运营要点（亮点/问题/建议）。
- 状态：默认关闭。`settings.json` 中 `aiEnabled=false`，前端 AI 按钮置灰、`/api/ai-summary` 返回 403。
- 启用方式（推送上线时执行）：① 主网页埋点接入 `POST /api/analytics` 上报浏览数据；② `data/settings.json` 将 `aiEnabled` 改为 `true`（apiKey/model 已按主网页 AI_CONFIG 预置）。
- 前端：AI 按钮与主网页 AI 按钮同款（蓝紫渐变 + 扫光），右上角 AI 小徽标带呼吸脉冲动画；点击后展示加载态与总结结果卡片。

## 7. 多站点扩展机制

1. 在「站点管理」添加站点 → 自动获得唯一 `siteKey`。
2. 任意网页提交 `POST /api/feedback`（携带该站点的 siteKey）即可把反馈写入对应站点。
3. 后台按当前选中站点隔离展示反馈与统计；删除站点级联清理其数据。
4. 新网页接入只需重复第 1-2 步，无需改动后端代码。

## 8. 安全设计

| 维度 | 现状 | 上线前必做 |
|---|---|---|
| 管理鉴权 | token 请求头校验 | token 加密/过期机制、登录失败限速 |
| 公开接口防刷 | 无 | 频率限制（按 IP / siteKey）、字段长度校验、可选验证码 |
| 密码 | 明文 JSON | 改为哈希存储（如 bcrypt/argon2） |
| 数据传输 | 本地 HTTP | 上线后必须 HTTPS |
| 数据备份 | 手动导出 JSON | 定时自动备份 |

## 9. 上线迁移路径（待用户确认后执行）

1. 前端：`submitFeedback` 由 GitHub Issues PUT 改为 `POST <后台>/api/feedback`（原生 index.html，需确认）。
2. 隐私政策：第十条「反馈与建议」改写为自有后台说明，并新增「自有后台数据」条款；版本号升 v54+。
3. 部署：方案 A（Cloudflare Workers + D1）或自托管本框架，完成 HTTPS 与限流。
4. 回归：本地 + 线上 + 移动端 768/480 视口全链路验证。
5. 历史 GitHub Issues 反馈导出归档导入（可选）。

## 11. 登录版单文件（aviation-admin-standalone.html）

> 独立于三件套（server.py + static/*）的**登录版单文件形态**，双击即可打开，无需启动服务。

### 11.1 定位

| 项目 | 说明 |
|---|---|
| 文件 | `/Users/wangdongyan/Desktop/aviation-admin-standalone.html`（约 68KB，内联 CSS/JS） |
| 形态 | 单文件 HTML，localStorage 数据层（键 `aa_standalone_db_v1`），AI 直连智谱 |
| 会话 | localStorage 键 `aa_session_v1`，登录态**当天有效**，跨天自动回到登录页 |
| 默认账号 | `henry` / `wanwan123`（全小写），主管理员 |
| 版本 | v1.0（2026-08-29），浏览器实测 9 步全通过、控制台 0 报错 |

### 11.2 数据模型扩展（相对 4.x 新增）

| 集合 | 字段要点 | 说明 |
|---|---|---|
| users | `{username, password, role, createdAt, via}` | 账户表；role: `owner` / `admin` / `guest`；默认仅 henry(owner) |
| messages | `{id, type, title, content, applicant, reason, status, token, createdAt}` | 消息中心；type: `admin-request` / `token-request` / `notice`；status: `pending` / `approved` / `rejected` / `read` |
| tickets | `{code, used, createdAt}` | 一次性 AI 动态参观码（8 位大写字母数字） |
| visitorOnce | `{applied, type, username, status, token}` | 本机访客申请记录（每浏览器仅一次） |

### 11.3 登录与权限

- 登录校验顺序：先匹配 `users`（用户名+密码）；用户名 `visitor` + 有效未用动态码 → 以 `guest` 角色登录参观（只读，仅看板，码即刻作废）。
- 权限矩阵：

| 功能 | owner(henry) | admin | guest |
|---|---|---|---|
| 数据看板 | ✅ | ✅ | ✅（只读） |
| 反馈管理（标记/回复） | ✅ | ✅ | ❌ |
| 反馈删除 | ✅ | ❌ | ❌ |
| 站点管理 | ✅ | ❌ | ❌ |
| 系统设置（改密码/备份/恢复） | ✅ | ✅（仅改自己密码） | ❌ |
| AI 自动总结 | ✅ | ✅ | ❌ |
| 消息中心 | ✅（含审批） | ✅（仅通知/本人消息） | ❌ |
| 审批同意/驳回 | ✅ | ❌ | ❌ |

### 11.4 访客 AI 中心（全屏）

- 入口：登录页左下角「没有账户？联系管理员创建一个」。
- 自动发放一次性 AI 动态密码（仅可参观、不可更改数据、用一次即失效）。
- 命令：`添加新管理员`（引导输入用户名→理由→提交申请）、`申请长期令牌`、`查看我的申请`（查进度/令牌）、`动态密码`（重发参观码）。
- 每个用户仅能使用一次申请功能（visitorOnce 限制）。

### 11.5 消息中心

- 右上角铃铛图标（有 pending 申请时红点提示，仅 owner 可见审批红点）。
- 管理员/内部管理员/访客的申请消息展示申请人、理由、状态；owner 可「同意 / 驳回」。
- 同意：自动创建 `admin` 用户（用户名=申请人、密码=固定令牌 8 位），消息内展示令牌，访客端「查看我的申请」同步可见。
- 驳回：状态置 `rejected`，访客端同步提示。
- 同时承载系统通知与固定信息。

### 11.6 与三件套的关系

- 三件套（server.py）保持原样：离线 API 形态，供后续上线迁移参考。
- 登录版单文件为当前**推荐日常使用形态**：免安装、双击即用、自带登录与消息中心。
- 上线时仍按第 9 节流程接入原生 index.html，与单文件版互不影响。

## 10. 已知限制 / 待办

- [ ] 公开接口限流与字段校验（防滥用）
- [ ] 密码哈希存储
- [ ] 登录 token 过期机制
- [ ] 反馈时间排序前端分页（数据量大时）
- [ ] 定时自动备份
- [ ] 内容管理模块（在线改横幅/快讯/机型百科）——仅在用户要求时扩展
*（内容由AI生成，仅供参考）*
