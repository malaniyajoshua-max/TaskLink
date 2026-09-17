# TaskLink

TaskLink 是面向 Windows 的任务、日历与轻协作桌面应用。它把个人任务、项目、一级子任务、提醒、专注计时、离线同步和一对一聊天放在统一工作区内，并提供春夏秋冬 × 日夜八套季节主题。

## 主要能力

- 任务列表、看板、今日、未来七天、日历、搜索、筛选、排序与批量整理。
- 一级父子任务，截止时间、优先级和提醒可分别继承或独立设置，完成状态双向联动。
- 项目与工作区、成员权限、好友、一对一聊天、图片与常用办公附件。
- 离线写入、自动同步、冲突处理、JSON 导入导出和口令加密备份。
- 系统通知、提示音、可选自定义音频、托盘驻留和点击通知回到任务。
- 春、夏、秋、冬各含日间与夜间主题，另有经典浅色、经典深色和跟随系统。

完整用法见[用户指南](docs/USER_GUIDE.md)，部署、安全与发布要求见[部署指南](docs/DEPLOYMENT.md)，内部设计见[架构说明](docs/ARCHITECTURE.md)。版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。

## 开发环境

需要 Windows x64、Node.js 24、Python 3.13 和 PowerShell。首次运行会下载依赖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

分别在两个终端启动服务端和桌面端：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Target server
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Target desktop
```

服务健康检查地址为 `http://127.0.0.1:8000/health`。首次注册需要邮件验证码，启动前按[部署指南](docs/DEPLOYMENT.md)配置 TLS SMTP。普通浏览器没有 Electron preload 桥，不能替代桌面客户端。

## 测试与构建

```powershell
# 在项目根目录运行全部自动检查
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1

# 构建 Windows 安装包
Set-Location .\desktop
npm.cmd run package
node .\scripts\packaged-smoke.mjs
```

安装器位于 `desktop/release`，该目录属于构建产物，不提交 Git。生成可校验的源码归档：

```powershell
.\server\.venv\Scripts\python.exe .\scripts\package-source.py --output .\deliverables\TaskLink-source.zip
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `desktop/src` | React 界面、交互与主题 |
| `desktop/electron` | Electron 主进程、本地数据库、同步与通知 |
| `desktop/shared` | IPC 契约和跨进程纯逻辑 |
| `desktop/tests`、`desktop/e2e` | 单元、集成与桌面流程测试 |
| `server/app` | FastAPI、权限、业务服务与数据库访问 |
| `contracts` | OpenAPI 契约与生成类型的来源 |
| `scripts` | 初始化、测试、契约和源码发布工具 |
| `docs` | 用户、部署和架构文档 |

## 仓库边界

源码仓库不包含依赖目录、虚拟环境、数据库、密钥、凭据、日志、截图、测试现场、安装包或其他构建产物。运行和测试会重新生成这些内容。生产证书、SMTP 密码、数据密钥和发布凭据必须由部署环境的秘密管理系统提供。
