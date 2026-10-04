# 梨园 v1.7.2 稳定版

日期：2026-09-23

## 本版重点

### 预设条目管理

- 预设面板支持新增提示词条目。
- 已有条目支持上移、下移，顺序变化写回 `prompt_order` 或旧版 `blocks` 结构。
- 条目支持切换到 Chat History 之前或之后。
- 新增条目支持选择 `system` / `postHistory` 通道。
- 运行时草稿与磁盘保存分开：编辑立即影响下一轮，点击保存后才写入预设文件。
- 保存前会等待排队中的运行时补丁，避免快速点击保存时丢失最后一次移动或编辑。

### 模型切换持久化

- 连接面板切换模型时，同步更新主演 `writer` 插头，下一拍立即使用新选择。
- 运行梨园的系统用户必须对 `liyuan.config.json` 具有写权限，否则界面切换成功但配置无法落盘，重启后会恢复旧模型。
- 部署后可用以下命令检查配置文件属主和权限：

```bash
ls -l liyuan.config.json .liyuan/settings.json
```

### 小说演出

- 保留小说演出卡、作品包、分支校准和导演室模块的稳定版本集成。
- 预设条目管理与小说演出共用同一套预设原文和运行时补丁机制。

## 主要实现

- `web/src/components/PresetPanel.tsx`：预设条目新增、编辑、移动与保存交互。
- `src/preset-doc.ts`：ST `prompt_order` 与旧版 `blocks` 的新增、位置调整和写回。
- `test/preset-doc.test.ts`：新增条目、历史前后位置和上下移动回归测试。
- `server/rest.ts`：模型切换后的主演插头同步与配置保存。

## 验证

- `npm run web:build`
- `npx tsx --test test/draft.test.ts test/workspace.test.ts`
- `npx tsx --test test/model-routing.test.ts`

完整测试集还依赖本机 Node 原生模块环境；`better-sqlite3` 未正确编译时，向量记忆相关测试会单独失败，不代表预设面板或模型切换功能失败。
