# Liyuan Agent 1.0.3

## 本版要点

- **采样参数按渠道投影**（对齐 ST）：预设可保留全套 `temperature` / `top_k` 等；发送时只带当前源认的键。自定义中转默认仅核心 4 键，避免 `top_k` / `repetition_penalty` 打挂严校验 API。
- **LongCat**：`temperature` 钳到官方 `0~1`（预设 1.27 不再秒 400）；Base URL 请用 `https://api.longcat.chat/openai/v1`（含 `/openai`）。
- **预设只服务剧情生成**：纯非剧情（办事/面板/配置）不注入预设 system/postHistory。
- **标签策略引擎**：未知标签默认 unwrap（留内容、去标签）；fold/panel/strip 按名称模式 + 预设发现，不再枚举无穷名单。
- **assistant_run 网关**：jiti 与 ESM 共用 `globalThis` 注册表，修复「助手已就位却委托不可用」。
- **面板可编辑（方案 A）**：agent 面板支持手改 markdown/svg/html 源码并保存，下轮 agent 可见。
- **面板全文进上下文**：每轮注入活跃面板当前 content（用户手改后模型可见；超长截断）。
- **助手绑定剧情会话**：新聊天 / 切换剧情会话时右栏助手对齐（有绑定则打开，无则新建），避免接着旧助手上下文。
- **媒体交付**：`show_media` 入库 `/media/`；委托时双写剧情流；交回时自动补捞漏路径；**同内容本回合只交付一次**（防 show_media + 自动捞路径连推）。
- **停止 / 双 agent / 面板同步** 等此前开发项一并收口。

## 安装包

| 平台 | 文件 |
|------|------|
| Windows | `Liyuan-1.0.3-windows.zip` |
| Linux | `Liyuan-1.0.3-linux.zip` |
| macOS | `Liyuan-1.0.3-macos.zip` |
| 校验 | `SHA256SUMS.txt` |

| **Docker** | 见仓库 `docker-compose.yml` | `docker compose up -d --build` |

## 快速开始

见各包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`。需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。
