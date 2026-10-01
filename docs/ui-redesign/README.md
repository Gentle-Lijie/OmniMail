# OmniMail UI 定稿基线

定稿日期：2026-10-01。

`desk.html` 是唯一保留的 UI 设计基线。此前的 Compose、Canvas、Flow、Wizard、Grid 及其他概念方案已移除，后续 UI 实现以此版本为准。

## 定稿范围

- Desk 工作台布局；任务空间仅在工作台显示。
- OmniMail Agent 协作面板，以及新建邮件草稿后自动打开的「从零起草」弹窗。
- 可不使用模板，支持自由写作与 Agent 起草建议的预览、选择和人工应用。
- 邮件合并名单导入、收件人列确认、字段高亮与快捷插入、问题校验和逐行预览。
- TinyMCE、Raw HTML 与预览三种模式，以及明暗主题、响应式布局。
- 邮件执行始终需人工确认；无左下角额度提示。

本次定稿未修改 `desk.html` 内容。任何后续设计调整需明确提出，不再保留并行备选方案。

## 本地预览

在仓库根目录运行：

```sh
python3 -m http.server 4178 --bind 127.0.0.1
```

访问 `http://127.0.0.1:4178/docs/ui-redesign/desk.html`。

TinyMCE 使用本地 `frontend/node_modules/tinymce` 资源，需已安装 frontend 依赖。当前仍为设计原型：Agent 起草与执行使用本地模拟，不连接真实 AI、邮件或日程服务；会话数据不持久化。主应用源码未在本次定稿中修改。

## 版本校验

定稿 HTML 的 SHA-256：

```text
4cf7644680c190c618057d3d6549eae2b1c253bc75ea71c88eba57b2219f5761
```

`desk.html` 与本说明已从 Git 忽略规则中排除，可随仓库版本管理；本次操作不创建提交。
