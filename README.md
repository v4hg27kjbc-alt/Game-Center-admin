---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: fbb3d0100d73840269ed17c69ec05f26_63ac2d70a37d11f1abe1525400e6dd8f
    ReservedCode1: Ea5RKKgr8QLswJCoWQDbtV8DNS56Dl2U9KsASuycP/IvKzmwYEUqQ4KIYW4egi7ZF/UweXT/90mzVf/L+y4PXVu3bU9OwlnUwdhw9xOLFPLrztk0Nr2qwwHvlPwH/GspvXLnoixckzv2tQBvy862Edqd4QiwdvOLmMXvBkYd+kyRFatcXi0xygQ348Q=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: fbb3d0100d73840269ed17c69ec05f26_63ac2d70a37d11f1abe1525400e6dd8f
    ReservedCode2: Ea5RKKgr8QLswJCoWQDbtV8DNS56Dl2U9KsASuycP/IvKzmwYEUqQ4KIYW4egi7ZF/UweXT/90mzVf/L+y4PXVu3bU9OwlnUwdhw9xOLFPLrztk0Nr2qwwHvlPwH/GspvXLnoixckzv2tQBvy862Edqd4QiwdvOLmMXvBkYd+kyRFatcXi0xygQ348Q=
---



# aviation-admin 本地离线后台管理系统（规格模板）

> 完整规格见 [SPEC.md](SPEC.md)（数据模型 / API / 页面 / 安全 / 上线迁移路径）。

民航客机收藏馆配套的**本地离线版**后台管理系统框架。当前仅作规格模板本地运行，**未接入任何线上网页**；待确认上线后，再接入 `/Users/wangdongyan/Desktop/index.html` 等原生网页接口。

## 技术栈

- 后端：Python 3 标准库 `http.server`，零第三方依赖
- 前端：原生 HTML / CSS / JS（单页应用）
- 数据：本地 `data/*.json` 文件持久化
- 端口：`8756`

## 登录版单文件（推荐日常使用）

不依赖 Python 服务，**双击即用**的登录版单文件：

```
/Users/wangdongyan/Desktop/aviation-admin-standalone.html
```

- 默认账号：`henry` / `wanwan123`（全小写，主管理员）
- 登录态当天有效，跨天需重新登录
- 登录页左下角「没有账户？联系管理员创建一个」→ 全屏访客 AI 中心：
  - 自动发放**一次性 AI 动态密码**（用户名 `visitor` + 动态码登录，只读参观看板）
  - 输入「添加新管理员」按引导提交申请，主管理员两天内确认后发放**固定令牌**（新管理员凭令牌登录，可编辑/回复反馈）
  - 每个用户仅一次申请机会，也可申请长期固定令牌
- 右上角铃铛 = 消息中心：查看管理员申请/通知，可**同意/驳回**；同意后自动创建管理员并展示固定令牌
- 数据保存在浏览器 localStorage（键 `aa_standalone_db_v1`），AI 总结直连智谱

> 三件套（server.py 版）仍保留，用于后续上线迁移参考；两者互不影响。

## 启动方法

```bash
cd /Users/wangdongyan/Desktop/aviation-admin
python3 server.py
```

浏览器打开 <http://localhost:8756>。

- 默认密码：`admin123`（登录后可在「系统设置」中修改）
- 首次启动自动创建 `data/sites.json`、`data/feedbacks.json`、`data/settings.json`

## 目录结构

```
aviation-admin/
├── server.py          # 后端：静态文件服务 + JSON API
├── static/
│   ├── index.html     # 单页管理后台（登录/看板/反馈/站点/设置）
│   ├── style.css      # 深色玻璃拟态，与主网页一致的光效
│   └── app.js         # 前端逻辑（含 AI 总结）
├── data/              # 运行时自动生成的数据文件
│   ├── sites.json     # 站点列表
│   ├── feedbacks.json # 反馈数据
│   ├── analytics.json # 浏览/行为数据（主网页埋点上报，供 AI 总结）
│   └── settings.json  # 系统设置（密码、AI 开关与模型配置）
└── README.md
```

## 多站点使用说明

1. 登录后进入「站点管理」，点击「添加站点」，填写站点名称与网址。
2. 系统自动为每个站点生成唯一 `siteKey`（形如 `site_xxxx`），用于网页端提交反馈。
3. 顶部「当前站点选择器」可切换查看单站点或全部站点的反馈与统计。
4. 删除站点会**连同该站点下所有反馈一并删除**。

## 网页接入说明（预留接口）

网页端（如原生 index.html）只需向本服务提交反馈，即可在后台「反馈管理」中看到数据。调用示例（浏览器 fetch）：

```js
fetch('http://localhost:8756/api/feedback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteKey: 'site_xxxx',        // 站点管理中对应的 siteKey
    type: '建议',                 // 反馈类型：如 建议 / 问题 / 咨询 / 其他
    content: '这里是反馈内容',
    contact: '可选联系方式'
  })
})
```

- 该接口为**公开写接口**：仅校验 `siteKey` 是否存在，无需登录 token。
- 返回 `{ "ok": true, "data": { ... } }` 表示提交成功。

> ⚠️ 当前仅本地离线使用（`127.0.0.1:8756`）。确认上线后，再将网页接口接入到线上环境 / 原生网页。

## AI 自动总结（暂未启用）

- 数据看板内置「AI 自动总结」入口：AI 按钮与主网页同款（蓝紫渐变 + 扫光 + 右上角 AI 徽标呼吸动画）。
- 功能默认关闭（`data/settings.json` 中 `aiEnabled=false`），按钮置灰、接口返回 403。
- 待主网页推送上线时启用：① 主网页埋点接入 `POST /api/analytics` 上报浏览数据；② 将 `aiEnabled` 改为 `true`。
- 启用后自动汇总当前站点反馈 + 浏览数据，调用智谱 `glm-4-flash` 生成运营要点。

## API 一览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/login` | 登录，返回 token | 无 |
| GET | `/api/sites` | 站点列表 | token |
| POST | `/api/sites` | 新增站点（自动生成 siteKey） | token |
| DELETE | `/api/sites?id=xxx` | 删除站点及其反馈 | token |
| GET | `/api/feedbacks?siteId=xxx` | 反馈列表（siteId=all 为全部） | token |
| POST | `/api/feedback` | 公开提交反馈（网页接入预留） | 仅 siteKey |
| PATCH | `/api/feedbacks` | 更新反馈状态（new/done） | token |
| DELETE | `/api/feedbacks?id=xxx` | 删除反馈 | token |
| GET | `/api/stats?siteId=xxx` | 今日/累计/待处理/类型分布/浏览数 | token |
| GET | `/api/ai-status` | AI 自动总结功能状态 | token |
| GET | `/api/ai-summary?siteId=xxx` | AI 自动总结（未启用时返回 403） | token |
| POST | `/api/analytics` | 浏览/行为埋点上报（网页接入预留） | 仅 siteKey |
| POST | `/api/password` | 修改密码 | token |
| GET | `/api/backup` | 数据备份（下载 JSON） | token |
| POST | `/api/restore` | 数据恢复（上传 JSON 覆盖） | token |

鉴权方式：登录成功后，将返回的 token 放入请求头 `X-Token`。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
