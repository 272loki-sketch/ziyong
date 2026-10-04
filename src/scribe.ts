/**
 * 场记（scribe）：旁侧廉价模型——每轮结束后从正文抽取世界状态补丁（纯函数，零 pi 依赖）。
 *
 * 设计：记账从主演手里拿走（D10：产出是数据不是文字）。
 * 连续性/代打等事后审查已移除（费 token 且用户反馈无用）。
 */

import type { WorldState } from "./types.ts";
import { clipPromptText } from "./stage/prompt-budget.ts";

export interface ScribePromptInput {
	/** 当前世界状态（JSON 序列化前的对象） */
	state: WorldState;
	/** 本轮用户输入文本 */
	userText: string;
	/** 本轮助手正文（最终叙事文本） */
	assistantText: string;
	/** 主要角色名（账本规范名提示） */
	charName: string;
	/** 用户角色名 */
	userName: string;
	/** Deterministic character identity references from card/lorebook. */
	identityHints?: Record<string, string>;
	/**
	 * @deprecated 已不再做先斩后奏检测；保留字段以免旧调用方报错，忽略。
	 */
	detectUnaskedTurn?: boolean;
}

export interface ScribeResult {
	/** 状态补丁（applyPatch 语义），无变化为 {} */
	patch: Record<string, unknown>;
	/** 恒为空：连续性审查已关闭 */
	warnings: string[];
	/** 恒为 null：先斩后奏审查已关闭 */
	unaskedTurn: string | null;
}

export function buildScribeTurnPrompt(input: ScribePromptInput): { systemPrompt: string; userText: string } {
	const { state, userText, assistantText, charName, userName } = input;
	const knownCharacters = Object.keys(state.characters);
	const nameGuide = knownCharacters.length
		? `名字必须使用账本中已有的写法（当前已有：${knownCharacters.join("、")}；用户角色「${userName}」）`
		: `用户角色写作「${userName}」`;

	const identityText = Object.entries(input.identityHints ?? {}).map(([name, value]) => `- ${name}：${value}`).join("\n");
	const systemPrompt = `你是一场角色扮演的场记。阅读【当前账本】与【本轮对话】，只做一件事：输出 JSON，更新需要记账的持久变化。

输出唯一字段：
"patch"：从本轮对话中提取需要记账的持久变化。字段语义：
- "time" / "location"：字符串，整体替换。剧内时间推移（入夜、次日清晨、数日后）必须更新 time。若当前账本或本轮正文已有可确定的绝对日期，time 必须保留完整日期作为开头，再附叙事时段，例如“2015年4月7日（次日清晨）”或“星辉历102年长昼月7日（黄昏）”；无法唯一推出时不得猜造日期。
- "characters"：{ "名字": { "affinity"?, "status"?, "notes"? } }，按字段合并。affinity 为 -100..100 的对${userName}态度值，基于账本当前值小步调整（通常 ±1~10）。${nameGuide}；只有全新出场的人物才建新条目，键用正文中的人名——不要把作品/剧本标题（如「${charName}」这类非人名）当作角色。
- "inventory"：字符串数组，整体替换——只在物品归属变化时给出变化后的完整清单，条目注明归属（如「黄铜怀表（${userName}持有）」）。
- "flags"：键值对，按键合并（值为字符串）。
- "plot_threads"：字符串数组，整体替换——新增或了结剧情线时给出完整清单。
要点：否定性事件也要记账（赠礼被拒→物品仍在原主处；承诺被收回→记入 flags）；新的承诺、约定、伏笔进 plot_threads；没有变化的字段不要出现在 patch 中；完全无变化则 "patch" 为 {}。
只能记录本轮用户输入或助手定稿正文明确发生、明确观察到或明确说出的内容。导演候选、生态候选、原著参考、推测的幕后行动不能写入 patch。未知人物保持“未知/几个人”等原文粒度，不要自行命名、补职业或补组织；已有角色的身份以当前账本和角色卡资料为准，不得改写成未经证实的职业。

【人物身份基线】
${identityText || "（无额外身份基线）"}

人物身份基线优先于正文中由动作推测出的职业。若正文写某人端茶、叩门、巡夜等动作，不得因此把其身份改成女仆/侍女；只记录本轮动作，不重写身份。

只输出 JSON 对象，例如 {"patch":{...}} 或 {"patch":{}}。不要输出 warnings、不要输出其他文字。`;

	const user = `【当前账本】
${JSON.stringify(state, null, 2)}

【本轮对话】
${userName}：${clipPromptText(userText, 8_000)}

${charName}：${clipPromptText(assistantText, 30_000)}`;

	return { systemPrompt, userText: user };
}

/**
 * 宽容解析场记输出：剥代码围栏后，从头逐个候选尝试解析 JSON 对象
 * （模型常在最前写一句「以下是账本更新：」之类的前言——若前言里恰好有
 * 「{」，旧逻辑按首个 { 切分会从错位开始 → 整个解析失败。2026-08-03 实测）。
 * 解析失败返回 null（调用方静默跳过本轮）。
 */
export function parseScribeResult(text: string): ScribeResult | null {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) t = fence[1].trim();
	// 逐个「{」为起点试切：首个能完整解析出 patch 的对象即命中
	let idx = 0;
	while (true) {
		const start = t.indexOf("{", idx);
		if (start === -1) break;
		// 从候选起点向后找平衡的右括号（跳过字符串里的「}」）
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = start; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;
		try {
			const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
			if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.hasOwn(obj, "patch")) {
				const patch =
					obj.patch && typeof obj.patch === "object" && !Array.isArray(obj.patch)
						? (obj.patch as Record<string, unknown>)
						: {};
				// 审查字段一律丢弃（即使旧模型仍返回）
				return { patch, warnings: [], unaskedTurn: null };
			}
		} catch {
			// 本候选不成（前言里的孤 {），试下一个
		}
		idx = start + 1;
	}
	return null;
}

// ---------- 世界书中文别名（修复：专有名词中译后英文关键词地板失效） ----------

export interface AliasEntryInput {
	uid: number;
	keys: string[];
	comment: string;
	/** 正文摘录（截断后），供理解条目指代什么 */
	excerpt: string;
}

export function buildLoreAliasPrompt(
	entries: AliasEntryInput[],
	language: string,
): { systemPrompt: string; userText: string } {
	const systemPrompt = `你为角色扮演世界书条目生成${language}检索别名。这些别名用于在${language}叙事文本中做关键词匹配，因此要覆盖该事物在${language}叙事中最可能被写出的称呼：常见意译、音译、职称（每条目 2~5 个，单个别名 2~6 字为宜）。不要生成过于宽泛的词（如「建筑」「怪物」这类单独出现会误触发的通用词，除非条目本身就是该范畴）。
只输出 JSON 对象：{ "<uid>": ["别名1", "别名2", ...], ... }，不要输出任何其他文字。`;

	const userText = entries
		.map((e) => `uid=${e.uid} keys=[${e.keys.join(", ")}] 标题=${e.comment || "（无）"}\n摘要：${e.excerpt}`)
		.join("\n\n");

	return { systemPrompt, userText };
}

/** 解析别名输出：{ uid: string[] }；解析失败返回 null */
export function parseLoreAliases(text: string): Map<number, string[]> | null {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) t = fence[1].trim();
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
		const map = new Map<number, string[]>();
		for (const [k, v] of Object.entries(obj)) {
			const uid = Number(k);
			if (!Number.isFinite(uid) || !Array.isArray(v)) continue;
			const aliases = v.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim());
			if (aliases.length) map.set(uid, aliases);
		}
		return map;
	} catch {
		return null;
	}
}

// ---------- 前情接力摘要（原 src/compaction.ts，2026-08-02 随 harness 重做移入） ----------
// PLAN-RP-MEMORY：升级为数据库（pi harness）式两段范式——初建 / 增量各一套固定结构提示词，
// 增量显式「PRESERVE 旧有效信息 / ADD 新事件 / UPDATE 状态 / MOVE 已兑现 → 结果」。

export interface RpSummaryPromptInput {
	/** 被裁早期剧情的对话原文（序列化后） */
	conversationText: string;
	/** 工具账本快照（辅助参考，可能滞后于正文） */
	stateSnapshot: string;
	/** 更早剧情的既有摘要（二次压缩时传入，合并进本次摘要） */
	previousSummary?: string;
	/** 主演角色名（规范名提示） */
	charName?: string;
	language: string;
	userName: string;
}

export interface RpSummaryPrompt {
	systemPrompt: string;
	userText: string;
}

/**
 * 摘要结构校验。新生成摘要必须可证明是「合理摘要」才会被提交为第二套事实权威：
 * - 含 `## Story Phase` → 必须是完整 10 节（v2 strict）；
 * - 纯 Markdown 旧摘要 → 至少 3 个标题，否则视为垃圾/截断/报错文本拒绝提交；
 * - requireStructured（本次压缩返回了 v2 envelope）→ 缺失 Story Phase 直接拒绝。
 */
export function validateRpSummaryMarkdown(summary: string, opts?: { requireStructured?: boolean }): { ok: boolean; errors: string[] } {
	const text = summary.trim();
	if (!text) return { ok: false, errors: ["空摘要"] };
	if (text.includes("## Story Phase")) {
		const required = ["## Story Phase", "## Story Progress", "## Characters", "## Core Events", "## Promises & Threads", "## Canon Facts", "## Knowledge Boundaries", "## Compression Boundary", "## Current Continuity", "## Recall Index"];
		const errors = required.filter((section) => !text.includes(section)).map((section) => `缺少 ${section}`);
		return { ok: errors.length === 0, errors };
	}
	if (opts?.requireStructured) {
		return { ok: false, errors: ["缺失 ## Story Phase（v2 envelope 的 summaryMarkdown 必须含全部 10 节）"] };
	}
	const headings = text.match(/^#{1,6}\s+\S.*$/gm) ?? [];
	if (headings.length < 3) {
		return { ok: false, errors: ["摘要缺乏结构（标题数不足），疑似截断/报错/无格式文本，拒绝提交"] };
	}
	return { ok: true, errors: [] };
}

/** 长期故事纪要 v2 的固定输出结构（两部分共用） */
export const RP_SUMMARY_SECTIONS = [
	"## Story Phase",
	"当前故事阶段 / 阶段目标 / 阶段起点",
	"## Story Progress",
	"时间序重大推进：谁做了什么 → 结果 → 改变哪条剧情/关系线",
	"## Characters",
	"核心人物：当前状态 / 对主要人物关系 / 关系演变轨迹 / 称呼习惯",
	"## Core Events",
	"核心事件稳定 id 列表（event_first_meeting_001 等，不重复写全文）",
	"## Promises & Threads",
	"未兑现承诺 / 未解决误会 / 未揭露真相 / 活跃伏笔",
	"## Canon Facts",
	"已确认时间线 / 物品归属 / 伤势与身体状态 / 身份 / 重要数值",
	"## Knowledge Boundaries",
	"谁知道什么 / 谁不知道什么 / 不得泄露的后台秘密",
	"## Compression Boundary",
	"被压缩区间结束时的时间/时段/地点/在场人物/正在进行的动作；这是早期摘要的边界，不要把它误写成保留区的当前续演点",
	"## Current Continuity",
	"当前续演点只在有明确最新分支状态时填写；否则写‘由最近保留正文与 rp-state 提供’，不得用压缩区间旧场景冒充当前现场",
	"## Recall Index",
	"历史回照措辞 → 对应事件 id（如「那把伞」「第一次见面」「当年」→ event_first_meeting_001）",
].join("\n");

/** 初建：从零生成固定结构长期纪要 */
export function buildRpSummaryInitialPrompt(
	input: Omit<RpSummaryPromptInput, "previousSummary">,
): RpSummaryPrompt {
	const { conversationText, stateSnapshot, language, userName } = input;
const systemPrompt = `你是一场长篇角色扮演的场记。你的任务是为即将从上下文中裁掉的早期剧情写一份**接力摘要 v2**——它是主演模型唯一能看到的「前情」，后续剧情基于「本摘要 + 保留的最近对话」继续演出。

用${language}输出，**严格按以下固定结构**：

${RP_SUMMARY_SECTIONS}

规则：
- 只记录对话中实际发生的事；不虚构、不评论、不续写剧情；
- 人名地名保持剧中写法；${userName} 是用户角色名；${input.charName ?? ""}
- 不确定的细节不补写；归入 Canon Facts 的必须是已确认事实；
- Core Events 只列本次 events 中的 sourceKey；Recall Index 也使用同一 sourceKey；最终 canonical event id 由代码生成。
- 输出必须是一个 JSON 对象：{"version":2,"summaryMarkdown":"完整 Markdown 摘要","events":[]}。
- summaryMarkdown 的值必须是完整 Markdown 摘要；events 是从本次正文提取的高价值事件卡。不要输出 JSON 之外的文字。`;

	const userText = `<conversation>\n${conversationText}\n</conversation>\n\n【工具账本快照】（辅助参考；记账可能滞后于正文，与对话记录冲突时以对话记录为准）\n${stateSnapshot}\n\n请按系统指令输出接力摘要 v2。`;
	return { systemPrompt, userText };
}

/** 增量：把新剧情并入旧纪要（对齐数据库 UPDATE_SUMMARIZATION_PROMPT） */
export function buildRpSummaryUpdatePrompt(
	input: RpSummaryPromptInput & { newEvents?: string },
): RpSummaryPrompt {
	const { conversationText, stateSnapshot, previousSummary, language, userName, newEvents } = input;
const systemPrompt = `你是一场长篇角色扮演的场记。你负责把**新剧情**并入**已有的接力摘要 v2**，供后续剧情依旧基于「更新后的摘要 + 保留的最近对话」继续演出。

用${language}输出，**严格沿用已有摘要的固定结构**（缺节则按结构补齐）：
${RP_SUMMARY_SECTIONS}

更新规则：
- PRESERVE 旧摘要中仍有效的信息（已确立的人物、关系、事件 id、承诺、事实账）；
- ADD 新剧情里发生的事件、关系变化、新事实（重大推进记入 Story Progress；值得长期回照的进 Core Events；回照措辞进 Recall Index）；
	- UPDATE Story Phase / Characters / Compression Boundary——Compression Boundary 必须对应被压缩区间的末端；真正当前续演点由保留的最近正文与当前 rp-state 提供；
- MOVE 已兑现的承诺 / 已解决的误会从 Promises & Threads 移到历史结果说明，不丢事件 id；
- REMOVE 已不再相关且低价值的细节；
- PRESERVE 人物姓名写法、物品名、事件 id、Recall Index、后台秘密边界；
- 不确定候选不得升级为事实；无足够证据的细节不补写；
- 只记录对话中实际发生的事；不虚构、不评论、不续写剧情。
- 摘要总长度以约 2500 个中文字符为目标；优先保留主线因果、关系演变、承诺与知识边界，删除低价值重复细节。
- Core Events 与 Recall Index 只能引用已有或本次 envelope events 中的稳定 event id/sourceKey，不得凭空制造不存在的事件编号。
- 输出必须是一个 JSON 对象：{"version":2,"summaryMarkdown":"完整 Markdown 摘要","events":[]}，不要输出其他文字。
- events 中已有事件使用原有 sourceKey；新事件必须使用稳定的 sourceKey，不要自行生成会与其他数据源冲突的随机 id。`;

	const parts = [`<new-conversation>\n${conversationText}\n</new-conversation>`];
	if (previousSummary) {
		parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
	}
	if (newEvents) {
		parts.push(`<new-events>\n${newEvents}\n</new-events>`);
	}
	parts.push(`【工具账本快照】（辅助参考；记账可能滞后于正文，与对话记录冲突时以对话记录为准）\n${stateSnapshot}`);
	parts.push("请按系统指令输出**更新后**的接力摘要 v2（合并旧内容 + 新剧情）。");

	return { systemPrompt, userText: parts.join("\n\n") };
}

/**
 * 装配提示词（兼容旧调用）：有 previousSummary 走增量，否则走初建。
 * 被裁剧情原文一律丢给归档 side（不在此合并），这里专注纪要权威。
 */
export function buildRpSummaryPrompt(input: RpSummaryPromptInput): RpSummaryPrompt {
	if (input.previousSummary) {
		return buildRpSummaryUpdatePrompt(input);
	}
	return buildRpSummaryInitialPrompt(input);
}
