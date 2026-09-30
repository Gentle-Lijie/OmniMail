# 实现验收记录

## 已执行

- `npm test`：13 项通过；使用内存数据库和模拟 fetch，不调用 Outlook。
- `npm run build`：后端 TypeScript、前端 vue-tsc 与 Vite 生产构建通过。
- 根项目和 frontend 的 `npm audit --omit=dev`：0 vulnerabilities。
- `git diff --check`：通过。
- Chromium + 虚拟 WebAuthn 认证器 + 独立临时 SQLite：首次 Passkey 注册、退出、再次登录成功，真实签名经过后端校验。
- 自托管 TinyMCE 能挂载并展示编辑工具栏。
- 浏览器连接真实本地后端，五页在 360 / 768 / 1440px 共 15 个组合均无页面横向溢出。
- 中英文切换与页面导航正常；修正 favicon 后控制台无错误。
- 手机宽度邮件草稿创建与二次确认弹窗成功；只使用允许的两个地址，测试 worker 关闭，没有外部发送。
- CSV/Excel 解析、行数限制、原始保留字段与重复表头拒绝；模板版本与回滚；MCP 初始化、API key 撤销、直接排队与批量占位符校验均有后端测试。
- 后端一次只读复核发现的取消重启状态与 MCP 批量校验问题已修复，回归测试通过。

## 未执行 / 运行前置条件

- 没有真实发送邮件、日程邀请或调用真实 AI 上游。需要管理员在设置中配置接口及 Provider 后验收。
- Power Automate 200/202 只能证明接收；实际成功还需 Flow 运行历史和 Outlook 动作核查。
- Docker daemon 未运行，未构建/运行 Docker 镜像；Compose 可以使用 `ENV_FILE=.env.example docker compose config --quiet` 做静态校验。
- 尚未部署 HTTPS 或验证实体设备 Passkey。
- 没有 Git remote，未 push、创建 PR 或触发 GitHub Actions。
- TinyMCE 按需加载包约 1.18 MB（gzip 406 KB），构建有 chunk 体积提示，不影响构建通过。TinyMCE 内置工具栏当前为英文。

## 真实测试限制

To / CC / BCC / 必选和可选参会者只能为：
- scylz12@nottingham.edu.cn
- zljzljsweepy@qq.com

后续真实测试必须明确检查最终渲染后的全部地址，不自动重试结果不确定的请求。
