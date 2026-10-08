import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { IconClose, IconRefresh } from "./icons.tsx";
import "./DatabasePluginManager.css";

type Binding = { scopeKey: string; sourceEntryId: string; sha256: string; modelRevision?: string; streaming: boolean };
type Status = { sourceReady: boolean; config: { enabled: boolean } };
type View = { phase: "checking" | "loading" | "ready" | "missing" | "error"; error?: string; binding?: Binding; enabled?: boolean };
const keyOf = (binding: Binding) => `${binding.scopeKey}:${binding.sourceEntryId}:${binding.sha256}:${binding.modelRevision ?? ""}`;

/** Presents the unchanged upstream frontend; this is not a second table editor or memory implementation. */
export function DatabasePluginManager({ onClose, busy, contextTick }: { onClose: () => void; busy: boolean; contextTick: number }) {
	const [attempt, setAttempt] = useState(0);
	const [view, setView] = useState<View>({ phase: "checking" });
	const frameRef = useRef<HTMLIFrameElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const viewRef = useRef(view);
	viewRef.current = view;

	useEffect(() => {
		const previous = document.activeElement;
		const siblings = Array.from(dialogRef.current?.parentElement?.children ?? [])
			.filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialogRef.current)
			.map(element => ({ element, inert: element.inert }));
		// Keep the conversation inert while this workspace is open, without cross-frame focus loops.
		for (const { element } of siblings) element.inert = true;
		closeRef.current?.focus();
		return () => {
			for (const { element, inert } of siblings) element.inert = inert;
			if (previous instanceof HTMLElement && previous.isConnected && previous.offsetParent !== null) previous.focus();
			else document.querySelector<HTMLButtonElement>(".database-entry")?.focus();
		};
	}, []);

	useEffect(() => {
		let active = true;
		setView({ phase: "checking" });
		void Promise.all([api<Status>("/api/database-plugin/status"), api<Binding>("/api/database-plugin/binding")]).then(([status, binding]) => {
			if (!active) return;
			setView({ phase: status.sourceReady ? "loading" : "missing", binding, enabled: status.config.enabled });
		}).catch(error => { if (active) setView({ phase: "error", error: error instanceof Error ? error.message : "数据库状态读取失败" }); });
		return () => { active = false; };
	}, [attempt]);

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || !frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return;
			if (event.data?.type === "liyuan-database-ready") {
				setView(current => current.phase === "loading" ? { ...current, phase: "ready" } : current);
			} else if (event.data?.type === "liyuan-database-error") {
				setView(current => ({ ...current, phase: "error", error: String(event.data.message ?? "原插件管理界面未能打开").slice(0, 800) }));
			}
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, []);

	// Check only a small binding record, never repeatedly download thousand-floor history.
	useEffect(() => {
		let active = true, inFlight = false;
		const check = async () => {
			if (inFlight || !viewRef.current.binding || document.hidden) return;
			inFlight = true;
			try {
				const next = await api<Binding>("/api/database-plugin/binding");
				if (!active) return;
				const previous = viewRef.current.binding;
				if (previous && keyOf(next) !== keyOf(previous)) {
					// Remove the old frame immediately. Its late messages cannot mark the new frame ready.
					setView({ phase: "checking" });
					setAttempt(value => value + 1);
				} else setView(current => current.binding ? { ...current, binding: next } : current);
			} catch (error) {
				if (active) setView(current => ({ ...current, phase: "error", error: error instanceof Error ? error.message : "数据库作用域检查失败" }));
			} finally { inFlight = false; }
		};
		void check();
		const timer = window.setInterval(() => { void check(); }, 2500);
		const wake = () => { void check(); };
		window.addEventListener("focus", wake);
		document.addEventListener("visibilitychange", wake);
		return () => { active = false; clearInterval(timer); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
	}, [contextTick, attempt]);

	useEffect(() => {
		if (view.phase !== "loading") return;
		const timer = window.setTimeout(() => setView(current => current.phase === "loading" ? { ...current, phase: "error", error: "原插件管理界面加载超时，请刷新重试；不会假称记忆已保存。" } : current), 65000);
		return () => clearTimeout(timer);
	}, [view.phase, attempt]);

	const previousBusy = useRef(busy);
	useEffect(() => {
		const becameIdle = previousBusy.current && !busy;
		previousBusy.current = busy;
		if (becameIdle) { setView({ phase: "checking" }); setAttempt(value => value + 1); }
	}, [busy]);

	const refresh = () => { setView({ phase: "checking" }); setAttempt(value => value + 1); };
	const readOnly = busy || view.binding?.streaming === true;
	const frameVisible = !!view.binding && ["loading", "ready"].includes(view.phase);
	const src = view.binding ? `/database-plugin-host.html?view=manager&scopeKey=${encodeURIComponent(view.binding.scopeKey)}&sourceEntryId=${encodeURIComponent(view.binding.sourceEntryId)}&hostSource=${encodeURIComponent(view.binding.sha256)}` : "";

	return <div ref={dialogRef} className="database-manager-backdrop">
	<div className="database-manager" role="dialog" aria-modal="true" aria-label="数据库管理台" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
		<header className="database-manager__header">
			<div className="database-manager__heading"><h2>数据库管理台</h2><span>原插件完整前端 · 当前会话／角色卡／分支</span></div>
			<div className="database-manager__actions">
				<button type="button" onClick={refresh} title="重新加载会丢弃尚未保存的原插件草稿"><IconRefresh size={16} />刷新</button>
				<a href="/database-plugin-host.html?view=manager" target="_blank" rel="noopener noreferrer">独立打开</a>
				<button ref={closeRef} type="button" onClick={onClose} aria-label="返回对话"><IconClose size={16} />返回对话</button>
			</div>
		</header>
		<div className="database-manager__hint">人物、纪要：原「填表工作台」→「可视化表格编辑器」。首次填表前可能为空，可在原「数据管理」导入；不会自动收费重填全历史。梨园模型预设复用现有连接，密钥由服务端管理。</div>
		{view.enabled === false && <div className="database-manager__notice">当前自动记忆后端未启用，管理数据仍保留；可在设置→上游数据库插件启用。</div>}
		{readOnly && <div className="database-manager__notice" role="status">正文正在生成，管理台暂时只读，生成结束后可继续操作。</div>}
		<div className="database-manager__body">
			{frameVisible && <iframe ref={frameRef} key={`${attempt}:${keyOf(view.binding!)}`} title="原数据库插件管理台" inert={readOnly} src={src} />}
			{view.phase !== "ready" && <div className="database-manager__state" role={view.phase === "error" ? "alert" : "status"}>
				{view.phase === "checking" || view.phase === "loading" ? <p>正在加载原数据库完整管理界面…</p> : view.phase === "missing" ? <><h3>尚未安装已核验的数据库源码</h3><p>请在设置→上游数据库插件安装固定版本，再打开管理台。不会自动下载未知版本。</p></> : <><h3>数据库管理台未能打开</h3><p>{view.error}</p></>}
				{(view.phase === "error" || view.phase === "missing") && <button type="button" onClick={refresh}>重新读取／重试</button>}
			</div>}
			{readOnly && view.phase === "ready" && <div className="database-manager__readonly" aria-label="生成期间暂停管理操作" />}
		</div>
	</div>
	</div>;
}
