import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiGet } from "../api.ts";
import type { WireMsg } from "../wire.ts";
import { Bubble, ReadOnlyMessagesContext, type SkinProp } from "./Messages.tsx";
import "../real-tests.css";

interface Check { title: string; status: string; detail?: string }
interface Summary {
	id: string; title: string; cardName: string; createdAt: string; status: string;
	description?: string; checks?: Check[]; recordScope?: "full-turn" | "output-recovery";
}
interface Detail extends Summary {
	readOnly: true; userName: string; messages: WireMsg[]; skin?: SkinProp | null;
	raw?: Array<{ label: string; text: string }>; notes?: string[];
	states?: Array<{ label: string; state: unknown }>;
}
const label = (s: string) => ({ passed: "已验证", partial: "有降级/待复核", failed: "失败记录", pending: "待评判" }[s] ?? s);

/** Read-only full-screen reader: never switches the active card/session or submits prompts. */
export function RealTestRecords({ compact = false }: { compact?: boolean }) {
	const [records, setRecords] = useState<Summary[]>([]);
	const [selected, setSelected] = useState<Detail | null>(null);
	const [open, setOpen] = useState(false);
	const [catalogOpen, setCatalogOpen] = useState(true);
	const [error, setError] = useState("");
	const [listLoading, setListLoading] = useState(false);
	const [detailLoading, setDetailLoading] = useState(false);
	const [raw, setRaw] = useState(false);
	const dialogRef = useRef<HTMLElement>(null);
	const viewRef = useRef<HTMLElement>(null);
	const returnRef = useRef<HTMLButtonElement>(null);
	const catalogButtonRef = useRef<HTMLButtonElement>(null);
	const listRequest = useRef(0);
	const detailRequest = useRef(0);
	const titleId = useId();
	const catalogId = useId();

	const close = useCallback(() => {
		// Late GET responses cannot reopen a record after returning to the conversation.
		listRequest.current++;
		detailRequest.current++;
		setOpen(false);
		setSelected(null);
		setCatalogOpen(true);
		setRaw(false);
		setError("");
		setListLoading(false);
		setDetailLoading(false);
	}, []);

	const load = useCallback(async () => {
		const request = ++listRequest.current;
		setListLoading(true);
		setError("");
		try {
			const result = await apiGet<{ records: Summary[] }>("/api/real-tests", { bypassCache: true });
			if (request === listRequest.current) setRecords(result.records);
		} catch (e) {
			if (request === listRequest.current) setError(String(e));
		} finally {
			if (request === listRequest.current) setListLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		void load();
		return () => { listRequest.current++; detailRequest.current++; };
	}, [open, load]);

	useEffect(() => {
		if (!open) return;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousOverflow = document.body.style.overflow;
		const overlay = dialogRef.current?.parentElement;
		// The portal escapes transformed/scrolling sidebars; inert also hides the covered UI from keyboard/AT.
		const background = Array.from(document.body.children)
			.filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
			.map(element => ({ element, inert: element.inert }));
		for (const { element } of background) element.inert = true;
		document.body.style.overflow = "hidden";
		returnRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			} else if (event.key === "Tab") {
				const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex="-1"])',
				) ?? []).filter(node => node.getClientRects().length > 0 && !node.closest("[inert]"));
				const first = nodes[0], last = nodes[nodes.length - 1];
				if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
					event.preventDefault(); last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault(); first?.focus();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
			for (const { element, inert } of background) element.inert = inert;
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, [open, close]);

	useEffect(() => {
		if (!selected) return;
		viewRef.current?.scrollTo({ top: 0 });
		catalogButtonRef.current?.focus({ preventScroll: true });
	}, [selected]);

	const choose = async (id: string) => {
		const request = ++detailRequest.current;
		setDetailLoading(true);
		setError("");
		try {
			const result = await apiGet<Detail>(`/api/real-tests/${encodeURIComponent(id)}`, { bypassCache: true });
			if (request !== detailRequest.current) return;
			setSelected(result);
			setRaw(false);
			setCatalogOpen(false);
		} catch (e) {
			if (request === detailRequest.current) setError(String(e));
		} finally {
			if (request === detailRequest.current) setDetailLoading(false);
		}
	};
	const hideCatalog = () => {
		setCatalogOpen(false);
		catalogButtonRef.current?.focus({ preventScroll: true });
	};

	return <>
		<button type="button" className="drawer-btn real-tests-open" onClick={() => setOpen(true)}>
			{compact ? "实战记录" : "查看实战记录（含正文与格式）"}
		</button>
		{open && createPortal(
			<div className="rt-backdrop">
				<section ref={dialogRef} className="rt-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
					<header className="rt-header">
						<button ref={returnRef} type="button" className="rt-button rt-return" onClick={close}><span aria-hidden="true">← </span>返回梨园</button>
						<div className="rt-reader-heading">
							<h1 id={titleId} title={selected?.title}>{selected?.title ?? "实战记录"}</h1>
							<span>{selected ? `${selected.cardName} · 只读阅读` : "只读查看，不改变当前会话"}</span>
						</div>
						{selected && <div className="rt-header-actions">
							<button ref={catalogButtonRef} type="button" className="rt-button" aria-expanded={catalogOpen} aria-controls={catalogId} onClick={() => setCatalogOpen(!catalogOpen)}>
								{catalogOpen ? "收起目录" : "选择记录"}
							</button>
							<button type="button" className="rt-button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? "查看实际渲染" : "查看原始正文/格式"}</button>
						</div>}
					</header>
					{error && <p className="rt-feedback rt-error" role="alert">{error}</p>}
					{(listLoading || detailLoading) && <p className="rt-feedback" role="status">正在读取记录…</p>}
					<div className="rt-layout">
						{selected && catalogOpen && <button type="button" className="rt-catalog-shade" tabIndex={-1} aria-label="收起记录目录" onClick={hideCatalog} />}
						{(!selected || catalogOpen) && <aside id={catalogId} className={`rt-catalog${selected ? " is-overlay" : ""}`} aria-label="记录目录">
							<div className="rt-catalog-heading"><h2>{selected ? "选择记录" : "选择一条实战记录"}</h2><button type="button" className="rt-button" disabled={listLoading} onClick={() => void load()}>刷新记录</button></div>
							{!selected && <p className="rt-note">选择后进入全屏阅读。正文、原卡格式和检查结果均可查看，不会替换当前角色卡或会话。</p>}
							<div className="rt-record-grid">{records.map(record => <button type="button" key={record.id} className={`rt-record${selected?.id === record.id ? " selected" : ""}`} aria-current={selected?.id === record.id ? "true" : undefined} onClick={() => void choose(record.id)}>
								<strong>{record.title}</strong><span>{record.cardName}{record.recordScope === "output-recovery" || record.id === "confirmed-output-recovery" ? " · 仅输出补全专项" : ""}</span>
								<small><span className="rt-status" data-status={record.status}>{label(record.status)}</span> · {new Date(record.createdAt).toLocaleString()}</small>
							</button>)}</div>
							{!listLoading && !records.length && <p className="rt-empty">暂无已发布实战记录。</p>}
						</aside>}
						{selected && <main ref={viewRef} className="rt-view" inert={catalogOpen} aria-label="记录正文">
							<div className="rt-content">
								{(selected.recordScope === "output-recovery" || selected.id === "confirmed-output-recovery") && <p className="rt-note">这是供应商截断后的正文补全专项，不是完整直出回合；未测试卡格式、穿插图片、行动选项或领域结算。请查看完整回合记录比较两种模式。</p>}
								<details key={selected.id} className="rt-review">
									<summary>说明与检查结果 <span className="rt-status" data-status={selected.status}>{label(selected.status)}</span></summary>
									{selected.description && <p>{selected.description}</p>}
									<p className="rt-note">与对话使用相同卡皮肤与正文渲染组件。论坛、小剧场、状态栏和选项属于原卡展示格式；可切换原始正文/格式核对。此处无重Roll、修改或发送操作。</p>
									<div className="rt-checks">{selected.checks?.map((check, i) => <p key={i}><b>{label(check.status)} · {check.title}</b>{check.detail && <span>{check.detail}</span>}</p>)}</div>
									{selected.notes?.map((note, i) => <p className="rt-note" key={i}>{note}</p>)}
									{!!selected.states?.length && <details className="rt-state-check"><summary>核对当拍权威账本（时间、地点、物品和数值）</summary>{selected.states.map((item, i) => <div key={i}><b>{item.label}</b><pre>{JSON.stringify(item.state, null, 2)}</pre></div>)}</details>}
								</details>
								{raw ? <div className="rt-raw">{selected.raw?.length ? selected.raw.map((item, i) => <details key={`${selected.id}-${i}`} open><summary>{item.label}</summary><pre>{item.text}</pre></details>) : <p className="rt-empty">此记录未保存独立的原始文本，请查看实际渲染。</p>}</div> : <ReadOnlyMessagesContext.Provider value={true}><div className="rt-messages">{selected.messages.map((message, i) => <Bubble key={`${selected.id}-${i}`} msg={message} floor={i + 1} fallbackName={message.channel === "user" ? selected.userName : selected.cardName} skin={selected.skin} onCopy={text => void navigator.clipboard?.writeText(text)} />)}</div></ReadOnlyMessagesContext.Provider>}
							</div>
						</main>}
					</div>
				</section>
			</div>, document.body,
		)}
	</>;
}
