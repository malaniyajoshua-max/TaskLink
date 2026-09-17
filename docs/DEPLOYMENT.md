# TaskLink 部署、安全与发布

## 服务配置

本机默认 API 为 `http://127.0.0.1:8000/api/v1`，只用于开发和验收。生产客户端必须使用 HTTPS：

| 环境变量 | 说明 |
| --- | --- |
| `TASKLINK_API_URL` | 客户端 API 基础地址；非回环地址必须使用 HTTPS |
| `TASKLINK_DATABASE_URL` | 服务端数据库连接；默认 `server/data/tasklink.db` |
| `TASKLINK_DATA_KEY` | 32 随机字节的 Base64 服务端数据密钥 |
| `TASKLINK_ALLOWED_HOSTS` | 生产 API 允许的精确 Host 列表 |
| `TASKLINK_USER_DATA` | 可选的桌面端用户数据目录 |
| `TASKLINK_UPDATE_URL` | 签名更新源的 HTTPS 地址 |
| `TASKLINK_PUBLISHER_NAME` | 必须与代码签名证书发布者一致 |

注册和密码找回需要 TLS SMTP：

```powershell
$env:TASKLINK_SMTP_HOST='smtp.example.com'
$env:TASKLINK_SMTP_PORT='465'
$env:TASKLINK_SMTP_SECURITY='ssl' # 或 starttls
$env:TASKLINK_SMTP_FROM='TaskLink <no-reply@example.com>'
$env:TASKLINK_SMTP_USERNAME='no-reply@example.com'
$env:TASKLINK_SMTP_PASSWORD='<由秘密管理服务注入>'
$env:TASKLINK_RESET_PEPPER='<独立的高熵秘密>'
```

验证码 10 分钟失效、最多尝试 5 次、成功后只能使用一次，60 秒内不重复发送。生产环境不得设置 `TASKLINK_ENV=test` 或 `TASKLINK_TEST_EMAIL_CODE`。公共部署还需要邮件队列、重试、退信和到达率监控。

## 安全边界

桌面端使用 sandbox、context isolation、受限 preload 和 CSP；renderer 不能直接访问 Node、文件系统、SQLite 或令牌。任务、项目、同步正文、聊天、通知与设置采用 AES-256-GCM 字段加密，本机密钥和凭据由 Windows DPAPI 保护。服务端也使用独立字段加密，但系统不是端到端加密：服务端需要解密来处理同步和协作，查询所需的账号、关系、状态与部分日期元数据仍可见。

生产密钥、SMTP 密码、代码签名证书和发布凭据不得写入仓库、安装包或日志。密钥丢失且没有可用的口令备份时，加密正文无法恢复。应同时备份数据库和密钥，并启用磁盘加密、锁屏、操作系统更新、网关共享限流、日志脱敏、监控和告警。

桌面附件不会自动执行，下载后校验原字节哈希并设置 Windows 网络来源标记。仓库未集成杀毒引擎，也未宣称第三方渗透测试、MFA、自动密钥轮换、合规认证或生产容量验证。

## 备份与恢复

桌面端在“设置 → 数据保护”创建 `.tlbackup`。备份包含当前账号数据库、未同步队列和恢复所需数据密钥，使用至少 12 字符的独立口令再次加密，不包含登录凭据。跨机恢复时先安装应用并登录同一服务账号，再选择备份文件。

服务端 SQLite 备份在 `server` 目录执行，口令通过交互输入：

```powershell
.\.venv\Scripts\python.exe -m app.backup create --output 'D:\Backups\TaskLink.tlserver'
.\.venv\Scripts\python.exe -m app.backup restore --input 'D:\Backups\TaskLink.tlserver' --database 'D:\TaskLinkRestore\tasklink.db' --key-file 'D:\TaskLinkRestore\storage-key.dpapi'
```

恢复必须写入新的数据库和密钥路径，并在切换生产流量前运行迁移、完整性检查、登录与同步验证。PostgreSQL 部署应使用数据库原生备份，同时单独保管字段加密密钥。

## 发布检查

每个版本至少完成以下检查：

1. 运行 `scripts/test.ps1`，确认服务端、桌面单元测试、类型检查、格式检查和 Electron E2E 全部通过。
2. 更新 OpenAPI 后运行 `scripts/contracts.ps1`，确认生成类型与提交内容一致。
3. 在 `desktop` 运行 `npm.cmd run package` 和 `node scripts/packaged-smoke.mjs`。
4. 在干净 Windows 用户环境验证安装、注册、登录、托盘提醒、自定义提示音、备份恢复和卸载。
5. 使用受信任代码签名证书签名安装器和程序，记录 SHA-256，并把安装器作为 GitHub Release 附件发布，不提交到源码分支。
6. 用生产 HTTPS API、TLS SMTP 和更新源验证从旧签名版本升级到新版本。

未签名的本机测试安装包适合内部验收，不应描述为已具备公开分发信任链。启用 `TASKLINK_UPDATE_URL` 时必须同时配置与证书一致的 `TASKLINK_PUBLISHER_NAME`。

## GitHub 发布边界

Git 分支只提交源码、锁文件、必要资源、测试和维护文档。`node_modules`、`.venv`、数据库、DPAPI 文件、凭据、测试现场、日志、截图、`dist`、`release`、`work` 与 `deliverables` 均由 `.gitignore` 排除。仓库目前没有开源许可证；公开可见不等于允许复制、修改或再分发。如需接受外部贡献或开源发布，应在首次公开前选择并添加明确许可证。
