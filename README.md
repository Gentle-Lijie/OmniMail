# OmniMail

Vue 3 / TypeScript / shadcn-vue 极简商务工作台，通过 Power Automate 发送 Outlook HTML 邮件和创建北京时间日程。无用户账号；所有已登记 Passkey 共享工作空间。SQLite 持久化配置、模板版本、任务、凭证与审计记录。

## 本地运行

要求 Node.js 22+。

```bash
npm ci
npm --prefix frontend ci
cp .env.example .env
# 将 APP_SECRET、SETUP_TOKEN 分别替换为 openssl rand -hex 32 生成的值
set -a; source .env; set +a
npm run dev
```

访问 `http://localhost:5173`。首次登记 Passkey 需输入 `SETUP_TOKEN`；后续新增凭证必须已经登录，且注册开关开启。Passkey 需要支持 WebAuthn 的浏览器与系统认证器。localhost 可用于开发，正式环境必须 HTTPS。

```bash
npm test
npm run build
# 运行构建后的同源站点（更新 APP_ORIGIN 为实际访问地址）
npm start
```

## HTTPS 部署

1. 设置 `.env` 中 `APP_ORIGIN=https://你的域名`，生成独立随机 `APP_SECRET` 与 `SETUP_TOKEN`。
2. `docker compose up -d --build`。
3. 用 Caddy/Nginx 将 HTTPS 反向代理到 `127.0.0.1:3000`；后端提供前端静态文件、`/api` 和 `/mcp`。
4. 浏览器绑定首个 Passkey，再配置 Webhook 与 AI Provider。

Caddy 示例：

```caddyfile
mail.example.org {
  reverse_proxy 127.0.0.1:3000
}
```

同一实例只能运行一个任务 worker。SQLite 使用 WAL；不要通过多个副本共享数据库并并行执行任务。卷 `omnimail-data` 必须持久化。备份需包含数据库与 `APP_SECRET`；丢失主密钥会使已存配置无法解密。`APP_ORIGIN` 的域名就是 Passkey RP ID，换域名需重新绑定凭证。

## 前端工作台

前端以 `docs/ui-redesign/desk.html` 定稿为设计基线，交互控件统一使用 Reka UI 组件与 Lucide 图标，不使用 emoji。

- 工作台提供独立草稿空间；新建邮件后自动打开 Agent 起草弹窗，允许跳过并自由写作。切换页面或草稿不清空编辑状态；刷新后未保存的编辑会丢失，保存的服务器草稿可在历史中继续审核。
- Agent 调用真实已配置的服务，返回建议预览；只有人工应用才更新主题与正文，不让 AI 改动收件人或直接执行任务。
- 名单支持 CSV / Excel，导入后必须确认收件人列。支持字段映射、正文高亮与光标处快捷插入、分页编辑、问题行筛选和逐行个性化预览；审核前校验整个批次。
- 编辑器提供 TinyMCE、Raw HTML 与隔离预览。应用模板只替换主题与正文，已有内容会要求确认，不清空收件人、名单或日程信息。
- 历史、模板、设置、AI Provider 配置与 MCP 共用主题与组件。任务空间仅在工作台显示；支持明暗主题和窄屏布局。
- 保存草稿不会发送。执行前展示整批数量、逐条收件人与正文预览，并要求明确勾选人工确认。前端自动化验证使用模拟 API，后端测试使用内存数据库，不调用真实邮件接口。

## 邮件与日程

- 邮件字段：`to`、`cc`、`bcc`、`subject`、`html`。多个邮箱使用分号。CC/BCC 未使用时传空字符串。
- 日程字段：`subject`、`start`、`end`、`requiredAttendees`、`optionalAttendees`、`location`、`html`。
- 日程固定北京时间，日期不带 `Z` 或 UTC 偏移；结束时间必须晚于开始。添加参会者会发送邀请。
- 目前 Flow Schema **不支持文件附件、重复日程、全天标识或自动生成 Teams 会议**。协议外层 `attachments` 不是邮件附件。
- 模板支持 `{{ field }}`。批量导入 CSV/XLS/XLSX，最多 5 MB、1000 行、100 列；逐行渲染并校验整个批次后才创建草稿。HTML 占位符值进行转义。
- Web 任务创建后必须再次确认，AI 只修改草稿。取消只停止尚未执行的条目，不能撤回已经发出的内容。
- HTTP 2xx 记录为 `accepted`（接口已接收），**不证明 Outlook 已发送或收件箱送达**。5xx、网络错误及超时记录为 `uncertain`。不会自动重试；应先核查 Power Automate 运行历史。
- 重启时正在请求的条目标记不确定，剩余待执行条目恢复入队。

Webhook URL 是 bearer 密钥。可以在设置页输入，或首次启动通过 `OUTLOOK_MAIL_WEBHOOK_URL` / `OUTLOOK_EVENT_WEBHOOK_URL` 环境变量导入。配置保存后只返回是否已配置，不回显 URL。不要提交带 `sig` 的 URL。

## AI Provider

支持 OpenAI **Responses API** 和 Anthropic **Messages API**；可配置多个自定义 Provider，填写协议、Base URL（例如 `https://api.openai.com/v1` / `https://api.anthropic.com/v1`）、模型和 API Key。

- 默认使用 `<Base URL>/models` 获取模型，支持自定义模型列表地址。
- 上游不支持列表时，可手动输入模型 ID。
- 模型测试实际执行最小推理请求，可能产生费用。列出模型并不代表支持当前协议。
- 密钥和自定义认证头使用 AES-256-GCM 加密存储。设置响应不返回密钥。
- Agent 接收对话、当前草稿及模板；批量数据默认只发送列名，不上传完整名单。不要在对话中放入不希望发送给 AI 的敏感信息。
- 当前 Agent 使用非流式结构化响应；无外部执行工具。模型生成结果仍需人工检查。

## MCP

标准 Streamable HTTP，`POST /mcp`，Header `Authorization: Bearer <API_KEY>`。在 MCP 页创建密钥，仅显示一次；可以撤销。

工具：

- `send_email`：立即创建并排队邮件任务，无 Web 人工确认。
- `create_event`：立即创建并排队日程任务，无 Web 人工确认。
- `get_task`：查询状态和逐条结果。
- `list_templates`：获取模板。

MCP 密钥具有实际发送/邀请权限，不能暴露到前端源码、公开仓库或不可信 Agent。工具返回排队状态，不代表发送完成。

## 安全与恢复

浏览器会话 HttpOnly / SameSite=Strict，HTTPS 环境使用 Secure；写 API 校验 CSRF，认证校验 Origin、挑战有效期、签名与用户验证。注册需初始化令牌或已认证会话；禁止移除最后一把 Passkey。不要在运行系统中直接编辑凭证数据库。

若丢失全部 Passkey：停止服务，备份数据库；由服务器管理员删除 `passkeys` 和 `sessions` 表中的记录，设置新的随机 `SETUP_TOKEN` 后启动并重新绑定。此流程只能由有服务器权限的管理员操作，且保留模板和历史数据。

当前历史列表返回最近 500 个任务，worker 不受该列表上限影响。保存的邮件正文、收件人和对话属于敏感数据；保护数据库备份和服务器访问。

## Git 工作流

功能分支开发，Conventional Commit 分阶段提交，CI 运行测试、构建与依赖检查，通过 PR 审核后合并 `main`。本地不会自动推送或在没有远程仓库时创建 PR。

## 测试安全

自动化后端测试使用内存数据库及模拟 HTTP，不调用真实 Outlook。任何需要真实邮件/邀请的人工测试，收件人（包含 To/CC/BCC 与参会者）只能为 `scylz12@nottingham.edu.cn` 和 `zljzljsweepy@qq.com`。真实接口验收还需核查 Flow 的 Outlook 动作以及收件箱/日历，不能仅检查 HTTP 状态。

TinyMCE 使用 GPL 自托管版本；分发或商用请核对 GPL 义务或购买商业许可。
