# 部署入口

- Node≥22.19.0，依赖按锁安装；源构建命令见 `../README.md`。
- 私人配置用示例复制后本机填值，不把Key、SSH/OAuth、角色卡、会话和用户Skill放进仓库。
- 当前正文架构/模型分工见 `../docs/ARCHITECTURE-OVERVIEW.md`、`../docs/MODEL-CONNECTIONS.md`。
- 候选build与验证先在隔离路径；真实切换要空闲、备份和版本/会话/私有数据保留核验。
- 不把历史模板的主机/端口/服务名或旧测试数字当当前运行环境。

完整检查表见 `VPS-OPERATIONS.md`，测试 `../TESTING.md`，本地结果 `../docs/VALIDATION-20261007.md`。更新不是自动授权发布或删除旧仓库。

## 安装脚本来源

当前安装脚本在维护中的fork主分支。先下载并检查脚本再执行，公开源码不包含本机尚未发布的私有配置或候选部署。

```bash
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong/main/deploy/install.sh -o install.sh
# 先审阅install.sh，再按其参数选择安装位置/端口
bash install.sh --no-start
```
