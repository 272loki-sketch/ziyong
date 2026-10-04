# 小说研究消化故障复盘（2026-09-01）

## 结论

2026-09-01 发现 VPS 上多部小说研究任务数小时没有完成。根因不是 API 不可用，也不是 Flash 模型本身速度慢，而是研究旁路的模型兼容参数、最终消息读取和重试层叠共同造成了长时间假死。

修复后，三部真实 Kakuyomu 文档全部进入 `ready`：

| 文档 | 摘要块 | 套路 | 日常卡 | 中尺度素材 | 结果 |
|---|---:|---:|---:|---:|---|
| `doc-6c4761cd8d158b46` | 12 | 0 | 0 | 0 | ready（降级提炼） |
| `doc-a21392be298e9eb3` | 14 | 16 | 0 | 0 | ready（部分提炼降级） |
| `doc-0a15432deb85fb5c` | 6 | 0 | 0 | 0 | ready（降级提炼） |

说明：摘要和全书梗概是核心产物；套路、日常卡和中尺度素材属于增强产物，增强产物部分失败不再阻塞文档完成。

## 故障链路

小说消化流程为：

```text
Kakuyomu 抓取
  → 清洗 / 分章 / 分块
  → digest-map（块摘要）
  → digest-reduce-arc（弧线摘要）
  → digest-reduce-final（全书梗概）
  → digest-extract-*（套路 / 日常 / 素材，并行）
  → digest-audit
  → 研究库入库
  → ready
```

实际故障包含四个问题：

1. 当前 `new` 中转的 `zai/glm-5.3-flash` 对长结构化 prompt 默认产生 reasoning；在有限 `max_tokens` 下，返回 HTTP 200，但正文 `content` 为空、`finish_reason=length`，输出预算几乎全部被 reasoning 消耗。最小请求正常并不能证明研究请求参数正确。
2. 研究旁路只读取 `done` 事件上的 `event.message`。部分适配器的最终消息只在 `EventStream.result()` 中提供，导致已经完成的响应被误判为“最终消息无文本”。
3. `CorpusEngine` 自己有最多 4 次调用尝试，旁路又固定给底层 SDK `maxRetries=9`，单次请求允许等待 300 秒，形成多层重试和小时级等待。
4. 三个增强提炼任务任一个解析失败都会让整部文档失败并重新入队；模型返回部分有效结果也无法落盘。

## 修复内容

- `server/main.ts`：非流式研究调用直接使用绑定正确的 `stream.result()`；研究旁路关闭底层 SDK 的隐式 9 次重试，交由 CorpusEngine 统一控制；研究请求超时收紧为 90 秒。
- `src/outline/corpus.ts`：摘要字段支持严格 JSON 失败后的字段级提取；每次模型调用只传当前 task 对应的 Skill 小节；模型调用硬超时收紧为 60 秒；增强提炼改为部分成功也继续落盘。
- `liyuan.config.json`：当前生产配置将 `novelDigest` 独立插头切换为已验证可稳定返回结构化正文的 `new/gpt-5.6-sol`；正文 writer 和其他旁路配置不变。
- 日志增加模型调用错误和增强提炼降级信息，能够区分 API 错误、空正文、解析失败和降级。

## 当前重试语义

- 单次 Corpus 模型调用：最多 4 次（初次 + 3 次重试）。
- 底层 SDK：研究旁路不再额外进行 9 次隐式重试。
- 文档级失败：最多自动重新入队 3 次。
- 单部文档的增强提炼失败：记录降级并继续 `ready`，不会重新消化全文。
- 取消、服务重启和网络中断：保留已落盘的块摘要，启动时断点恢复。

## 验证

```bash
/opt/node22/bin/node --check server/main.ts
/opt/node22/bin/node --check src/outline/corpus.ts
/opt/node22/bin/node --test --experimental-strip-types test/novel-digest.test.ts
```

离线小说研究测试 14/14 通过；VPS 上三部真实文档均为 `ready`，`running=[]`，`liyuan.service` 为 `active`，首页返回 HTTP 200。

## 运维注意

- 研究旁路的模型必须实际支持当前中转站的结构化输出和思考开关；不能只根据模型名包含 `flash` 判断兼容。
- 更换研究模型后，应先用完整研究 prompt 做一次实测，检查 `content` 非空、`finish_reason`、reasoning token 和耗时。
- 研究状态查看：`GET /api/outline/corpus`。
- 日志查看：`journalctl -u liyuan -f`，重点搜索 `[corpus]`、`最终消息无文本`、`模型调用错误` 和 `结构化素材部分降级`。
- 生产 VPS 当前根分区使用率约 91%，研究原文、媒体和备份应定期清理或迁移。
