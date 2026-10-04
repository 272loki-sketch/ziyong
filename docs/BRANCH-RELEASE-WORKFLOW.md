# 分支发布流程

当前小说开演版本使用分支隔离，`main` 保持原有稳定基线。

## 分支

- `main`: 稳定基线，不直接承载未完成的小说开演功能。
- `feat/novel-play-foundation`: 功能开发、修复和专项验证分支。
- `release/novel-play-v1.7.0`: 从功能分支复制的候选发布分支，用于最后人工验收和部署准备。

## 更新步骤

```bash
git fetch origin
git switch release/novel-play-v1.7.0
git pull --ff-only origin release/novel-play-v1.7.0
npm ci
node --test --test-reporter=./scripts/test-summary.mjs test/novel-play*.test.ts
node --test --test-reporter=./scripts/test-summary.mjs test/*.test.ts
npm --prefix web ci
npm --prefix web run build
```

如果功能分支继续修复，先在 `feat/novel-play-foundation` 完成测试，再重新创建或快进发布分支。不要直接把发布分支强制回写到 `main`。

## 当前状态

最新代码先推送到 `feat/novel-play-foundation`，再推送到 `release/novel-play-v1.7.0`。当前没有合并 `main`，也没有创建正式 GitHub Release。真实模型和浏览器人工验收完成后，再决定是否合并。
