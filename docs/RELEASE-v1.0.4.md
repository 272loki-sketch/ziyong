# Liyuan Agent 1.0.4

## 本版要点

1. **Kimi 采样参数优化**：预设现已支持 Kimi K3（及同类固定采样模型），开预设不再因温度等参数被渠道拒绝。
2. **停止按钮进一步修复**：点停止后更干净收尾，减少「停了还在跑」、工具/选择后误续写。
3. **Agent 执行过程 RP 化**：过程条仿照传统编程 agent 展示步骤，并用 RP 人话说明「在干什么」（非工具 JSON）。
4. **扮演中断留痕便于继续**：生成到一半停止时，半截正文/思考会留下并标「未完成」，可接着写。

## 安装包

| 平台 | 文件 |
|------|------|
| Windows | `Liyuan-1.0.4-windows.zip` |
| Linux | `Liyuan-1.0.4-linux.zip` |
| macOS | `Liyuan-1.0.4-macos.zip` |
| 校验 | `SHA256SUMS.txt` |

| **Docker** | 见仓库 `docker-compose.yml` | `docker compose up -d --build` |

## 快速开始

见各包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`。需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。
