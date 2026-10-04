# Liyuan 部署

## 方式 A：一键安装脚本（systemd / 后台进程）

> 公开发布前，先确认目标仓库为 **Public**，并在未登录状态验证 Git 克隆与 raw 安装脚本均可访问；不要在未验证前宣传匿名一键安装。

```bash
# 目标仓库公开且匿名 raw 访问已验证后可用（默认安装 main）：
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong/main/deploy/install.sh | bash

# 本地克隆后安装（例如需先检查或调整安装参数）：
git clone --depth 1 --branch main https://github.com/272loki-sketch/ziyong.git /opt/liyuan
bash /opt/liyuan/deploy/install.sh --dir /opt/liyuan --port 7620 --ref main

# 自定义参数示例
bash deploy/install.sh --dir /opt/liyuan --port 7620 --repo https://github.com/272loki-sketch/ziyong.git --ref main --service liyuan
```

要求：Linux、Node.js >= 22.19.0（需预装；脚本只检查，不安装）、npm、curl、git、可联网；root 用于写 systemd。

装好后：

```bash
# 填 API Key
nano /opt/liyuan/liyuan.agent.json

# 服务管理
systemctl status liyuan
systemctl restart liyuan
```

## 方式 B：Docker Compose

```bash
git clone --depth 1 --branch main https://github.com/272loki-sketch/ziyong.git
cd ziyong
docker compose up -d --build
# 打开 http://服务器IP:7620
```

首启无需任何手工准备。容器会自己在宿主机建好 `./data/`：

```
data/config/liyuan.config.json   角色卡 / 世界书 / 用户身份（从 example 播种）
data/config/liyuan.agent.json    模型与 API Key（从 example 播种，勿提交仓库）
data/cards/                      角色卡，含默认「青梧」
data/lorebooks/                  世界书
```

填 Key 有两条路，任选：

```bash
# 路子一：直接在网页的「连接」面板里填，即时生效，不用重启
# 路子二：改文件
nano data/config/liyuan.agent.json
docker compose restart
```

停止 / 清理：

```bash
docker compose down
# 连数据一起删：
docker compose down -v
```

### 报错 "Are you trying to mount a directory onto a file?"

v1.2.0 及更早版本把 `liyuan.config.json` / `liyuan.agent.json` 做了文件级挂载。宿主机上没有这两个文件时，Docker 会建两个**空目录**顶上去，撞上镜像里的同名文件就崩（[issue #1](https://github.com/weidu12123/Liyuan/issues/1)）。v1.2.1 起改成只挂 `data/config` 目录，不会再有这问题。

已经踩上的话，拉新版直接起就行，不用手工删任何东西——entrypoint 会认出那两个空目录、清掉并重新播种：

```bash
git pull
docker compose up -d --build
```

若你之前按旧文档手工填过 `data/config/liyuan.agent.json`（是文件不是目录），它会被原样保留，Key 不丢。

## 仓库迁移发布核验

- 发布前确认 `272loki-sketch/ziyong` 的仓库可见性为 Public，并从未登录环境验证 `git clone`、`git ls-remote` 与 `raw.githubusercontent.com` 安装脚本读取。
- 在目标仓库公开及匿名访问验证完成后，按已授权流程删除旧仓库；随后按账户仓库列表及未登录访问结果核验删除状态。该核验只说明仓库入口状态，不代表所有历史对象、缓存或第三方副本均已物理消失。
