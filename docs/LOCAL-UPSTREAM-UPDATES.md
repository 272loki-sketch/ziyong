# 梨园 fork：上游同步、分支与发布规约

本文说明梨园 fork 的 `main` / `local` 分支职责、如何安全接收上游更新，以及如何在明确授权后发布到 fork。远端推送和 VPS 部署是两个独立步骤；任何例行更新都不会自动推送或重启服务。

## 1. 分支与当前基线

- `origin/main`：fork 上的项目基线分支，用于审阅上游更新。
- `local`：VPS 实际运行分支，包含梨园本地产品增强，并跟踪 `origin/local`。
- `origin/local`：fork 上供部署版本发布/同步使用的远端分支。

当前产品版本为 v1.7.3。为保护隐私，用户另外明确要求把本仓库整理为仅包含最新内容的无父提交快照；当前实际引用和清理结果以 GitHub 核对报告为准，不能将这次特殊授权当作以后允许随意强推。

用户已明确授权本轮最新发布推送与部署，并随后明确要求清除旧 Git 历史、只保留最新快照。本次历史整理必须先做本机私有 Git bundle 备份、保护用户数据，并在更新前核对远端旧引用；仅针对本仓库进行一次性受控改写。普通上游同步仍只 fetch / review / merge，不隐含 push 或历史改写。

## 2. 安全接收上游更新

更新前先确认目标分支和工作区状态；保留所有未提交工作，不以 stash、reset 或清理命令代替人工协调。先备份 Git 与运行数据，再获取远端并审阅差异：

```bash
cd /root/Liyuan
git status --short
git fetch origin --tags
git branch -avv
git log --oneline --decorate local..origin/main
git diff --stat local...origin/main
```

确认上游提交及 merge-base 后，再由维护者按当前分支拓扑用普通 merge 将审阅后的基线合入 `local`；不要假设存在同名本地 `main` 分支，也不要把 `origin/local` 当作上游来源。任何冲突都先停止处理并保留现场；测试或构建失败时不要部署。不要使用 `git reset --hard`、强推、自动清理用户数据或在未审阅时覆盖本地增强。

> `scripts/update-local.sh` 已迁移到默认 `origin/main`，也可通过 `LIYUAN_UPSTREAM` 指定其他经过审阅的分支。脚本保留脏工作区拒绝、备份、冲突停止和验证后重启边界；普通同步不会自动 push。

## 3. 本轮发布与推送边界

发布前核实目标分支、工作区差异、版本元数据、发行内容和隐私扫描结果；只推送发布负责人明确选定的提交及目标分支。已获授权的本轮推送不改变以下安全要求：

- 不推送 API Key、访问凭据、真实配置、运行数据、会话、用户 Skill 覆盖或私有备份。
- 普通发布不重写历史、不 force-push。此次隐私清理是用户明确授权的例外：以最新审阅树创建无父提交，受控替换 main/local，并删除指向旧历史的分支/标签；引用前进时仍停止复核，不覆盖未审阅的新工作。
- 推送成功不等于部署成功。部署前先完成构建和测试、备份配置与会话数据，再执行受控部署并验证健康状态。
- 发布失败时保留工作区与线上现场，按审核后的回滚/恢复步骤处理，不自动删除或覆盖数据。

## 4. 哪些内容不进入版本库

`.gitignore` 与发行打包规则保护用户数据和本机材料，包括：

```text
liyuan.agent.json             模型连接与 API Key
liyuan.config.json            当前角色卡、预设与运行配置
.liyuan/                      世界画像、生态池和其他运行数据
.liyuan-stage-skills/         用户编辑的文学 Skill 覆盖
.liyuan-memory/               检索记忆
.liyuan-state/                本地状态文件
.liyuan-personas.json         用户画像数据
liyuan-profiles/              本地配置档
data/                         Docker / 部署数据
/var/lib/liyuan/agent/         仓库外会话与 Agent 数据
.backup/                      本机私有备份
```

`skills/` 是随代码维护的内置规则；用户编辑版放在 `.liyuan-stage-skills/`，更新内置 Skill 时不得覆盖用户正文。

## 5. 提交、验证与恢复

提交由发布负责人明确选择文件后进行；本任务中的协作者不得擅自 stage 或 commit。至少检查：

```bash
git diff --check
git status --short
npm test
npm --prefix web run typecheck
npm run web:build
```

不要提交真实配置、用户数据、`.backup/`、临时诊断材料或会话文件。恢复时先保留故障现场；代码回滚与用户会话/运行数据恢复分开判断，通常不要因代码回滚而倒退最新会话。

## 历史清理后的同步

清理后，旧 clone 的提交不再与新 main 共享发布祖先；旧机器直接 merge 或 push 可能重新引入旧历史。应备份其用户数据后重新克隆最新版，或由维护者明确隔离旧 Git 元数据。私有 Git bundle 仅用于本机恢复，不再次上传公共仓库。

重写可见分支/标签不能删除第三方副本、GitHub PR 的只读引用、缓存或所有已知 SHA 链接。若历史有仍有效凭据，应先轮换，再联系 GitHub 支持清理残留；不以“提交列表只剩一个”宣称所有存储均已抹除。
