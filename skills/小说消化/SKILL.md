---
name: 小说消化
description: 分块摘要小说文本并提炼剧情结构、人物弧线与叙事套路，不复刻原文。
workflow: novel-digest
resident: false
每轮: false
---

# 小说消化

你只负责消化研究材料，不为当前故事写剧情。输入是脱敏后的小说文本或其摘要层，
按 task 分工。所有输出只返回 JSON，不输出 Markdown 或 JSON 外文字。

## task: digest-map

输入：{ task, doc_title, chunk: { index, chapters, text } }
写出这一块的剧情摘要，≤1500 字。必须包含：
- 事件链：这块发生了什么（因果顺序，不是流水账）
- 人物动态：谁出场、动机与关系变化
- 悬置物：新抛出的悬念/伏笔/未回收的承诺（原样列出）
- 钩子：块末如何收（卡在哪、凭什么让读者往下翻）
禁止：评论文学质量；引用原文连续超过 40 字。
返回：{ "summary": string, "chapters": string[] }

## task: digest-reduce-arc

输入：{ task, doc_title, arc_title, chunk_summaries: string[] }
把这组块摘要归并成弧线摘要，≤2000 字：这段的主线推进、关键转折点（块定位）、
人物弧线走向、已回收/仍悬置的伏笔清单。返回：{ "summary": string }

## task: digest-reduce-final

输入：{ task, doc_title, arc_summaries: string[] }
产出全书级结论。返回：
{
  "synopsis": string,          // 全书梗概 ≤3000 字（按因果链写）
  "structure": {
    "plotSpine": string,       // 主线事件链：起爆点→升级→转折→高潮→收束
    "characterArcs": string,   // 主要人物弧线与关系演变阶段
    "hooksAndPacing": string   // 卡章钩子手法、爽点/松弛节奏规律
  }
}

## task: digest-extract-mechanisms

输入：{ task, doc_title, synopsis, structure, evidence_index: [{ id, kind, locator, summary }] }
提炼**可复用的叙事套路**，不是复述剧情。每条必须：
- mechanism：去掉作品专名后的可复用手法（桥段结构/信息分配/节奏手段/关系推进方式）
- appliesWhen：适用的人物动机、关系阶段、压力与前置条件
- failureWarning：这套手法用滥/用错会怎么翻车（OOC、拖节奏、伏笔崩）
- evidenceIds：只能填写 `evidence_index` 中真实存在、直接支撑该结论的 1–4 个 id。出处由系统根据 id 确定性生成，禁止自行填写章节或出处
禁止：输出原作专名、台词、标志性场景序列、完整反转、可识别的换皮方案；
不能从输入确认的内容不要编造。具体桥段机制必须至少引用一个 `chunk-*`；只有全书结构结论才可只引用 `arc-*`。最多 40 条，材料不足返回空数组。
返回：`{ "tropes": [{ "mechanism": string, "appliesWhen": string, "failureWarning": string, "evidenceIds": string[] }] }`

## task: digest-extract-daily

输入同上。提炼可直接落地的日常剧情结构，返回 `dailyPatterns`。每条必须有活动、角色主动目的、发糖点、低烈度冲突或误会、关系微变化和自然停点，并至少引用一个 `chunk-*`。字段：`title`、`setting`、`surfaceActivity`、`initiative`、`sweetBeat`、`friction`、`misunderstanding`、`microChange`、`escalationLimit`、`naturalStop`、`failureWarning`、`evidenceIds`。最多 20 条。
返回：`{ "dailyPatterns": [] }`

## task: digest-extract-assets

输入同上。提炼可调度中尺度素材，最多 30 条。`kind` 只允许 `scene-pattern|relationship-beat|dialogue-move`。字段：`kind`、`title`、`mechanism`、`appliesWhen`、`failureWarning`、`opening`、`progression`、`turn`、`stopPoint`、`relationshipStage`、`pressure`、`desiredExperience`、`evidenceIds`；至少引用一个 `chunk-*`。
返回：`{ "assets": [] }`

## task: digest-audit

输入：证据索引与待审计条目。逐条判断结论是否由其 evidenceIds 直接支持，是否把推测写成原作事实。`supported` 表示直接支持，`weak` 表示可作抽象灵感但证据不够强，`unsupported` 表示无关或编造。只返回：`{ "results": [{ "index": 0, "verdict": "supported|weak|unsupported", "reason": "简短理由" }] }`。
