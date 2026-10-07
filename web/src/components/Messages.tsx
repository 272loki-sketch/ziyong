/**
 * 聊天区消息渲染：ST 式文档流（名字行 + 正文，无左右对齐）+ 过程条。
 *
 * D10 显示层纪律：narrative/thinking 文本原样呈现，排版（*动作*斜体、"对白"着色）
 * 只是 CSS 级装饰，不改写任何字符；前端绝不生成正文。
 * 过程条是元信息层（agent 工作过程），与正文明确区隔。
 */

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { attachmentUrl, splitAttachments } from "../attachments.ts";
import { applyCardSkin } from "../cardSkin.ts";
import { isFullInterface } from "../htmlEmbed.ts";
import { splitRichContentParts, stripProjectedFormats, type SkinMacros } from "../richContentParts.ts";
import { splitMarkdownParts, splitRpInline } from "../markdown.ts";
import type { WireActivity, WireBeatWorkflow, WireTurnPerformance, WireChoice, WireMsg } from "../wire.ts";
import type { LiteraryWorldState } from "../../../src/stage/literary-world.ts";
import type { WorldAuditWireView } from "../../../src/stage/literary-world-transition.ts";
import type { ModularWorldWireView } from "../../../src/stage/literary-world-modular.ts";
import type { CalendarMonthView, CalendarView, PresentationView, TavernVariablesView } from "../../../src/presentation.ts";
import { serializeCalendarSource } from "../../../src/presentation.ts";
import type { EcologyWireView } from "../../../src/stage/literary-ecology.ts";
import { estimateTokens, formatTokenCount, type TurnSegment } from "../timeline.ts";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { generationStageLabel, generationStageStatusPresentation } from "../generation-workflow-ui.ts";

/** 一档卡皮肤：显示向规则 + 宏名（Task 7 由 App 注入） */
export type SkinProp = SkinMacros;
/** A record preview may read saved media but must never start generation. Normal chat defaults unchanged. */
export const ReadOnlyMessagesContext = createContext(false);
type GenerationWorkflow = NonNullable<WireMsg["generationWorkflow"]>;
import {
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
	IconEdit,
	IconPin,
	IconRedo,
	IconSpeaker,
	IconTrash,
	IconUndo,
} from "./icons.tsx";

/** 点击页内放大的图片（lightbox）：点图开遮罩、点遮罩或 Esc 关闭；不跳新窗口 */
export function ZoomImg({ src, alt, title }: { src: string; alt: string; title?: string }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);
	return (
		<>
			<img src={src} alt={alt} title={title} loading="lazy" className="zoomable" onClick={() => setOpen(true)} />
			{open && (
				<div className="lightbox" onClick={() => setOpen(false)}>
					<img src={src} alt={alt} />
				</div>
			)}
		</>
	);
}

let novelAiQueue: Promise<void> = Promise.resolve();
let novelAiLastStartedAt = 0;
const NOVELAI_MIN_START_GAP_MS = 10_000;

function enqueueNovelAi<T>(task: () => Promise<T>): Promise<T> {
	const run = novelAiQueue.then(async () => {
		const wait = Math.max(0, NOVELAI_MIN_START_GAP_MS - (Date.now() - novelAiLastStartedAt));
		if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
		novelAiLastStartedAt = Date.now();
		return task();
	});
	novelAiQueue = run.then(() => undefined, () => undefined);
	return run;
}

function NovelAiImageButton({ prompt, title }: { prompt: string; title: string }) {
	const readOnly = useContext(ReadOnlyMessagesContext);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [src, setSrc] = useState("");
	const running = useRef(false);
	const browserCacheKey = `liyuan:nai:${prompt.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()}`;
	const readBrowserCache = () => { try { return window.localStorage.getItem(browserCacheKey) || ""; } catch { return ""; } };
	const writeBrowserCache = (value: string) => { try { window.localStorage.setItem(browserCacheKey, value); } catch { /* storage may be disabled */ } };
	const generate = async () => {
		if (readOnly || running.current) return;
		running.current = true;
		setBusy(true);
		setError("");
		try {
			const result = await enqueueNovelAi(() => apiPost<{ src: string }>("/api/novelai/generate", { prompt, caption: title }));
			writeBrowserCache(result.src);
			setSrc(result.src);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			running.current = false;
			setBusy(false);
		}
	};
	useEffect(() => {
		let alive = true;
		const browserSrc = readBrowserCache();
		if (browserSrc) { setSrc(browserSrc); return () => { alive = false; }; }
		void apiGet<{ src: string | null }>(`/api/novelai/cached?prompt=${encodeURIComponent(prompt)}`, { bypassCache: true })
			.then((result) => { if (alive && result.src) { if (!readOnly) writeBrowserCache(result.src); setSrc(result.src); } else if (alive && !readOnly) void generate(); })
			.catch(() => { if (alive && !readOnly) void generate(); });
		// 自动生图只在该图片槽首次挂载时排队一次；generate 内部 running 防重入。
		// eslint-disable-next-line react-hooks/exhaustive-deps
		return () => { alive = false; };
	}, [prompt, readOnly]);
	return (
		<div className="nai-image-slot">
			{src ? <ZoomImg src={src} alt={title} title={title} /> : readOnly ? <div className="nai-readonly-note"><strong>插图位置 · {title}</strong><p>此记录未保存实际图片；只读查看不会触发生图。</p><details><summary>查看本处绘图提示词</summary><pre>{prompt}</pre></details></div> : <button type="button" className="nai-generate-btn" disabled={busy} onClick={generate}>{busy ? "NovelAI 生图中…" : `生成图片 · ${title}`}</button>}
			{error && <div className="nai-image-error">{error}</div>}
		</div>
	);
}

/** 本地消息：wire 消息 + 客户端挂载的当轮过程活动（v0 不持久化，刷新即失） */
export interface ChatMsg extends WireMsg {
	activities?: WireActivity[];
	/**
	 * 回合时间线（思考/工具/正文按发生顺序）。存在时取代 thinking+activities+text
	 * 的三分区渲染；历史重放/旧消息无此字段，走 segmentsFromLegacy 兜底。
	 * 与 activities 同样是客户端态，不持久化。
	 */
	segments?: TurnSegment[];
}

export const TOOL_LABELS: Record<string, string> = {
	lorebook_search: "检索设定",
	world_state_get: "核对账本",
	world_state_update: "记下变化",
	lorebook_write: "固化设定",
	codex_create: "建知识库",
	codex_mount: "挂知识库",
	codex_unmount: "卸知识库",
	codex_write: "写入知识库",
	show_image: "展示插图",
	show_audio: "展示音频",
	show_video: "展示视频",
	show_html: "嵌入界面",
	tts: "配音",
	skill_save: "沉淀技能",
	panel_write: "更新面板",
	panel_read: "查看面板",
	panel_close: "收起面板",
	ask_director: "请你定夺",
	assistant_run: "委托助手",
	bash: "执行命令",
	read: "查阅",
	write: "写入",
	edit: "改写",
	grep: "检索文件",
	find: "查找文件",
	ls: "列目录",
};

export const toolLabel = (name: string) => {
	if (TOOL_LABELS[name]) return TOOL_LABELS[name];
	// MCP：mcp__server__tool → MCP · tool
	if (name.startsWith("mcp__")) {
		const rest = name.slice("mcp__".length);
		const i = rest.indexOf("__");
		const tool = i >= 0 ? rest.slice(i + 2) : rest;
		return tool ? `MCP · ${tool}` : name;
	}
	return name;
};

/** 原始 JSON 参数不应出现在过程条主文案里 */
function looksLikeRawArgs(detail: string): boolean {
	const t = detail.trim();
	if (!t) return false;
	return (t.startsWith("{") || t.startsWith("[")) && /"\w+"\s*:/.test(t);
}

/** RP 排版：**粗体**、*动作*斜体、"对白"/“对白”/「对白」着色。纯呈现，切分归 splitRpInline。 */
function renderRp(text: string) {
	return splitRpInline(text).map((t, i) => {
		if (t.kind === "strong") return <strong key={i}>{t.text}</strong>;
		if (t.kind === "em") return <em key={i}>{t.text}</em>;
		if (t.kind === "quote") return <span key={i} className="q">{t.text}</span>;
		return <span key={i}>{t.text}</span>;
	});
}

/** 纯文本段：空行分段 + 行内 RP 装饰 */
function TextBlocks({ text }: { text: string }) {
	const t = text.replace(/^\n+/, "").replace(/\n+$/, "");
	if (!t) return null;
	return (
		<>
			{t.split(/\n{2,}/).map((para, i) => (
				<p key={i}>
					{para.split("\n").map((line, j, arr) => (
						<span key={j}>
							{renderRp(line)}
							{j < arr.length - 1 && <br />}
						</span>
					))}
				</p>
			))}
		</>
	);
}

/**
 * 正文段落：先切 markdown 围栏代码块（Options 等与正文区分），再 RP 排版。
 * 代码块不显示围栏字符，浅底预格式，对齐酒馆 markdown 观感。
 * 表格/选项列表来自 splitMarkdownParts 的二次细分（纯预设「角色表」「他人推动」等）。
 */
export const Paragraphs = memo(function Paragraphs({ text }: { text: string }) {
	const parts = splitMarkdownParts(text);
	return (
		<>
			{parts.map((p, i) => {
				if (p.kind === "code") {
					return (
						<pre key={i} className="msg-md-code" data-lang={p.lang || undefined}>
							<code>{p.code}</code>
						</pre>
					);
				}
				if (p.kind === "table") {
					return (
						<div key={i} className="msg-md-tablewrap">
							<table className="msg-md-table">
								<thead>
									<tr>
										{p.header.map((h, j) => (
											<th key={j}>{renderRp(h)}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{p.rows.map((row, j) => (
										<tr key={j}>
											{row.map((cell, k) => (
												<td key={k}>{renderRp(cell)}</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				}
				if (p.kind === "blockquote") {
					return (
						<blockquote key={i} className="msg-md-quote">
							{p.lines.map((line, j, arr) => (
								<span key={j}>
									{renderRp(line)}
									{j < arr.length - 1 && <br />}
								</span>
							))}
						</blockquote>
					);
				}
				if (p.kind === "options") {
					return (
						<ul key={i} className="msg-options">
							{p.items.map((it) => (
								<li key={it.key}>
									<span className="msg-option-key">{it.key}</span>
									<span className="msg-option-text">{renderRp(it.text)}</span>
								</li>
							))}
						</ul>
					);
				}
				return <TextBlocks key={i} text={p.text} />;
			})}
		</>
	);
});

/**
 * 正文渲染（真路径 = splitRichContentParts）：
 * 作者正则皮肤 → HTML 块（seamless 帧）→ 其余 RP 排版。
 * 状态栏是作者正则产出的 HTML，走 html 分支；梨园不再按标签名抠「统一状态卡」。
 */
export const RichContent = memo(function RichContent({ text, skin, collapsibleHtml = false, htmlTitle, variables }: { text: string; skin?: SkinProp | null; collapsibleHtml?: boolean; htmlTitle?: string; variables?: TavernVariablesView }) {
	const parts = splitRichContentParts(text, skin);
	const first = parts[0];
	if (parts.length === 1 && first.kind === "text") {
		return <Paragraphs text={first.text} />;
	}
	return (
		<>
			{parts.map((p, i) => {
				if (p.kind === "imagePrompt") return <NovelAiImageButton key={i} prompt={p.prompt} title={p.title} />;
				// 皮肤/正文内嵌 HTML：无痕 seamless；agent show_html 通道不经此路径
				if (p.kind === "html") {
					const isBbs = /post-container|Small_theater-wrapper|校园BBS/i.test(p.html);
					return <HtmlFrame key={i} html={p.html} scripts={p.scripts} seamless title={htmlTitle || (isBbs ? "校园BBS" : undefined)} collapsible={collapsibleHtml || isBbs} variables={variables} />;
				}
				if (p.kind === "text" && p.text.trim()) return <Paragraphs key={i} text={p.text} />;
				return null;
			})}
		</>
	);
});

/**
 * 模型思维链：**默认折叠**，摘要只给「思考中…／已思考 · 12K tokens」。
 *
 * 思考是过程不是成品——展开态会把正文挤到屏外，最终态该干净。
 * 生成中也不自动展开（旧行为 live=true 强制 open）：想看的人点开，
 * 折叠态的 token 数已经说明它在动。defaultOpen 只留给中断残稿
 * （正文未流出时思维链是唯一线索）。
 */
export const ThinkingBlock = memo(function ThinkingBlock({ text, live, defaultOpen }: { text: string; live?: boolean; defaultOpen?: boolean }) {
	const tokens = formatTokenCount(estimateTokens(text));
	return (
		<details className="thinking" open={defaultOpen ? true : undefined}>
			<summary className={live ? "pulse" : undefined}>
				<span className="thinking-label">{live ? "思考中" : "已思考"}</span>
				{text.trim() && <span className="thinking-count">{tokens} tokens</span>}
			</summary>
			<div className="thinking-body">
				<Paragraphs text={text} />
			</div>
		</details>
	);
});

/**
 * 一段工具步骤（时间线内联）：连续调用聚成一组，默认折叠成一行摘要。
 * 与 ActivityBar 的差别是它按发生位置**内联**在思考与正文之间，
 * 而不是整轮收尾时挂在末端。
 */
export function ToolSegment({ activities, live }: { activities: WireActivity[]; live?: boolean }) {
	const calls = activities.filter((a) => a.kind === "tool_start");
	const names = [...new Set(calls.map((a) => toolLabel(a.name)))];
	const summary = names.length === 0 ? "过程" : names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} 等 ${names.length} 项`;
	return (
		<details className="turn-activity turn-activity-inline">
			<summary className={live ? "pulse" : undefined}>
				{summary}
				{calls.length > 1 && ` · ${calls.length} 步`}
			</summary>
			<ul>
				{activities.map((a, i) => (
					<ActivityItem key={i} a={a} />
				))}
			</ul>
		</details>
	);
}

/**
 * 回合时间线渲染（8/09 两层折叠）：
 *
 * **定稿态（live=false）**——成品优先：正文段（稿段+尾巴）连续平铺，全部思考与
 * 工具段收进末尾**一个**「本轮历程」折叠（第二层汇总折叠）。过程不删除——点开
 * 历程按原时序看完整思考与调用；历程内思考默认展开（用户点开历程就是要读它）。
 * 旧的按时序平铺会把正文切碎——续写段与前一段之间隔着 ask/重拟/思考一长串。
 *
 * **扮演中（live=true）**——跟读优先：正文段平铺（故事在长），正文之间连续的
 * 思考/工具段聚成「扮演中」折叠组（第一层），只占一行、轮次间距收紧；最新一组
 * 默认展开（正在动的过程可跟读），出新正文段后自动收起。
 */
export function TurnTimeline({
	segments,
	skin,
	variables,
	live,
}: {
	segments: TurnSegment[];
	skin?: SkinProp | null;
	variables?: TavernVariablesView;
	/** 展示选项点击后写入主输入框（不自动发送）。 */
	onSelectOption?: (text: string) => void;
	live?: boolean;
}) {
	const countOf = (segs: TurnSegment[]) => {
		const thinks = segs.filter((s) => s.kind === "thinking").length;
		const calls = segs.reduce(
			(n, s) => (s.kind === "tool" ? n + s.activities.filter((a) => a.kind === "tool_start").length : n),
			0,
		);
		return { thinks, calls };
	};

	if (!live) {
		// 工件时间线可能同时保留旧谢幕和最新 override；同一段正文与格式在 msg.text
		// 已合并为权威展示，因此定稿态只渲染最后一份格式段由 Bubble 单独补齐。
		const texts = segments.filter((s) => s.kind === "text");
		const process = segments.filter((s) => s.kind !== "text");
		const { thinks, calls } = countOf(process);
		return (
			<>
				{texts.map((seg, i) => (
					<RichContent key={i} text={(seg as Extract<TurnSegment, { kind: "text" }>).text} skin={skin} variables={variables} />
				))}
				{process.length > 0 && (
					<details className="turn-process">
						<summary>
							本轮历程
							{thinks > 0 && ` · 思考 ${thinks} 段`}
							{calls > 0 && ` · ${calls} 步`}
						</summary>
						<div className="turn-process-body">
							{segments.map((seg, i) => {
								if (seg.kind === "thinking") return <ThinkingBlock key={i} text={seg.text} defaultOpen />;
								if (seg.kind === "tool") return <ToolSegment key={i} activities={seg.activities} />;
								return null; // 正文已平铺在外，历程里不重复
							})}
						</div>
					</details>
				)}
			</>
		);
	}

	// 扮演中：正文之间的连续过程段聚组
	type Group = { kind: "text"; seg: Extract<TurnSegment, { kind: "text" }> } | { kind: "process"; segs: TurnSegment[] };
	const groups: Group[] = [];
	for (const seg of segments) {
		if (seg.kind === "text") groups.push({ kind: "text", seg });
		else {
			const last = groups[groups.length - 1];
			if (last && last.kind === "process") last.segs.push(seg);
			else groups.push({ kind: "process", segs: [seg] });
		}
	}
	return (
		<>
			{groups.map((g, gi) => {
				if (g.kind === "text") return <RichContent key={gi} text={g.seg.text} skin={skin} variables={variables} />;
				const active = gi === groups.length - 1; // 最新过程组=正在动的，展开跟读
				const { thinks, calls } = countOf(g.segs);
				return (
					<details key={gi} className="turn-process turn-process-live" open={active ? true : undefined}>
						<summary className={active ? "pulse" : undefined}>
							{active ? "扮演中" : "过程"}
							{thinks > 0 && ` · 思考 ${thinks} 段`}
							{calls > 0 && ` · ${calls} 步`}
						</summary>
						<div className="turn-process-body">
							{g.segs.map((seg, i) => {
								const isLast = active && i === g.segs.length - 1;
								if (seg.kind === "thinking") return <ThinkingBlock key={i} text={seg.text} live={isLast} />;
								if (seg.kind === "tool") return <ToolSegment key={i} activities={seg.activities} live={isLast} />;
								return null;
							})}
						</div>
					</details>
				);
			})}
		</>
	);
}

/** 过程条单项：旁白优先；工具步骤用中文标签 + 人话 detail（藏 JSON） */
function ActivityItem({ a }: { a: WireActivity }) {
	if (a.kind === "note") {
		return <li className="ta-note">{a.detail}</li>;
	}
	if (a.kind === "tool_start") {
		const label = toolLabel(a.name);
		const detail = (a.detail ?? "").trim();
		const human = detail && !looksLikeRawArgs(detail) ? detail : "";
		return (
			<li className="ta-call">
				<span className="ta-label">{label}</span>
				{human ? <span className="ta-detail">{human}</span> : <span className="ta-detail ta-detail-muted">进行中…</span>}
			</li>
		);
	}
	const detail = (a.detail ?? "").trim();
	const human = detail && !looksLikeRawArgs(detail) ? detail : "";
	return (
		<li className={`ta-result ${a.isError ? "ta-error" : ""}`}>
			<span className="ta-label">{a.isError ? "未办成" : "已办完"}</span>
			{human ? <span className="ta-detail">{human}</span> : null}
		</li>
	);
}

/** 过程条（收尾态）：整轮步骤收进一个折叠（codex 式过程-成品分离，成品平铺在外） */
export function ActivityBar({ activities }: { activities: WireActivity[] }) {
	if (activities.length === 0) return null;
	const steps = activities.filter((a) => a.kind === "tool_start" || a.kind === "note").length;
	return (
		<details className="turn-activity">
			<summary>
				过程
				{steps > 0 && ` · ${steps} 步`}
			</summary>
			<ul>
				{activities.map((a, i) => (
					<ActivityItem key={i} a={a} />
				))}
			</ul>
		</details>
	);
}

/** 过程清单（进行中态）：每一步实时追加、全程平铺可见；定稿后由 ActivityBar 收进折叠 */
export function LiveSteps({ activities }: { activities: WireActivity[] }) {
	if (activities.length === 0) return null;
	return (
		<ul className="live-steps">
			{activities.map((a, i) => (
				<ActivityItem key={i} a={a} />
			))}
		</ul>
	);
}

/** 戏外中间步骤（正文+活动，折叠区内使用） */
function BackstageStep({ msg }: { msg: ChatMsg }) {
	return (
		<div className="bs-step">
			{msg.thinking && <ThinkingBlock text={msg.thinking} />}
			<RichContent text={msg.text} />
			{msg.activities && msg.activities.length > 0 && <ActivityBar activities={msg.activities} />}
		</div>
	);
}

/**
 * 戏外轮分组（codex 式过程-成品分离，2026-07-10 用户定调）：
 * 同一轮的中间步骤全部折进「过程」，只露最终报告；最终报告本身可折叠——
 * 最新一轮默认展开，翻历史时旧轮默认收起。
 */
export function BackstageGroup({
	msgs,
	fallbackName,
	open,
	avatarUrl,
}: {
	msgs: ChatMsg[];
	fallbackName: string;
	open: boolean;
	avatarUrl?: string | null;
}) {
	const final = msgs[msgs.length - 1];
	const mid = msgs.slice(0, -1);
	const toolCount = msgs.reduce((n, m) => n + (m.activities?.filter((a) => a.kind === "tool_start").length ?? 0), 0);
	const name = final.name || fallbackName;
	const generationWorkflow = final.generationWorkflow;
	const generationMode = final.generationMode ?? generationWorkflow?.mode;
	return (
		<div className="msg msg-backstage">
			<div className="msg-head">
				<MsgAvatar src={avatarUrl} name={name} kind="char" />
				<span className="msg-name">{name}</span>
				{generationMode && <span className={`chip generation-mode-badge ${generationMode}`}>{generationMode === "direct" ? "直出" : "导演流程"}</span>}
				<span className="chip chip-backstage">助手</span>
			</div>
			{mid.length > 0 && (
				<details className="turn-activity">
					<summary>
						过程 · 中间步骤 ×{mid.length}
						{toolCount > 0 && ` · 工具调用 ×${toolCount}`}
					</summary>
					{mid.map((m, i) => (
						<BackstageStep key={i} msg={m} />
				))}
				</details>
			)}
			{generationWorkflow && <GenerationWorkflowCard workflow={generationWorkflow} />}
			{msgs.some(m=>m.modelDiagnostics?.length) ? <ModelDiagnosticsCard calls={msgs.flatMap(m=>m.modelDiagnostics??[])} /> : null}
			<details className="bs-final" open={open}>
				<summary>{open ? "回复" : `回复：${firstLine(final.text)}`}</summary>
				{final.thinking && <ThinkingBlock text={final.thinking} />}
				<RichContent text={final.text} />
				{final.activities && final.activities.length > 0 && <ActivityBar activities={final.activities} />}
			</details>
		</div>
	);
}

const firstLine = (text: string) => {
	const line = text.split("\n").find((l) => l.trim()) ?? "";
	return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

/**
 * 剧情决策选择卡（Phase 4 柱 1）。两种形态同一组件：
 * - live（onReply 传入且未决）：可点选项、自由输入、停止；
 * - 留痕（choice.answer / choice.stopped，或无 onReply）：置灰只读，标注结果。
 * D10 合规：选择卡是"事前参与"的创作决策界面，不是正文——岔路口本身也是剧情资产。
 */
export function ChoiceCard({ choice, onReply }: { choice: WireChoice; onReply?: (r: { value?: string; stop?: boolean }) => void }) {
	const [custom, setCustom] = useState("");
	const resolved = choice.answer !== undefined || choice.stopped === true;
	const live = !!onReply && !resolved;

	return (
		<div className={`choice-card ${resolved ? "choice-done" : ""}`}>
			<div className="choice-q">{choice.question}</div>
			{choice.options.length > 0 && (
				<div className="choice-options">
					{choice.options.map((opt, i) => {
						const picked = choice.answer === opt;
						return (
							<button
								key={i}
								className={`choice-opt ${picked ? "picked" : ""}`}
								disabled={!live}
								onClick={live ? () => onReply?.({ value: opt }) : undefined}
							>
								<span className="choice-idx">{i + 1}</span>
								{opt}
							</button>
						);
					})}
				</div>
			)}
			{live ? (
				<div className="choice-custom">
					<input
						type="text"
						value={custom}
						placeholder={choice.placeholder ?? "或自己写一个…"}
						onChange={(e) => setCustom(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing && custom.trim()) {
								e.preventDefault();
								onReply?.({ value: custom.trim() });
							}
						}}
					/>
					<button className="choice-send" disabled={!custom.trim()} onClick={() => onReply?.({ value: custom.trim() })}>
						提交
					</button>
					<button className="choice-stop" onClick={() => onReply?.({ stop: true })} title="停止本回合，收回主导权">
						停止
					</button>
				</div>
			) : (
				<div className="choice-result">
					{choice.stopped ? (
						<span className="choice-stopped">已停止本回合</span>
					) : choice.answer !== undefined && !choice.options.includes(choice.answer) ? (
						<span className="choice-answered">你的回答：{choice.answer}</span>
					) : choice.answer !== undefined ? (
						<span className="choice-answered">已选择</span>
					) : (
						<span className="choice-answered">已应答</span>
					)}
				</div>
			)}
		</div>
	);
}

/** 消息头像：有图用图，否则字首圆形 */
export function MsgAvatar({
	src,
	name,
	kind = "char",
}: {
	src?: string | null;
	name: string;
	kind?: "user" | "char";
}) {
	const letter = (name || "？").trim().slice(0, 1) || "？";
	if (src) {
		return (
			<span className={`msg-avatar msg-avatar-${kind} has-img`} aria-hidden="true">
				<img src={src} alt="" />
			</span>
		);
	}
	return (
		<span className={`msg-avatar msg-avatar-${kind}`} aria-hidden="true">
			{letter}
		</span>
	);
}

export interface BubbleEditState {
	draft: string;
	/** 用户改稿后点「重新生成」；agent 改稿后点「重新生成」= 采用改写 / 再生成 */
	onChange: (v: string) => void;
	onCancel: () => void;
	onSubmit: () => void;
	/** 提交按钮文案旁注 */
	submitLabel?: string;
}

/** ST 式回复变体：左右箭头；在末条点右 = 再生成（保留旧变体） */
export interface BubbleSwipe {
	index: number;
	total: number;
	onPrev: () => void;
	onNext: () => void;
}

export interface BubbleProps {
	msg: ChatMsg;
	floor?: number;
	fallbackName: string;
	/** 角色卡立绘 / 用户身份头像 URL */
	avatarUrl?: string | null;
	/** 尾部操作 */
	onReroll?: () => void;
	onCurtainReroll?: () => void;
	onEdit?: () => void;
	/** 回退到本条之前（含本条之后的剧情） */
	onRewind?: () => void;
	/** 删除本轮 / 删除最后角色回复 */
	onDelete?: () => void;
	onCopy?: (text: string) => void;
	/** 在当前剧情点存档（世界线钉） */
	onStore?: () => void;
	/** 为这段正文文生音 */
	onTts?: (text: string) => void;
	ttsBusy?: boolean;
	/** 开场白切换（仅会话未开聊时） */
	greetingSwitch?: { index: number; total: number; onPrev: () => void; onNext: () => void };
	/** 角色回复变体（ST 箭头；与 greetingSwitch 可同时存在于不同消息） */
	swipe?: BubbleSwipe;
	/** 本条正处于编辑：正文区变输入框，下方「放弃 / 重新生成」 */
	edit?: BubbleEditState;
	/** 一档卡皮肤（显示层；缺省 null=与旧行为一致） */
	skin?: SkinProp | null;
	/** 点击原生行动选项时填入主输入框。 */
	onSelectOption?: (text: string) => void;
}

export function Bubble({
	msg,
	floor,
	fallbackName,
	avatarUrl,
	onReroll,
	onCurtainReroll,
	onEdit,
	onRewind,
	onDelete,
	onCopy,
	onStore,
	onTts,
	ttsBusy,
	greetingSwitch,
	swipe,
	edit,
	skin,
	onSelectOption,
}: BubbleProps) {
	// timer / 新 delta 不该重新套整页卡的 MB 级正则并扫描 HTML；只随正文/皮肤变更重算。
	const fullInterface = useMemo(() => {
		if (msg.channel !== "narrative" && msg.channel !== "greeting") return false;
		const { body } = splitAttachments(msg.text);
		return isFullInterface(skin && skin.rules.length > 0 ? applyCardSkin(body, skin.rules, skin) : body);
	}, [msg.channel, msg.text, skin]);
	if (msg.channel === "info") {
		return <div className="info-line">{msg.text}</div>;
	}
	if (msg.channel === "choice") {
		// 留痕的决策选择卡（重放）：置灰只读，标注结果（D10：岔路口是剧情资产）
		return msg.choice ? <ChoiceCard choice={msg.choice} /> : null;
	}
	if (msg.channel === "image") {
		// 插图（agent 经 show_image 交付）：舞台美术，与正文明确区隔（D10 合规：元信息层）
		return (
			<figure className="msg-image">
				<ZoomImg src={msg.src ?? ""} alt={msg.text || "插图"} />
				{msg.text && <figcaption>{msg.text}</figcaption>}
			</figure>
		);
	}
	if (msg.channel === "audio") {
		// 音频（show_audio / tts / 气泡配音）：元交付，可播放
		return (
			<figure className="msg-audio">
				<audio controls preload="metadata" src={msg.src ?? ""}>
					你的浏览器不支持音频播放
				</audio>
				{msg.text && <figcaption>{msg.text}</figcaption>}
			</figure>
		);
	}
	if (msg.channel === "video") {
		// 视频（show_video）：舞台美术，与正文区隔（D10）
		return (
			<figure className="msg-video">
				<video controls preload="metadata" playsInline src={msg.src ?? ""}>
					你的浏览器不支持视频播放
				</video>
				{msg.text && <figcaption>{msg.text}</figcaption>}
			</figure>
		);
	}
	if (msg.channel === "html") {
		// 对话流 HTML 底座（show_html）：agent 调试通道，保持非 seamless
		if (!msg.html?.trim()) return null;
		return <HtmlFrame html={msg.html} title={msg.text} scripts={msg.scripts === true} />;
	}
	if (msg.channel === "backstage") {
		// 戏外回复（助手答疑/办事）：排版明确区隔于叙事（PLAN-PHASE3 §6.1 显示通道）
		const name = msg.name || fallbackName;
		return (
			<div className="msg msg-backstage">
				<div className="msg-head">
					<MsgAvatar src={avatarUrl} name={name} kind="char" />
					<span className="msg-name">{name}</span>
					<span className="chip chip-backstage">助手</span>
				</div>
				{msg.thinking && <ThinkingBlock text={msg.thinking} />}
				<RichContent text={msg.text} skin={skin} />
				{msg.activities && msg.activities.length > 0 && <ActivityBar activities={msg.activities} />}
			</div>
		);
	}
	if (msg.channel === "import") {
		return (
			<details className="import-block">
				<summary>导入的聊天记录（点开查看）</summary>
				<RichContent text={msg.text} skin={skin} />
			</details>
		);
	}
	const isUser = msg.channel === "user";
	// 用户消息尾行的附件（附件随消息模型）：图片直接进对话显示，文件显示名+类型
	const { body, attachments } = isUser ? splitAttachments(msg.text) : { body: msg.text, attachments: [] };
	const name = msg.name || fallbackName;
	const editing = !!edit;
	/**
	 * 回合时间线：agent 回复才有（用户消息无过程），编辑态退回纯文本框。
	 * 有多于一段时才按时间线渲染——单段正文走旧路径可保留整楼界面判定。
	 */
	const timeline = !isUser && !editing && msg.segments && msg.segments.length > 1 ? msg.segments : null;
	// 整楼界面：皮肤应用后整条消息即界面（spec §4 落位 1）
	const stage = !isUser && !editing && fullInterface;
	const world = !isUser ? msg.world as LiteraryWorldState | undefined : undefined;
	const worldAudit = !isUser ? msg.worldAudit as WorldAuditWireView | undefined : undefined;
	const worldModules = !isUser ? msg.worldModules as ModularWorldWireView | undefined : undefined;
	const presentation = !isUser ? msg.presentation as PresentationView | undefined : undefined;
	const tavernVariables = !isUser ? msg.tavernVariables as TavernVariablesView | undefined : undefined;
	const ecology = !isUser ? msg.ecology as EcologyWireView | undefined : undefined;
	const workflow = !isUser ? msg.workflow as WireBeatWorkflow | undefined : undefined;
	const generationWorkflow = !isUser ? msg.generationWorkflow : undefined;
	const generationMode = !isUser ? msg.generationMode ?? generationWorkflow?.mode : undefined;
	const displayBody = !isUser && presentation
		? stripProjectedFormats(body, { options: !!presentation.options?.length })
		: body;
	const bodyOwnsOptions = /class=["'][^"']*(?:option|choice|w2g)|<(?:select|button)\b[^>]*(?:option|choice|w2g)|(?:行动选项|选择支|选项卡)/i.test(displayBody);
	const displayTimeline = timeline && presentation?.options?.length
		? timeline.map((segment) => segment.kind === "text" ? { ...segment, text: stripProjectedFormats(segment.text, { options: true }) } : segment)
		: timeline;
	return (
		<div
			className={`msg ${isUser ? "msg-user" : "msg-char"} ${isUser && msg.backstage ? "msg-user-backstage" : ""} ${editing ? "msg-editing" : ""} ${stage ? "msg-stage" : ""}`}
		>
			{!stage && (
				<div className="msg-head">
					<MsgAvatar src={avatarUrl} name={name} kind={isUser ? "user" : "char"} />
					<span className={`msg-name ${isUser ? "" : "msg-name-char"}`}>{name}</span>
					{generationMode && <span className={`chip generation-mode-badge ${generationMode}`}>{generationMode === "direct" ? "直出" : "导演流程"}</span>}
					{msg.channel === "greeting" && <span className="chip">开场白</span>}
					{!isUser && msg.unfinished && (
						<span className="chip chip-unfinished" title="生成被中断；发送「继续」可接着写">
							未完成
						</span>
					)}
					{editing && <span className="chip chip-edit">编辑中</span>}
					{floor !== undefined && <span className="floor">#{floor}</span>}
				</div>
			)}
			{!isUser && msg.metrics && (
				<div className="msg-metrics" title={`模型调用 ${msg.metrics.rounds || 1} 轮`}>
					{(msg.metrics.durationMs / 1000).toFixed(1)} 秒
					<span>·</span>
					{formatTokenCount(msg.metrics.outputTokens)} tokens
				</div>
			)}
			{stage && generationMode && <div className="generation-mode-stage-badge">生成模式 · {generationMode === "direct" ? "直出" : "导演流程"}</div>}
			{/* 有时间线时思考内联在时间线里（按发生顺序）；旧消息才走顶部固定块 */}
			{!timeline && msg.thinking && !editing && (
				<ThinkingBlock text={msg.thinking} defaultOpen={msg.unfinished === true} />
			)}
			{editing ? (
				<div className="msg-edit-box">
					<textarea
						className="msg-edit-ta"
						value={edit.draft}
						onChange={(e) => edit.onChange(e.target.value)}
						rows={Math.min(16, Math.max(4, edit.draft.split("\n").length + 1))}
						autoFocus
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								edit.onCancel();
							}
						}}
					/>
					<div className="msg-edit-actions">
						<button type="button" className="drawer-btn" onClick={edit.onCancel}>
							放弃
						</button>
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={!edit.draft.trim()}
							onClick={edit.onSubmit}
							title={edit.submitLabel ?? "确认修改"}
						>
							重新生成
						</button>
					</div>
				</div>
			) : (
				<>
					{/* 时间线态：思考/工具/正文按发生顺序依次上屏（codex 式）。
					    附件仍取自正文尾行，故正文用时间线渲染、附件另挂。 */}
					{displayTimeline ? (
						<TurnTimeline segments={displayTimeline} skin={skin} variables={tavernVariables} />
					) : (
						displayBody && (isUser ? <Paragraphs text={displayBody} /> : <RichContent text={displayBody} skin={skin} variables={tavernVariables} />)
					)}
					{attachments.length > 0 && (
						<div className="msg-attach">
							{attachments.map((a) =>
								a.image ? (
									<span key={a.file} className="msg-attach-img">
										<ZoomImg src={attachmentUrl(a)} alt={a.label} title={a.file} />
									</span>
								) : (
									<a key={a.file} href={attachmentUrl(a)} target="_blank" rel="noreferrer" className="file-chip" title={a.file}>
										<span className="file-ext">{(a.name.split(".").pop() ?? "?").toUpperCase()}</span>
										{a.label}
									</a>
								),
							)}
						</div>
					)}
					{/* 时间线态的工具步骤已内联在各自发生位置，不再末端重挂一份 */}
					{!timeline && msg.activities && msg.activities.length > 0 && <ActivityBar activities={msg.activities} />}
					{generationWorkflow && <GenerationWorkflowCard workflow={generationWorkflow} />}
					{msg.presentationDelivery && <details className="generation-workflow-card"><summary>卡格式交付 · {msg.presentationDelivery.status === "complete" ? "交付结构已校验" : "待恢复（未当作成功）"}</summary><div className="world-state-body"><p>原始资料 {msg.presentationDelivery.inputSourceCount ?? 0} 份 · {msg.presentationDelivery.inputChars?.toLocaleString() ?? 0} 字 · 格式重交 {msg.presentationDelivery.retryCount ?? 0} 次</p>{msg.presentationDelivery.formatNames?.length ? <p>本次核对：{msg.presentationDelivery.formatNames.join("、")}</p> : null}<p>图片、选项与卡自定义格式按当前卡交付；校验不是文学评分。</p></div></details>}
					{msg.modelDiagnostics?.length ? <ModelDiagnosticsCard calls={msg.modelDiagnostics} /> : null}
					{workflow && !generationWorkflow && <BeatWorkflowCard workflow={workflow} />}
					{(!workflow || generationWorkflow) && msg.performance && <PerformanceRows performance={msg.performance} />}
					{worldModules && (worldModules.round > 0 || worldAudit) ? <ModularWorldCard world={worldModules} audit={worldAudit} /> : world && (world.round > 0 || worldAudit) && <WorldStateCard world={world} audit={worldAudit} />}
					{presentation && <PresentationCards view={presentation} skin={skin} onSelectOption={onSelectOption} hideOptions={bodyOwnsOptions} />}
					{ecology && (ecology.round > 0 || ecology.public.actors.length > 0 || ecology.public.events.length > 0 || ecology.public.locations.length > 0 || ecology.discovered.actors.length > 0 || ecology.discovered.events.length > 0) && <EcologyStateCard ecology={ecology} />}
					{(onReroll || onEdit || onRewind || onDelete || onCopy || onStore || onTts || greetingSwitch || swipe) && (
						<div className="msg-actions">
							{/* 开场白快速切换：不进详情页 */}
							{greetingSwitch && (
								<span className="msg-variant-switch msg-greeting-switch" title="切换备选开场白（无需打开角色卡详情）">
									<button
										type="button"
										className="msg-variant-btn"
										onClick={greetingSwitch.onPrev}
										disabled={greetingSwitch.total <= 1}
										aria-label="上一条开场白"
									>
										<IconChevronLeft size={16} />
									</button>
									<span className="msg-variant-idx">
										开场 {greetingSwitch.index + 1}/{greetingSwitch.total}
									</span>
									<button
										type="button"
										className="msg-variant-btn"
										onClick={greetingSwitch.onNext}
										disabled={greetingSwitch.total <= 1}
										aria-label="下一条开场白"
									>
										<IconChevronRight size={16} />
									</button>
								</span>
							)}
							{/* ST 式回复变体：‹ n/m ›；末条点右 = 再生成，旧变体保留，仅当前进上下文，不写世界线 */}
							{swipe && (
								<span className="msg-variant-switch msg-swipe-switch" title="回复变体：仅当前选中进入模型；点右在末条时再生成">
									<button
										type="button"
										className="msg-variant-btn"
										onClick={swipe.onPrev}
										disabled={swipe.total > 0 && swipe.index <= 0}
										aria-label="上一条变体"
									>
										<IconChevronLeft size={16} />
									</button>
									<span className="msg-variant-idx">
										重roll {Math.max(0, swipe.total - 1)} 次 · {swipe.total > 0 ? `${swipe.index + 1}/${swipe.total}` : "1/1"}
									</span>
									<button
										type="button"
										className="msg-variant-btn msg-variant-btn-gen"
										onClick={swipe.onNext}
										aria-label={
											swipe.total === 0 || swipe.index >= swipe.total - 1
												? "生成新变体"
												: "下一条变体"
										}
										title={
											swipe.total === 0 || swipe.index >= swipe.total - 1
												? "生成新回复（原回复保留为变体）"
												: "下一条变体"
										}
									>
										<IconChevronRight size={16} />
									</button>
								</span>
							)}
							{onRewind && (
								<button className="act" onClick={onRewind} title="回退到此条之前（之后的剧情进会话树旁支）">
									<IconUndo size={13} /> 回退
								</button>
							)}
							{onReroll && (
								<button className="act" onClick={onReroll} title="从当前用户输入重新生成整拍：正文、状态栏、记账与后台推演都会重新执行">
									<IconRedo size={13} /> 重Roll整段
								</button>
							)}
							{onCurtainReroll && (
								<button className="act" onClick={onCurtainReroll} title="保留正文、账本和世界状态，只重做状态栏等非正文格式">
									<IconRedo size={13} /> 重Roll状态栏
								</button>
							)}
							{onEdit && (
								<button className="act" onClick={onEdit} title="在本条内修改文案">
									<IconEdit size={13} /> 修改
								</button>
							)}
							{onDelete && (
								<button className="act" onClick={onDelete} title="删除本轮或最后角色回复">
									<IconTrash size={13} /> 删除
								</button>
							)}
							{onCopy && (
								<button className="act" onClick={() => onCopy(msg.text)} title="复制正文">
									<IconCopy size={13} /> 复制
								</button>
							)}
							{onStore && (
								<button className="act" onClick={onStore} title="在当前剧情点存档（世界线节点）">
									<IconPin size={13} /> 存档
								</button>
							)}
							{onTts && (
								<button
									className="act"
									disabled={ttsBusy || !msg.text.trim()}
									onClick={() => onTts(msg.text)}
									title="文生音：为这段正文生成语音并显示播放器"
								>
									<IconSpeaker size={13} /> {ttsBusy ? "配音中…" : "配音"}
								</button>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

function WorldStateCard({ world, audit }: { world: LiteraryWorldState; audit?: WorldAuditWireView }) {
	const events = world.events.filter((item) => !/已消散|已完成|已失败/.test(item.stage));
	const secrets = world.blackbox.secretActions.length + world.blackbox.secretAssets.length;
	return (
		<details className="world-state-card">
			<summary>
				<span className="world-state-title">世界动态</span>
				<span className="world-state-round">第 {world.round} 轮</span>
				<span className="world-state-digest">{world.digest}</span>
			</summary>
			<div className="world-state-body">
				<p className="world-state-summary">{world.digest}</p>
				{audit && <WorldRows label="审计" rows={[`${audit.status === "committed" ? "已提交" : "未提交"}｜${audit.summary}`, ...audit.warnings.map((item) => `提醒｜${item}`)]} />}
				{events.length > 0 && <WorldRows label="事件" rows={events.map((item) => `${item.name} · ${item.stage || "进行中"} · Lv.${item.level}｜${item.description}`)} />}
				{world.factions.length > 0 && <WorldRows label="势力" rows={world.factions.map((item) => `${item.name}｜${item.status || "状态未明"}｜${item.relation || "立场未明"}｜${item.goal || "目标未明"}`)} />}
				{world.winds.length > 0 && <WorldRows label="风声" rows={world.winds.map((item) => `${item.content}｜${item.scope || "范围未明"}`)} />}
				{world.trends.length > 0 && <WorldRows label="大势" rows={world.trends.map((item) => `${item.name}｜${item.description}`)} />}
				{Object.keys(world.reputation).length > 0 && <WorldRows label="声誉" rows={Object.entries(world.reputation).map(([key, value]) => `${key}：${value}`)} />}
				{(world.economy.climate || world.economy.signals.length > 0) && <WorldRows label="经济" rows={[world.economy.climate, ...world.economy.signals].filter(Boolean)} />}
				{world.enemies.length > 0 && <WorldRows label="对立" rows={world.enemies.map((item) => `${item.name}｜${item.status}｜${item.reason}`)} />}
				{secrets > 0 && <div className="world-secret-note">幕后有 {secrets} 条未公开信息。为避免剧透，不显示具体内容。</div>}
			</div>
		</details>
	);
}

function WorldRows({ label, rows }: { label: string; rows: string[] }) {
	return <div className="world-state-section"><div className="world-state-label">{label}</div><ul>{rows.map((row, index) => <li key={`${label}-${index}`}>{row}</li>)}</ul></div>;
}

const PHASE_LABELS: Record<string, string> = {
	"prep": "拍前准备", "prep.arrival": "场景到达", "prep.continuity": "连续性", "prep.novelCalibration": "原著校准", "prep.plotAdaptation": "剧情适配",
	"prep.director": "导演", "prep.sceneConductor": "场景统筹", "prep.memoryRecall": "记忆召回", "prep.memoryArcs": "人物弧线",
	"writer": "主演正文", "settlement.planFact": "计划事实", "settlement.scribe": "场记", "settlement.worldFacts": "世界事实",
	"settlement.worldProposal": "世界提案", "settlement.worldAudit": "世界审计", "settlement.ecology": "生态结算", "curtain": "谢幕", "compaction": "压缩",
};
function PerformanceRows({ performance }: { performance: WireTurnPerformance }) {
	return <div className="bwf-performance">
		<div className="bwf-metrics"><span><small>端到端</small><b>{(performance.totalMs / 1000).toFixed(1)}s</b></span>
		<span><small>正文首字</small><b>{performance.timeToFirstNarrativeMs === undefined ? "未记录" : `${(performance.timeToFirstNarrativeMs / 1000).toFixed(1)}s`}</b></span></div>
		{Object.entries(performance.phases).map(([id, phase]) => phase && <div className="field-hint" key={id}>
			{PHASE_LABELS[id] || "阶段"} · {(phase.durationMs / 1000).toFixed(1)}s · {phase.calls} 次 harness 调用 · {phase.status || "未标注"}
			{phase.inputTokens !== undefined && ` · 已观测输入 ${formatTokenCount(phase.inputTokens)} tokens`}{phase.outputTokens !== undefined && ` · 已观测输出 ${formatTokenCount(phase.outputTokens)} tokens`}
		</div>)}
		<div className="bwf-privacy">阶段可能并行，不能相加为总耗时；调用次数是 harness attempts，供应商内部重试未知。仅展示已有 usage，首字不含工具旁白。</div>
	</div>;
}

function BeatWorkflowCard({ workflow }: { workflow: WireBeatWorkflow }) {
	const succeeded = workflow.stages.filter((stage) => stage.status === "success" || stage.status === "reused").length;
	const skipped = workflow.stages.filter((stage) => stage.status === "skipped").length;
	const statusLabel = skipped === 0 ? "完整运行" : `${succeeded}/${workflow.stages.length} 运行`;
	const director = workflow.director;
	const continuity = workflow.continuity;
	const writer = workflow.writer;
	return <details className="world-state-card beat-workflow-card">
		<summary><span className="world-state-title">本拍工作流</span><span className="world-state-round">{statusLabel}</span><span className="world-state-digest">导演、排演、连续性与主演工件可核对</span></summary>
		<div className="world-state-body beat-workflow-body">
			<div className="bwf-rail">{workflow.stages.map((stage) => <span key={stage.id} className={`bwf-node ${stage.status}`} title={`${stage.label}：${stage.summary}`}>{stage.status === "success" ? "✓" : stage.status === "reused" ? "↺" : stage.status === "degraded" ? "!" : "○"}</span>)}</div>
			<div className="bwf-stages">{workflow.stages.map((stage) => <div className="bwf-stage" key={stage.id}><span className={`bwf-status ${stage.status}`} /> <strong>{stage.label}</strong><span>{stage.summary}</span></div>)}</div>
			{continuity && <details className="bwf-detail"><summary>连续性工件</summary>
				{continuity.positions.length > 0 && <WorldRows label="位置" rows={continuity.positions} />}
				{continuity.ongoingActions.length > 0 && <WorldRows label="进行中" rows={continuity.ongoingActions} />}
				{continuity.promisesAndDeadlines.length > 0 && <WorldRows label="期限" rows={continuity.promisesAndDeadlines} />}
				{continuity.unresolvedPlayerChoices.length > 0 && <WorldRows label="待选择" rows={continuity.unresolvedPlayerChoices} />}
				{continuity.uncertainties.length > 0 && <WorldRows label="不确定" rows={continuity.uncertainties} />}
				{continuity.knowledgeBoundaryCount > 0 && <div className="world-secret-note">另有 {continuity.knowledgeBoundaryCount} 条知情边界，未在普通前端展开。</div>}
			</details>}
			{director && <details className="bwf-detail"><summary>查看导演方向</summary>
				{director.scenePressure && <WorldRows label="压力" rows={[director.scenePressure]} />}
				{director.characterInitiatives.length > 0 && <WorldRows label="主动性" rows={director.characterInitiatives.map((item) => `${item.character || "未指定角色"}｜动机：${item.motive || "-"}｜意图：${item.immediateIntent || "-"}｜上限：${item.limit || "-"}`)} />}
				{director.personalThreads.length > 0 && <WorldRows label="个人线" rows={director.personalThreads} />}
				{director.candidateBeats.length > 0 && <WorldRows label="候选拍点" rows={director.candidateBeats.map((item) => `${item}（候选，非既定事实）`)} />}
				{director.relationshipLimit && <WorldRows label="关系上限" rows={[director.relationshipLimit]} />}
				{director.playerStop && <WorldRows label="玩家停点" rows={[director.playerStop]} />}
				{(director.offstageCount > 0 || director.withheldCount > 0) && <div className="world-secret-note">幕后线 {director.offstageCount} 项 · 暂扣信息 {director.withheldCount} 项。为避免剧透，不显示正文。</div>}
			</details>}
			<div className="bwf-metrics"><span><small>计划</small><b>{writer.planWrites}</b></span><span><small>稿段</small><b>{writer.appends || writer.writes}</b></span><span><small>重评估拦截</small><b>{writer.appendRejects}</b></span><span><small>模型轮次</small><b>{writer.rounds}</b></span><span><small>正文</small><b>{writer.narrativeChars}</b></span><span><small>输出 tokens</small><b>{formatTokenCount(writer.outputTokens)}</b></span><span><small>耗时</small><b>{(writer.durationMs / 1000).toFixed(1)}s</b></span><span><small>检索</small><b>{writer.lookups}</b></span></div>
			{workflow.performance && <PerformanceRows performance={workflow.performance} />}
			<div className="bwf-privacy">只展示结构化工件和运行结果，不包含模型隐藏思维链、prompt 或原始旁路输出。</div>
		</div>
	</details>;
}

function ModelDiagnosticsCard({calls}: {calls:NonNullable<WireMsg["modelDiagnostics"]>}) {
	const failed=calls.filter(x=>x.status!=="success"&&!x.validationOnly),recovered=calls.filter(x=>x.recovered),validationFailures=calls.filter(x=>x.validationOnly);
	return <details className="generation-workflow-card"><summary>模型诊断 · {failed.length} 次请求失败 · {recovered.length} 次恢复{validationFailures.length?` · ${validationFailures.length} 次交付校验失败`:""}</summary>{calls.map((x,i)=><div key={i}><b>{x.step}</b> · {x.provider}/{x.model} · {x.validationOnly?"交付校验失败":x.status==="success"?x.recovered?"恢复成功":"成功":x.status==="cancelled"?"已取消":"失败"} · {(x.durationMs/1000).toFixed(1)}秒{x.statusCode&&` · HTTP ${x.statusCode}`}{x.reason&&<p>{x.reason}</p>}</div>)}</details>;
}

function GenerationWorkflowCard({ workflow }: { workflow: GenerationWorkflow }) {
	const failed = workflow.stages.filter((stage) => stage.status === "failed").length;
	const degraded = workflow.stages.filter((stage) => stage.status === "degraded").length;
	const skipped = workflow.stages.filter((stage) => stage.status === "skipped").length;
	const overall = failed > 0
		? `失败阶段 ${failed}`
		: degraded > 0
			? `报告待复核阶段 ${degraded}`
			: workflow.toolFallback
				? "使用文本工具协议"
				: skipped > 0
					? `未执行阶段 ${skipped}`
					: workflow.stages.length > 0
						? "正文阶段完成"
						: "无阶段记录";
	const overallClass = failed > 0 ? "failed" : degraded > 0 || workflow.toolFallback ? "degraded" : skipped > 0 || workflow.stages.length === 0 ? "partial" : "success";
	return <details className="world-state-card generation-workflow-card">
		<summary>
			<span className="world-state-title">生成流程 · {workflow.mode === "direct" ? "直出" : "导演流程"}</span>
			<span className={`generation-workflow-overall ${overallClass}`}>{overall}</span>
			<span className="world-state-digest">主 writer 轮次 {workflow.writerRounds}</span>
		</summary>
		<div className="world-state-body generation-workflow-body">
			{workflow.stages.length > 0 ? <div className="generation-workflow-stages" role="list" aria-label="生成阶段状态">
				{workflow.stages.map((stage, index) => {
					const presentation = generationStageStatusPresentation(stage.status);
					return <div className={`generation-workflow-stage ${stage.status}`} role="listitem" key={`${stage.stage}-${index}`}>
						<strong>{generationStageLabel(stage.stage)}</strong>
						<span className={`generation-workflow-status ${stage.status}`} aria-label={presentation.label}>{presentation.icon} {presentation.label}</span>
						<span>{stage.calls} {(["evidence","ideas","review"] as string[]).includes(stage.stage)?"固定岗位":"次阶段操作"}</span>
					</div>;
				})}
			</div> : <div className="field-hint">后端未提供阶段记录。</div>}
			<div className={`generation-workflow-fallback ${workflow.toolFallback ? "degraded" : "clear"}`}>工具协议：{workflow.toolFallback ? workflow.toolFallbackReason === "configured" ? "文本协议（配置声明不支持工具）" : workflow.toolFallbackReason === "unsupported" ? "文本协议（上游明确不支持工具）" : "历史兼容兜底（未记录原因）" : "原生工具（未切换文本协议）"}</div>
			<div className="bwf-privacy">只描述正文创作阶段，固定岗位数不等于底层API次数；不代表世界/生态结算或文学评分通过。报告待复核、请求失败与工具协议切换是不同状态；已恢复的API尝试保留诊断，不等于当前岗位失败。不包含prompt或原始旁路输出。</div>
		</div>
	</details>;
}

function ModularWorldCard({ world, audit }: { world: ModularWorldWireView; audit?: WorldAuditWireView }) {
	return <details className="world-state-card">
		<summary><span className="world-state-title">世界模块</span><span className="world-state-round">第 {world.round} 轮</span><span className="world-state-digest">{world.digest}</span></summary>
		<div className="world-state-body">
			<p className="world-state-summary">{world.digest}</p>
			{audit && <WorldRows label="审计" rows={[`${audit.status === "committed" ? "已提交" : "未提交"}｜${audit.summary}`, ...audit.warnings.map((item) => `提醒｜${item}`)]} />}
			{world.modules.map((module) => <details className="ecology-discovered" key={module.id}><summary>{module.name} · v{module.revision}</summary>
				{module.summary && <p className="world-state-summary">{module.summary}</p>}
				{module.publicRecords.length > 0 && <WorldRows label="公开状态" rows={module.publicRecords.map((record) => `${record.label}｜${record.status || "持续中"}｜${record.summary}`)} />}
				{module.discoverableRecords.length > 0 && <WorldRows label="可探索信息" rows={module.discoverableRecords.map((record) => `${record.label}｜${record.status || "待发现"}｜${record.summary}`)} />}
				{module.secretCount > 0 && <div className="world-secret-note">幕后有 {module.secretCount} 条未公开记录，为避免剧透不显示内容。</div>}
			</details>)}
		</div>
	</details>;
}

function PresentationCards({ view, skin, onSelectOption, hideOptions = false }: { view: PresentationView; skin?: SkinProp | null; onSelectOption?: (text: string) => void; hideOptions?: boolean }) {
	const hasCardStatusFront = skin?.rules.some((rule) =>
		/StatusPlaceHolderImpl|StatusBlock|status(?:bar|_block)?|state\\?d/i.test(`${rule.name}\n${rule.source}`),
	) ?? false;
	return <div className="presentation-cards">
		{!hasCardStatusFront && <details className="world-state-card"><summary><span className="world-state-title">当前状态</span><span className="world-state-digest">{view.status.time || "时间未定"} · {view.status.location || "地点未定"}</span></summary>
			<div className="world-state-body"><WorldRows label={view.status.playerName} rows={[`时间｜${view.status.time || "未定"}`, `地点｜${view.status.location || "未定"}`, ...(view.status.inventory.length ? [`物品｜${view.status.inventory.join("、")}`] : []), ...Object.entries(view.status.flags).slice(0, 8).map(([key, value]) => `${key}｜${value}`)]} /></div>
		</details>}
		{view.calendar && skin?.rules.some((rule) => /calendar/i.test(rule.source))
			? <RichContent text={serializeCalendarSource(view.calendar)} skin={skin} collapsibleHtml htmlTitle="日历" />
			: view.calendar && <NativeCalendarCard calendar={view.calendar} />}
		{!hideOptions && view.options && view.options.length > 0 && <details className="world-state-card" open><summary><span className="world-state-title">行动选项</span><span className="world-state-round">点击填入输入框</span></summary><div className="world-state-body presentation-options">{view.options.map((option, index) => <button type="button" className="presentation-option" key={`${index}-${option}`} onClick={() => onSelectOption?.(option)}><span>{index + 1}</span>{option}</button>)}</div></details>}
	</div>;
}

function NativeCalendarCard({ calendar }: { calendar: CalendarView }) {
	const available = calendar.months?.length ? calendar.months : [{ year: calendar.year, month: calendar.month, monthName: `${calendar.month}月`, weekdayNames: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"], currentDay: calendar.currentDay, previous: { year: calendar.year, month: calendar.month }, next: { year: calendar.year, month: calendar.month }, days: calendar.days } satisfies CalendarMonthView];
	const authorityIndex = Math.max(0, available.findIndex((month) => month.year === calendar.year && month.month === calendar.month));
	const [index, setIndex] = useState(authorityIndex);
	const safeIndex = Math.min(Math.max(index, 0), available.length - 1);
	const month = available[safeIndex] ?? available[authorityIndex]!;
	const initialDay = month.currentDay ?? month.days.find((day) => day.events.length)?.day ?? 1;
	const [selected, setSelected] = useState(initialDay);
	useEffect(() => { setIndex(authorityIndex); setSelected(calendar.currentDay); }, [calendar.year, calendar.month, calendar.currentDay, authorityIndex, available.length]);
	const selectedDay = month.days.find((day) => day.day === selected) ?? month.days[0];
	const leading = month.days[0]?.weekday ?? 0;
	return <details className="world-state-card presentation-calendar">
		<summary><span className="world-state-title">日历</span><span className="world-state-round">{calendar.year}年{calendar.month}月{calendar.currentDay}日</span></summary>
		<div className="world-state-body">
			<div className="calendar-toolbar"><button type="button" className="calendar-nav" disabled={safeIndex <= 0} onClick={() => { setIndex((value) => Math.max(0, value - 1)); setSelected(1); }}><IconChevronLeft size={14} /></button><strong>{month.year}年 · {month.monthName}</strong><button type="button" className="calendar-nav" disabled={safeIndex >= available.length - 1} onClick={() => { setIndex((value) => Math.min(available.length - 1, value + 1)); setSelected(1); }}><IconChevronRight size={14} /></button></div>
			<div className="calendar-weekdays" style={{ gridTemplateColumns: `repeat(${month.weekdayNames.length},minmax(0,1fr))` }}>{month.weekdayNames.map((name) => <span key={name}>{name.replace(/^周/, "")}</span>)}</div>
			<div className="calendar-grid" style={{ gridTemplateColumns: `repeat(${month.weekdayNames.length},minmax(0,1fr))` }}>{Array.from({ length: leading }, (_, empty) => <span className="calendar-cell calendar-empty" key={`empty-${empty}`} />)}{month.days.map((day) => <button type="button" key={day.day} className={`calendar-cell${day.current ? " current" : ""}${day.day === selected ? " selected" : ""}`} onClick={() => setSelected(day.day)}><span>{day.day}</span><span className="calendar-cell-events">{day.events.slice(0, 3).map((event) => <i key={event.id} className={`calendar-event-dot ${event.source}`} />)}</span></button>)}</div>
			<div className="calendar-agenda"><div className="world-state-label">{month.monthName}{selectedDay?.day ?? selected}日{selectedDay?.current ? " · 今天" : ""}</div>{selectedDay?.events.length ? selectedDay.events.map((event) => <div className="calendar-agenda-item" key={event.id}><div><strong>{event.title}</strong><span className={`calendar-source ${event.source}`}>{event.sourceLabel || (event.source === "world" ? "世界" : "生态")}</span><span className="calendar-source">{event.visibility === "public" ? "公开" : "可探索"}</span></div>{event.days > 1 && <small>{event.startDate} 至 {event.endDate} · 第 {event.dayIndex}/{event.days} 日</small>}<p>{event.summary || "暂无补充说明"}</p></div>) : <p className="world-state-summary">暂无公开安排。</p>}</div>
		</div>
	</details>;
}

function EcologyStateCard({ ecology }: { ecology: EcologyWireView }) {
	const [revealed, setRevealed] = useState(false);
	useEffect(() => { setRevealed(false); }, [ecology.round, ecology.digest]);
	const cognition = ecology.spoilers.cognition ?? [];
	const advances = ecology.spoilers.actorAdvances ?? [];
	const propagation = ecology.propagation ?? [];
	const spoilerCount = ecology.spoilers.actors.length + ecology.spoilers.events.length + ecology.spoilers.secrets.length + cognition.length + advances.length;
	return <details className="world-state-card ecology-state-card">
		<summary>
			<span className="world-state-title">鲜活世界</span>
			<span className="world-state-round">第 {ecology.round} 轮</span>
			<span className="world-state-digest">{ecology.digest}</span>
		</summary>
		<div className="world-state-body">
			<p className="world-state-summary">{ecology.digest}</p>
			{ecology.public.locations.length > 0 && <WorldRows label="公开场所动态" rows={ecology.public.locations} />}
			{ecology.public.events.length > 0 && <WorldRows label="公开事件" rows={ecology.public.events} />}
			{propagation.length > 0 && <details className="ecology-discovered ecology-propagation"><summary>社会传播面 · {propagation.length}</summary>{propagation.map((item) => <div className="ecology-propagation-item" key={item.occurrenceId}><strong>{item.headline || item.eventName}</strong><span>{item.sourceType === "official" ? "官方" : item.sourceType === "mixed" ? "混合来源" : "非官方"} · {item.claimStatus === "fact" ? "已证实" : item.claimStatus === "rumor" ? "传闻" : "信息混杂"}</span><p>{item.publicity === "trace" ? item.trace : item.summary || item.trace}</p></div>)}</details>}
			{ecology.public.actors.length > 0 && <WorldRows label="活跃人物" rows={ecology.public.actors} />}
			{(ecology.discovered.events.length > 0 || ecology.discovered.actors.length > 0) && <details className="ecology-discovered"><summary>可探索信息</summary>
				{ecology.discovered.events.length > 0 && <WorldRows label="进入场景后可能发现" rows={ecology.discovered.events} />}
				{ecology.discovered.actors.length > 0 && <WorldRows label="场外人物" rows={ecology.discovered.actors} />}
			</details>}
			{spoilerCount > 0 && <div className="ecology-spoiler">
				{!revealed ? <button type="button" className="drawer-btn ecology-reveal" onClick={() => setRevealed(true)}>查看幕后剧透（{spoilerCount} 条）</button> : <>
					<div className="world-secret-note">以下是系统掌握但用户角色未必知道的幕后真相。</div>
					{ecology.spoilers.actors.length > 0 && <WorldRows label="人物真实目标" rows={ecology.spoilers.actors} />}
					{ecology.spoilers.events.length > 0 && <WorldRows label="秘密事件" rows={ecology.spoilers.events} />}
					{ecology.spoilers.secrets.length > 0 && <WorldRows label="幕后真相" rows={ecology.spoilers.secrets} />}
					{cognition.length > 0 && <WorldRows label="人物认知边界" rows={cognition} />}
					{advances.length > 0 && <WorldRows label="后台人物推进" rows={advances} />}
					<button type="button" className="drawer-btn" onClick={() => setRevealed(false)}>收起剧透</button>
				</>}
			</div>}
		</div>
	</details>;
}
