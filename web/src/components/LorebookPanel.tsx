/**
 * 世界书面板（右栏）：
 * - 绿灯=常驻 constant、蓝灯=关键词触发、灰=停用；order 优先级；selective 次要词
 * - 启停开关（disabledLore 覆盖）与绿/蓝类型正交
 * - 可编辑：constant / order / keys / secondaryKeys / selective / comment / content（写回源文件）
 * - 导入/导出标准世界书 JSON（与酒馆互通的公开格式，产品文案不写 ST）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	downloadJson,
	normalizeActiveLorebooks,
	type LorebookResponse,
	type LorebooksResponse,
	type LoreEntryPatchBody,
	type LoreEntryView,
	type LoreTargetBody,
	type LoreSearchHit,
} from "../api.ts";
import { bumpWatchPanels, ConfirmButton, Field, PanelStatus, SearchInput, Toggle, useAction, usePanelData } from "./kit.tsx";

const SOURCE_LABEL: Record<LoreEntryView["source"], string> = {
	card: "卡内嵌",
	file: "独立文件",
	agent: "agent 补充",
};

type LoreSort = "book" | "name" | "chars" | "order";

function parseKeyLine(s: string): string[] {
	return s
		.split(/[,，、\n]+/)
		.map((k) => k.trim())
		.filter(Boolean);
}

/** ST 式状态灯：绿=常驻 · 蓝=关键词 · 灰=停用 */
function LoreLight({
	constant,
	enabled,
	onClick,
	disabled,
}: {
	constant: boolean;
	enabled: boolean;
	onClick?: () => void;
	disabled?: boolean;
}) {
	const kind = !enabled ? "off" : constant ? "green" : "blue";
	const title = !enabled
		? "已停用（开关打开后：绿灯=常驻 / 蓝灯=关键词）"
		: constant
			? "绿灯 · 常驻（每轮注入，点击改为蓝灯关键词）"
			: "蓝灯 · 关键词触发（命中 key 才注入，点击改为绿灯常驻）";
	return (
		<button
			type="button"
			className={`lore-light lore-light-${kind}`}
			title={title}
			aria-label={title}
			disabled={disabled || !onClick}
			onClick={(ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				onClick?.();
			}}
		/>
	);
}

function EntryRow({
	e,
	busy,
	expandTick,
	expanded,
	onToggle,
	onPatch,
	onDelete,
	scope,
}: {
	e: LoreEntryView;
	busy: boolean;
	expandTick: number;
	expanded: boolean;
	onToggle: (fingerprint: string, enabled: boolean, entryKey?: string) => void;
	onPatch: (body: LoreEntryPatchBody, doneText?: string) => Promise<boolean>;
	scope: LoreTargetBody;
	onDelete: (fingerprint: string, entryKey?: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [full, setFull] = useState<string | null>(e.content ?? null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [draftComment, setDraftComment] = useState(e.comment);
	const [draftOrder, setDraftOrder] = useState(String(e.order));
	const [draftConstant, setDraftConstant] = useState(e.constant);
	const [draftSelective, setDraftSelective] = useState(e.selective);
	const [draftKeys, setDraftKeys] = useState(e.keys.join("、"));
	const [draftSec, setDraftSec] = useState(e.secondaryKeys.join("、"));
	const [draftContent, setDraftContent] = useState("");

	useEffect(() => setOpen(expanded), [expandTick, expanded]);

	// 外部数据刷新时同步草稿（非编辑中）
	useEffect(() => {
		if (editing) return;
		setDraftComment(e.comment);
		setDraftOrder(String(e.order));
		setDraftConstant(e.constant);
		setDraftSelective(e.selective);
		setDraftKeys(e.keys.join("、"));
		setDraftSec(e.secondaryKeys.join("、"));
	}, [e, editing]);

	const loadFull = async () => {
		if (full !== null) return full;
		try {
			const r = await apiGet<{ content: string }>(`/api/lorebook/entry?${targetQuery(scope)}&fp=${encodeURIComponent(e.fingerprint)}${e.entryKey !== undefined ? `&entryKey=${encodeURIComponent(e.entryKey)}` : ""}`);
			setFull(r.content);
			return r.content;
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error));
			throw error; // 不以截断预览冒充全文，避免失败后保存覆盖原文。
		}
	};

	useEffect(() => {
		if (open) void loadFull().catch(() => undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 展开时惰性取全文
	}, [open]);

	const startEdit = async () => {
		let content: string;
		try { content = await loadFull(); } catch { return; }
		setLoadError(null);
		setDraftContent(content);
		setDraftComment(e.comment);
		setDraftOrder(String(e.order));
		setDraftConstant(e.constant);
		setDraftSelective(e.selective);
		setDraftKeys(e.keys.join("、"));
		setDraftSec(e.secondaryKeys.join("、"));
		setEditing(true);
		setOpen(true);
	};

	const saveEdit = async () => {
		const order = Number.parseInt(draftOrder, 10);
		const keys = parseKeyLine(draftKeys);
		const secondaryKeys = parseKeyLine(draftSec);
		if (!draftConstant && keys.length === 0) {
			// 蓝灯无关键词会永远不触发，仍允许保存（用户可能稍后补）
		}
		const saved = await onPatch(
			{
				fingerprint: e.fingerprint,
				entryKey: e.entryKey,
				comment: draftComment,
				order: Number.isFinite(order) ? order : e.order,
				constant: draftConstant,
				selective: draftSelective && secondaryKeys.length > 0,
				keys,
				secondaryKeys,
				content: draftContent,
			},
			"条目已保存",
		);
		if (saved) {
			setEditing(false);
			setFull(draftContent);
		}
	};

	const flipLight = () => {
		if (!e.enabled) return;
		onPatch(
			{ fingerprint: e.fingerprint,
				entryKey: e.entryKey, constant: !e.constant },
			e.constant ? "已改为蓝灯（关键词触发）" : "已改为绿灯（常驻）",
		);
	};

	return (
		<div className={`lore-item ${e.enabled ? "" : "off"}`}>
			<div className="lore-head">
				<LoreLight constant={e.constant} enabled={e.enabled} disabled={busy} onClick={e.enabled ? flipLight : undefined} />
				<details open={open} onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
					<summary>
						<span className="lore-title">{e.comment || e.keys[0] || "（未命名）"}</span>
						<span className="lore-order" title="插入优先级 order（越小越靠前）">
							#{e.order}
						</span>
						{e.selective && e.secondaryKeys.length > 0 && (
							<span className="chip chip-selective" title="次要关键词也需命中（selective）">
								AND
							</span>
						)}
						<span className={`chip chip-src chip-src-${e.source}`}>{SOURCE_LABEL[e.source]}</span>
						<span className="lore-meta">{e.chars} 字</span>
					</summary>

					{!editing && (
						<>
							{e.keys.length > 0 && <div className="lore-keys">关键词：{e.keys.join("、")}</div>}
							{e.secondaryKeys.length > 0 && <div className="lore-keys">次要：{e.secondaryKeys.join("、")}</div>}
							{e.constant && <div className="lore-keys">类型：绿灯常驻（不扫关键词）</div>}
							{!e.constant && <div className="lore-keys">类型：蓝灯关键词{e.keys.length === 0 ? "（无 key，不会触发）" : ""}</div>}
							<div className="longtext">{full ?? e.preview}</div>
							{loadError && <div role="alert" className="sp-empty">{loadError}</div>}
							<div className="panel-row" style={{ marginTop: 6 }}>
								<button type="button" className="drawer-btn" disabled={busy} onClick={() => void startEdit()}>
									编辑
								</button>
								<ConfirmButton disabled={busy} confirmText="确认删除" onConfirm={() => onDelete(e.fingerprint, e.entryKey)}>
									删除
								</ConfirmButton>
							</div>
						</>
					)}

					{editing && (
						<div className="lore-edit" onClick={(ev) => ev.stopPropagation()}>
							<Field label="标题（comment）">
								<input className="panel-search" value={draftComment} onChange={(ev) => setDraftComment(ev.target.value)} />
							</Field>
							<div className="panel-row lore-edit-row">
								<Field label="优先级 order" hint="越小越靠前">
									<input
										className="panel-search lore-order-input"
										type="number"
										min={0}
										max={9999}
										value={draftOrder}
										onChange={(ev) => setDraftOrder(ev.target.value)}
									/>
								</Field>
								<Field label="类型">
									<select
										className="panel-search"
										value={draftConstant ? "constant" : "keyed"}
										onChange={(ev) => setDraftConstant(ev.target.value === "constant")}
									>
										<option value="constant">绿灯 · 常驻</option>
										<option value="keyed">蓝灯 · 关键词</option>
									</select>
								</Field>
							</div>
							{!draftConstant && (
								<>
									<Field label="主关键词" hint="逗号 / 顿号分隔">
										<input className="panel-search" value={draftKeys} onChange={(ev) => setDraftKeys(ev.target.value)} placeholder="如：南京、某角色" />
									</Field>
									<Field label="次要关键词" hint="可选；勾选 AND 后需同时命中">
										<input className="panel-search" value={draftSec} onChange={(ev) => setDraftSec(ev.target.value)} />
									</Field>
									<label className="lore-check">
										<input
											type="checkbox"
											checked={draftSelective}
											onChange={(ev) => setDraftSelective(ev.target.checked)}
											disabled={parseKeyLine(draftSec).length === 0}
										/>
										次要也要命中（selective / AND）
									</label>
								</>
							)}
							{draftConstant && (
								<div className="field-hint">常驻条目不依赖关键词；仍可保留 key 供检索测试与 lorebook_search。</div>
							)}
							{draftConstant && (
								<Field label="关键词（可选，供检索）">
									<input className="panel-search" value={draftKeys} onChange={(ev) => setDraftKeys(ev.target.value)} />
								</Field>
							)}
							<Field label="正文">
								<textarea className="panel-search lore-content-edit" rows={8} value={draftContent} onChange={(ev) => setDraftContent(ev.target.value)} />
							</Field>
							<div className="panel-row">
								<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={saveEdit}>
									保存
								</button>
								<button
									type="button"
									className="drawer-btn"
									disabled={busy}
									onClick={() => {
										setEditing(false);
									}}
								>
									取消
								</button>
							</div>
						</div>
					)}
				</details>
				<Toggle
					checked={e.enabled}
					disabled={busy}
					title={e.enabled ? "停用该条目" : "启用该条目"}
					onChange={(v) => onToggle(e.fingerprint, v, e.entryKey)}
				/>
			</div>
		</div>
	);
}

/** 浏览目标：某一本文件，或 agent 补充设定 */
type ViewTarget = { kind: "file"; path: string } | { kind: "card" | "agent"; cardIdentity: string; cardPath: string };
function targetBody(view: ViewTarget): LoreTargetBody {
	return view.kind === "file" ? { source: "file", path: view.path } : { source: view.kind, cardIdentity: view.cardIdentity };
}
function targetQuery(scope: LoreTargetBody): string {
	const query = new URLSearchParams({ source: scope.source });
	if (scope.path) query.set("path", scope.path);
	if (scope.cardIdentity) query.set("cardIdentity", scope.cardIdentity);
	return query.toString();
}
function targetKey(view: ViewTarget | null): string {
	return !view ? "none" : view.kind === "file" ? `file:${view.path}` : `${view.kind}:${view.cardIdentity}`;
}

/** 书管理区：勾选=挂载进会话；点书名=下方只显示该本条目（不合并）。 */
function BooksSection({
	toast,
	view,
	onView,
	onMountChanged,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	view: ViewTarget | null;
	onView: (v: ViewTarget) => void;
	onMountChanged: () => void;
}) {
	// watchAgent：配套世界书导入 / agent 写书后由 bumpWatchPanels·agentTick 自动重拉书单
	const { data, error, loading, reload } = usePanelData(() => apiGet<LorebooksResponse>("/api/lorebooks"), {
		cacheKey: "/api/lorebooks",
		watchAgent: true,
	});
	const { busy, run } = useAction(toast);
	const [importing, setImporting] = useState(false);

	const active = useMemo(() => normalizeActiveLorebooks(data?.active ?? null), [data?.active]);
	const activeSet = useMemo(() => new Set(active), [active]);

	const previousCardPath = useRef<string | null>(null);
	// 当前卡内书优先；换卡/修订刷新身份并重建条目行，旧请求不能延用。
	useEffect(() => {
		if (!data) return;
		const card = data.embeddedCard;
		const switched = previousCardPath.current !== null && previousCardPath.current !== card.path;
		previousCardPath.current = card.path;
		if (switched || !view) {
			onView({ kind: "card", cardIdentity: card.cardIdentity, cardPath: card.path });
			return;
		}
		if (view.kind !== "file" && view.cardIdentity !== card.cardIdentity) {
			onView({ kind: view.kind, cardIdentity: card.cardIdentity, cardPath: card.path });
			return;
		}
		let focus: string | null = null;
		try {
			focus = sessionStorage.getItem("liyuan.lore.focus");
			if (focus) sessionStorage.removeItem("liyuan.lore.focus");
		} catch {
			/* ignore */
		}
		if (focus && data.books.some((b) => b.path === focus)) {
			onView({ kind: "file", path: focus });
			return;
		}
		if (view.kind === "file" && !data.books.some((book) => book.path === view.path)) {
			onView({ kind: "card", cardIdentity: card.cardIdentity, cardPath: card.path });
		}
	}, [data, view, onView]);

	const toggleMount = (path: string, e: React.MouseEvent) => {
		e.stopPropagation();
		run(async () => {
			await apiPost("/api/lorebooks/select", { path });
			reload();
			onMountChanged();
		});
	};

	const clearAll = () =>
		run(async () => {
			await apiPost("/api/lorebooks/select", { paths: [] });
			reload();
			onMountChanged();
		}, "已卸下全部独立世界书（卡内书仍随卡加载）");

	const remove = (path: string) =>
		run(async () => {
			await apiDelete(`/api/lorebooks?path=${encodeURIComponent(path)}`);
			reload();
			onMountChanged();
			if (view?.kind === "file" && view.path === path && data) {
				const rest = data.books.filter((b) => b.path !== path);
				if (rest[0]) onView({ kind: "file", path: rest[0].path });
				else onView({ kind: "card", cardIdentity: data.embeddedCard.cardIdentity, cardPath: data.embeddedCard.path });
			}
		}, "已删除");

	const exportBook = async (path: string) => {
		try {
			const r = await apiGet<{ name: string; json: unknown }>(`/api/lorebook/export?path=${encodeURIComponent(path)}`);
			downloadJson(`${r.name}.json`, r.json);
			toast("info", `已导出「${r.name}」`);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const exportMerged = async () => {
		try {
			const r = await apiGet<{ name: string; json: unknown }>("/api/lorebook/export");
			downloadJson(`${r.name}.json`, r.json);
			toast("info", "已导出会话合并世界书（当前卡内书 + 全部挂载书 + agent 补充）");
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const doImport = async (file: File) => {
		setImporting(true);
		try {
			const json = JSON.parse(await file.text()) as unknown;
			const r = await apiPost<{ path: string; entryCount: number }>(
				`/api/lorebooks/import?name=${encodeURIComponent(file.name.replace(/\.json$/i, ""))}`,
				json,
			);
			toast("info", `已导入（${r.entryCount} 条）——点书名看条目，勾选才挂进会话`);
			reload();
			onView({ kind: "file", path: r.path });
			// 条目区等其它 watch 订阅一并刷新
			bumpWatchPanels();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setImporting(false);
		}
	};

	const viewingFile = view?.kind === "file" ? view.path : null;
	const viewingAgent = view?.kind === "agent";
	const exportCard = async () => {
		if (!data) return;
		try {
			const r = await apiGet<{ name: string; json: unknown }>(`/api/lorebook/export?${targetQuery({ source: "card", cardIdentity: data.embeddedCard.cardIdentity })}`);
			downloadJson(`${r.name}-内嵌世界书.json`, r.json);
			toast("info", "已导出当前角色卡内嵌世界书（包括停用条目）");
		} catch (error) { toast("error", error instanceof Error ? error.message : String(error)); }
	};

	return (
		<section className="sp-section">
			<h4>世界书</h4>
			<div className="field-hint">
				独立书<strong>勾选</strong>＝挂进会话（可多本）· <strong>点书名</strong>＝下方只显示该本条目（不合并其它书）。
			</div>
			<PanelStatus loading={loading} error={error} hasData={!!data} />
			{data && (
				<>
					<div className="book-row book-toolbar">
						<span className="lore-meta">独立书已挂 {active.length} 本</span>
						{active.length > 0 && (
							<button type="button" className="act" disabled={busy} onClick={() => clearAll()}>
								全部卸下
							</button>
						)}
					</div>
					<div className={`book-row book-embedded ${view?.kind === "card" ? "current" : ""}`}>
						<button type="button" className="book-pick book-pick-full" onClick={() => onView({ kind: "card", cardIdentity: data.embeddedCard.cardIdentity, cardPath: data.embeddedCard.path })}>
							<span className="book-name">当前角色卡内嵌世界书 · {data.embeddedCard.name}</span>
							<span className="lore-meta">{data.embeddedCard.entryCount} 条 · 启用 {data.embeddedCard.enabledCount} 条</span>
							<span className="lore-meta book-mounted-tag">自动随卡加载</span>
						</button>
						<span className="book-acts"><button type="button" className="act" onClick={() => void exportCard()}>导出</button></span>
					</div>
					<div className="field-hint">卡内条目无需另存或挂载。下方可浏览全部启用和停用条目；启停、编辑会写回当前卡，原本关闭的模块不会自动开启。</div>
					{data.books.map((b) => {
						const mounted = activeSet.has(b.path);
						const viewing = viewingFile === b.path;
						return (
							<div key={b.path} className={`book-row ${viewing ? "current" : ""}`}>
								<button
									type="button"
									className="book-check"
									disabled={busy}
									title={mounted ? "卸下（不进会话）" : "挂载（进会话）"}
									onClick={(ev) => toggleMount(b.path, ev)}
								>
									<span className={`check ${mounted ? "on" : ""}`} aria-checked={mounted} role="checkbox" />
								</button>
								<button
									type="button"
									className="book-pick"
									title={`查看条目：${b.path}`}
									onClick={() => onView({ kind: "file", path: b.path })}
								>
									<span className="book-name">{b.name}</span>
									<span className="lore-meta">{b.entryCount} 条</span>
									{mounted && <span className="lore-meta book-mounted-tag">已挂</span>}
								</button>
								<span className="book-acts">
									<button type="button" className="act" onClick={() => void exportBook(b.path)}>
										导出
									</button>
									{b.path.startsWith("assets/lorebooks/") && (
										<ConfirmButton disabled={busy} confirmText="确认删除" onConfirm={() => remove(b.path)}>
											删除
										</ConfirmButton>
									)}
								</span>
							</div>
						);
					})}
					<div className={`book-row ${viewingAgent ? "current" : ""}`}>
						<button type="button" className="book-pick book-pick-full" onClick={() => onView({ kind: "agent", cardIdentity: data.embeddedCard.cardIdentity, cardPath: data.embeddedCard.path })}>
							<span className="book-name">agent 补充设定</span>
							<span className="lore-meta">按卡自动</span>
						</button>
					</div>
					{data.books.length === 0 && <div className="sp-empty">没有独立世界书，可导入 JSON；卡内书见上方</div>}
					<div className="panel-row book-io">
						<label className="drawer-btn book-import">
							{importing ? "导入中…" : "导入世界书 JSON"}
							<input
								type="file"
								accept=".json,application/json"
								hidden
								onChange={(e) => {
									const f = e.target.files?.[0];
									if (f) void doImport(f);
									e.target.value = "";
								}}
							/>
						</label>
						<button type="button" className="drawer-btn" title="导出会话里卡内书+全部挂载书+补充" onClick={() => void exportMerged()}>
							导出合并
						</button>
					</div>
				</>
			)}
		</section>
	);
}

function LoreEntries({ toast, view }: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	view: ViewTarget | null;
}) {
	const viewKey = targetKey(view);
	const currentViewKey = useRef(viewKey);
	currentViewKey.current = viewKey;
	const searchRequest = useRef(0);
	useEffect(() => () => { searchRequest.current += 1; }, []);

	const loadEntries = useCallback((): Promise<LorebookResponse> => {
		if (view) return apiGet<LorebookResponse>(`/api/lorebook?${targetQuery(targetBody(view))}`);
		return Promise.resolve({ lorebookPath: null, total: 0, entries: [] });
	}, [view]);

	const { data: loaded, error, loading, reload } = usePanelData(loadEntries, { watchAgent: true });
	const data = loaded && view && loaded.viewSource === view.kind &&
		(view.kind === "file" ? loaded.viewPath === view.path : loaded.cardIdentity === view.cardIdentity) ? loaded : null;
	useEffect(() => { searchRequest.current += 1; reload(); setHits(null); setSearching(false); }, [viewKey, reload]);

	const { busy, run } = useAction(toast);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<LoreSearchHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [sort, setSort] = useState<LoreSort>("order");
	const [expandTick, setExpandTick] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [limit, setLimit] = useState(40);
	// 新增条目表单
	const [adding, setAdding] = useState(false);
	const [newComment, setNewComment] = useState("");
	const [newKeys, setNewKeys] = useState("");
	const [newContent, setNewContent] = useState("");
	const [newConstant, setNewConstant] = useState(false);
	const [newOrder, setNewOrder] = useState("100");

	const doSearch = async () => {
		const requestId = ++searchRequest.current;
		const requestView = viewKey;
		const q = query.trim();
		if (!q) {
			setHits(null);
			return;
		}
		setSearching(true);
		try {
			const r = await apiGet<{ hits: LoreSearchHit[] }>(`/api/lorebook/search?q=${encodeURIComponent(q)}`);
			if (requestId === searchRequest.current && requestView === currentViewKey.current) setHits(r.hits);
		} catch (e) {
			if (requestId === searchRequest.current && requestView === currentViewKey.current) toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			if (requestId === searchRequest.current && requestView === currentViewKey.current) setSearching(false);
		}
	};

	const scope = view ? targetBody(view) : null;
	const toggle = (fingerprint: string, enabled: boolean, entryKey?: string) => run(async () => {
		if (!scope) return;
		await apiPost("/api/lorebook/toggle", { ...scope, fingerprint, entryKey, enabled });
		reload(); bumpWatchPanels();
	});
	const toggleFiltered = (enabled: boolean) => run(async () => {
		if (!scope) return;
		await apiPost("/api/lorebook/toggle", { ...scope, entries: filtered.map((entry) => ({ fingerprint: entry.fingerprint, entryKey: entry.entryKey })), enabled });
		reload(); bumpWatchPanels();
	}, enabled ? "已启用筛选条目" : "已停用筛选条目");
	const patch = async (body: LoreEntryPatchBody, doneText?: string): Promise<boolean> => {
		let saved = false;
		await run(async () => {
			if (!scope) return;
			await apiPut("/api/lorebook/entry", { ...scope, ...body });
			saved = true;
			reload(); bumpWatchPanels();
		}, doneText);
		return saved;
	};
	const removeEntry = (fingerprint: string, entryKey?: string) => run(async () => {
		if (!scope) return;
		await apiDelete(`/api/lorebook/entry?${targetQuery(scope)}&fp=${encodeURIComponent(fingerprint)}${entryKey !== undefined ? `&entryKey=${encodeURIComponent(entryKey)}` : ""}`);
		reload(); bumpWatchPanels();
	}, "条目已删除");

	const resetAddForm = () => {
		setAdding(false);
		setNewComment("");
		setNewKeys("");
		setNewContent("");
		setNewConstant(false);
		setNewOrder("100");
	};

	const addEntry = () =>
		run(async () => {
			const order = Number.parseInt(newOrder, 10);
			const r = await apiPost<{ duplicate?: boolean }>("/api/lorebook/entry", {
				...scope,
				comment: newComment.trim(),
				content: newContent,
				keys: parseKeyLine(newKeys),
				constant: newConstant,
				order: Number.isFinite(order) ? order : 100,
			});
			resetAddForm();
			reload(); bumpWatchPanels();
			if (r.duplicate) toast("warning", "正文与本书已有条目重复，未重复写入");
		}, "条目已添加");

	const filtered = useMemo(() => {
		const list = data?.entries ?? [];
		const q = query.trim().toLowerCase();
		const out = list.filter(
			(e) =>
				!q ||
				e.comment.toLowerCase().includes(q) ||
				e.keys.some((k) => k.toLowerCase().includes(q)) ||
				(e.content ?? e.preview).toLowerCase().includes(q) ||
				e.secondaryKeys.some((k) => k.toLowerCase().includes(q)),
		);
		if (sort === "name") out.sort((a, b) => (a.comment || a.keys[0] || "").localeCompare(b.comment || b.keys[0] || ""));
		else if (sort === "chars") out.sort((a, b) => b.chars - a.chars);
		else if (sort === "order") out.sort((a, b) => a.order - b.order || (a.comment || "").localeCompare(b.comment || ""));
		return out;
	}, [data, query, sort]);

	const titleName =
		data?.viewName ?? (view?.kind === "agent" ? "agent 补充设定" : view?.kind === "file" ? "…" : "未选择");

	return (
		<div>
			<PanelStatus loading={loading || (!!view && !data && !error)} error={error} hasData={!!data && !!view} />
			{!view && <div className="sp-empty">点上方书名查看该本条目</div>}
			{view && data && (
				<>
					<section className="sp-section">
						<h4>检索测试</h4>
						<div className="field-hint">下方过滤当前书全部条目的标题、关键词和全文（包括停用项）；回车测当前卡内书 + 已挂载书 + 补充设定的有效检索，停用项不命中。</div>
						<SearchInput
							value={query}
							onChange={(v) => {
								searchRequest.current += 1;
								setQuery(v);
								setHits(null); setSearching(false);
							}}
							placeholder="过滤当前书条目 / 回车测会话检索…"
							onEnter={() => void doSearch()}
						/>
						{searching && <div className="sp-empty">检索中…</div>}
						{hits !== null && !searching && (
							<div className="lore-hits">
								{hits.length === 0 && <div className="sp-empty">无命中——这个说法模型也检索不到。</div>}
								{hits.map((h, i) => (
									<details key={i} className="lore-hit">
										<summary>
											{h.comment || h.keys[0]}
											<span className="lore-meta">score {h.score}</span>
										</summary>
										<div className="longtext">{h.preview}</div>
									</details>
								))}
							</div>
						)}
					</section>

					<section className="sp-section">
						<h4>
							条目 · {titleName}
							<span className="lore-meta" style={{ marginLeft: 8, fontWeight: 400 }}>
								{filtered.length === data.total ? `共 ${data.total} 条` : `筛选 ${filtered.length} / ${data.total}`}
							</span>
						</h4>
						<div className="field-hint">
							仅当前书，不合并其它挂载。
							<span className="lore-light lore-light-green lore-light-inline" /> 绿灯常驻 ·{" "}
							<span className="lore-light lore-light-blue lore-light-inline" /> 蓝灯关键词
						</div>
						<div className="panel-row list-toolbar">
							<select className="panel-search" value={sort} onChange={(e) => setSort(e.target.value as LoreSort)} aria-label="排序">
								<option value="order">优先级 order</option>
								<option value="book">书内顺序</option>
								<option value="name">按标题</option>
								<option value="chars">按字数</option>
							</select>
							<button
								className="drawer-btn"
								onClick={() => {
									setExpanded((v) => !v);
									setExpandTick((t) => t + 1);
								}}
							>
								{expanded ? "全部收起" : "全部展开"}
							</button>
						</div>
						<div className="panel-row list-toolbar">
							<ConfirmButton disabled={busy || filtered.length === 0} confirmText="确认启用筛选项" onConfirm={() => void toggleFiltered(true)}>启用筛选项</ConfirmButton>
							<ConfirmButton disabled={busy || filtered.length === 0} confirmText="确认停用筛选项" onConfirm={() => void toggleFiltered(false)}>停用筛选项</ConfirmButton>
						</div>
						{view.kind === "card" ? <div className="field-hint">当前卡内条目直接写回卡文件。新增设定可选上方 agent 补充设定，不必复制或另挂内嵌书。</div> : !adding ? (
							<button className="drawer-btn" disabled={busy} onClick={() => setAdding(true)}>
								＋ 新增条目
							</button>
						) : (
							<div className="lore-edit lore-add-form">
								<div className="field-hint">写进「{titleName}」。关键词留空会自动按标题生成。</div>
								<Field label="标题">
									<input
										className="panel-search"
										placeholder="如：南阳城 · 宵禁"
										value={newComment}
										autoFocus
										onChange={(ev) => setNewComment(ev.target.value)}
									/>
								</Field>
								<div className="panel-row lore-edit-row">
									<Field label="类型">
										<select
											className="panel-search"
											value={newConstant ? "constant" : "keyed"}
											onChange={(ev) => setNewConstant(ev.target.value === "constant")}
										>
											<option value="keyed">蓝灯 · 关键词</option>
											<option value="constant">绿灯 · 常驻</option>
										</select>
									</Field>
									<Field label="优先级 order" hint="越小越靠前">
										<input
											className="panel-search lore-order-input"
											type="number"
											min={0}
											max={9999}
											value={newOrder}
											onChange={(ev) => setNewOrder(ev.target.value)}
										/>
									</Field>
								</div>
								<Field label="关键词" hint={newConstant ? "常驻条目不靠关键词触发；填了可供检索" : "逗号 / 顿号分隔；留空则按标题生成"}>
									<input className="panel-search" value={newKeys} onChange={(ev) => setNewKeys(ev.target.value)} placeholder="如：南阳、宵禁" />
								</Field>
								<Field label="正文">
									<textarea
										className="panel-search lore-content-edit"
										rows={8}
										placeholder="这条设定的具体内容…"
										value={newContent}
										onChange={(ev) => setNewContent(ev.target.value)}
									/>
								</Field>
								<div className="panel-row">
									<button
										type="button"
										className="drawer-btn save-btn"
										disabled={busy || !newComment.trim() || !newContent.trim()}
										onClick={addEntry}
									>
										添加
									</button>
									<button type="button" className="drawer-btn" disabled={busy} onClick={resetAddForm}>
										取消
									</button>
								</div>
							</div>
						)}
						{filtered.length === 0 && <div className="sp-empty">此书无匹配条目。</div>}
						{filtered.slice(0, limit).map((e) => (
							<EntryRow
								key={`${viewKey}:${e.fingerprint}:${e.entryKey ?? e.uid ?? ""}`}
								e={e}
								scope={scope!}
								busy={busy}
								expandTick={expandTick}
								expanded={expanded}
								onToggle={toggle}
								onPatch={patch}
								onDelete={removeEntry}
							/>
						))}
						{filtered.length > limit && (
							<button className="drawer-btn" onClick={() => setLimit((n) => n + 40)}>
								显示更多（还有 {filtered.length - limit} 条）
							</button>
						)}
					</section>
				</>
			)}
		</div>
	);
}

/** 条目编辑态按明确来源/卡修订隔离，换卡不沿用旧全文、搜索结果或编辑表单。 */
export function LorebookPanel({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [view, setView] = useState<ViewTarget | null>(null);
	return <div className="panel-body">
		<BooksSection toast={toast} view={view} onView={setView} onMountChanged={bumpWatchPanels} />
		<LoreEntries key={!view ? "none" : view.kind === "file" ? `file:${view.path}` : `${view.kind}:${view.cardPath}`} toast={toast} view={view} />
	</div>;
}
