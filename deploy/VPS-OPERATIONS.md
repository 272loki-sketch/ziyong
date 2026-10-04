# 梨园 VPS 部署与运维模板

> 当前代码基线为 v1.7.3。本文仅记录产品结构和操作模板，不保存实际公网地址、登录名、私钥路径、访问密码、模型网关或 API Key。实际值请在服务器本机受限配置中维护。旧 Git 提交中的敏感文本不会因本页匿名化而消失。

## 1. 部署结构与版本

- Node.js ≥22.19.0；本次验收运行时为 Node 22.23.2。
- 应用服务通常由 `liyuan.service` 管理，示例工作目录 `/root/Liyuan`。
- 示例内部地址为 `127.0.0.1:7620`；公网入口、端口、域名及 TLS 证书由部署者配置，不以本文模板代替实际状态。
- 运行数据目录、Agent 会话目录及归属需以实际 systemd 配置为准；示例 Agent 目录 `/var/lib/liyuan/agent`。
- 最新源码默认使用 fork 的 `main`；本机 `local` 跟踪 `origin/local`。

## 2. 连接与访问控制

在本机安全地设置以下变量；不要把实际值提交到仓库：

```bash
ssh -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_USER@$VPS_HOST"
```

公网必须配置 TLS 与访问控制。可使用 Nginx Basic Auth，同时按需要设置应用访问密码。用交互输入创建 Basic Auth 用户，避免明文密码进入命令行、进程列表与 shell 历史：

```bash
htpasswd -c "$NGINX_AUTH_FILE" "$BASIC_AUTH_USER"
# 之后按实际 Nginx 用户组设置权限，并验证/重载现有配置
```

关闭或修改应用密码会改变 WebSocket 权限；v1.7.3 会撤销失效连接。不要为方便把应用裸暴露到公网。

## 3. 配置与权限

`liyuan.agent.json` 保存模型配置/凭据，`liyuan.config.json` 保存当前卡、用户身份、预设及工作流配置；均为私有运行数据。配置模型时填自己的 `MODEL_API_BASE_URL` 与 `MODEL_ID`，不在文档中记录实际账号配置。

服务账户应能读源码并写其配置和运行数据。建议凭据文件权限 600，目录归属与实际 `User/Group` 对齐，不能通过全仓递归放宽权限解决问题。用户 Skill 覆盖在 `.liyuan-stage-skills/`，更新代码不得覆盖它。

## 4. 服务管理与健康检查

```bash
systemctl status liyuan
systemctl show liyuan -p MainPID -p User -p Group -p WorkingDirectory
journalctl -u liyuan -n 100 --no-pager
# 确认无正在生成回合、已备份后才能重启
systemctl restart liyuan
curl -fsS http://127.0.0.1:7620/healthz
# 公网证书与密码通过本机变量/交互处理，不把实际值写进文档
curl --cacert "$NGINX_CA_CERT" --user "$BASIC_AUTH_USER" "https://$VPS_HOST:$HTTPS_PORT/healthz"
```

健康响应应包含 `ok: true` 与当前后端 `version`。同时检查页面、hello/assistant_hello 的版本和实际提供的 hashed JS/SW；磁盘 package.json 新并不表示旧进程已重新载入。

## 5. 受控更新

1. 先确认分支、工作区、运行中版本和无生成任务；保留所有未提交工作。
2. 在受限本机目录备份 Git bundle、代码/前端、配置、会话、记忆及用户覆盖；不把备份提交到远端。
3. 普通同步默认 fetch/review/merge `origin/main`，可用 `LIYUAN_UPSTREAM` 覆写。发布 push 需要单独明确授权，不能 force-push。
4. 用匹配运行时执行 `npm run verify`，前端先构建到隔离候选目录，检查前后端版本及 SW 缓存版本。
5. 备份后受控停止服务，原子安装新前端、启动新后端，核对会话保持与配置内容未变。
6. 更新源码不擅自改变运行账户、反代端口、访问密码或模型连接。

v1.7.3 的旧前端/旧宿主能力协商可保留草稿，但不能以此代替配套发布。助手已发出却未确认的输入应核对历史后手动重试，不自动重复执行。

## 6. 故障与恢复

- 先检查服务状态、版本和受限日志；共享日志前去除凭据、用户内容和内部地址。
- 确认服务账户权限与 Node 版本，不直接重建或清空用户目录。
- 程序失败通常只需要回滚代码/前端，不应把最新会话也倒退。
- 本轮记忆操作锁只保证同进程服务入口；多进程共享同一会话/SQLite 不属于该保证。
- 当前文件脱敏不能撤销已泄露的密码/Token。若旧历史出现过仍有效凭据，先轮换，再讨论历史清理；不擅自重写所有分支/标签。
