/**
 * 设置面板：外观（昼夜）+ 世界书扫描 + agent 行为 + 内置向量记忆。
 * 主题立刻生效、只存本机 localStorage，不写 rp.config。
 * 记忆配置写 `.liyuan-memory/config.json`，不必重载 agent。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiGet, apiPut, type ModelRef, type ModelsResponse, type RpConfigView, type SideModelStep, type StepModelOverrides } from "../api.ts";
import type { GenerationMode } from "../generation-mode.ts";
import { getTheme, setTheme, type ThemeMode } from "../theme.ts";
import { PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";
import { GenerationModeControl } from "./GenerationModeControl.tsx";
import { ModelPlugSelector } from "./ModelPlugSelector.tsx";
import { WorldProfileSection } from "./WorldProfileSection.tsx";
import { DatabasePluginPanel } from "./DatabasePluginPanel.tsx";

type MemoryStoreStats = {
	id: string;
	name: string;
	kind: string;
	enabled: boolean;
	everyNTurns: number;
	chunkCount: number;
	maxChunks: number;
};

type MemoryStatus = {
	config: {
		enabled: boolean;
		searchTopK: number;
		injectOnTurn?: boolean;
		embedMode?: "local" | "cloud";
		cloudEmbed?: { baseUrl: string; apiKey: string; model: string };
		cloudEmbedConfigured?: boolean;
		stores: Array<{ id: string; everyNTurns: number; enabled: boolean }>;
	};
	stores: MemoryStoreStats[];
	/** 当前对话作用域（角色卡 + 会话） */
	scope?: { sessionId: string; card?: string; scopeId: string };
};

type NovelAiStatus = {
	config: {
		enabled: boolean; baseUrl: string; apiKey: string; apiKeyConfigured: boolean;
		model: string; sampler: string; scheduler: string; steps: number; scale: number;
		cfgRescale: number; width: number; height: number; positivePrefix: string;
		positiveSuffix: string; negativePrompt: string;
	};
};

function NovelAiSection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<NovelAiStatus>("/api/novelai"), { cacheKey: "/api/novelai" });
	const { busy, run } = useAction(toast);
	const [form, setForm] = useState<NovelAiStatus["config"] | null>(null);
	useEffect(() => { if (data) setForm(data.config); }, [data]);
	if (loading && !form) return <section className="sp-section"><h4>NovelAI 生图</h4><div className="sp-empty">读取中…</div></section>;
	if (error || !form) return <section className="sp-section"><h4>NovelAI 生图</h4><div className="sp-empty">{error || "配置不可用"}</div></section>;
	const set = (patch: Partial<NovelAiStatus["config"]>) => setForm((current) => current ? { ...current, ...patch } : current);
	const save = () => run(async () => {
		await apiPut("/api/novelai", form);
		await reload();
	}, "NovelAI 配置已保存");
	return <section className="sp-section">
		<h4>NovelAI 生图</h4>
		<div className="toggle-row"><span>启用剧情图片按钮</span><Toggle checked={form.enabled} onChange={(enabled) => set({ enabled })} /></div>
		<label className="field-label">API Key</label>
		<input className="field-input" type="password" value={form.apiKey === "••••••••" ? "" : form.apiKey} placeholder={form.apiKeyConfigured ? "已配置，留空保持不变" : "NovelAI API Key"} onChange={(event) => set({ apiKey: event.target.value })} />
		<label className="field-label">接口地址</label><input className="field-input" value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} />
		<label className="field-label">模型</label><input className="field-input" value={form.model} onChange={(event) => set({ model: event.target.value })} />
		<div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
			<label>宽度<input className="field-input" type="number" step="64" value={form.width} onChange={(event) => set({ width: Number(event.target.value) })} /></label>
			<label>高度<input className="field-input" type="number" step="64" value={form.height} onChange={(event) => set({ height: Number(event.target.value) })} /></label>
			<label>步数<input className="field-input" type="number" value={form.steps} onChange={(event) => set({ steps: Number(event.target.value) })} /></label>
			<label>CFG<input className="field-input" type="number" step="0.1" value={form.scale} onChange={(event) => set({ scale: Number(event.target.value) })} /></label>
		</div>
		<label className="field-label">固定正面提示词</label><textarea className="field-input" rows={3} value={form.positivePrefix} onChange={(event) => set({ positivePrefix: event.target.value })} />
		<label className="field-label">固定负面提示词</label><textarea className="field-input" rows={3} value={form.negativePrompt} onChange={(event) => set({ negativePrompt: event.target.value })} />
		<div className="field-hint">已从智慧姬迁移。模型回复中的 &lt;image&gt; 会显示为按钮，点击后才调用 API 和扣点。</div>
		<button className="drawer-btn primary" disabled={busy} onClick={save}>保存 NovelAI 配置</button>
	</section>;
}

type MemoryChunkRow = {
	id: string;
	text: string;
	textLen: number;
	meta?: { source?: string; title?: string; fileName?: string; mergeCount?: number };
	createdAt: string;
};

/** 条目管理列表：刷新 + 单条删除 */
function MemoryChunkManager({
	storeId,
	label,
	enabled,
	busy,
	run,
	toast,
	onChanged,
}: {
	storeId: string;
	label: string;
	enabled: boolean;
	busy: boolean;
	run: (fn: () => Promise<void>, doneText?: string) => Promise<void>;
	toast: (level: "info" | "warning" | "error", text: string) => void;
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [chunks, setChunks] = useState<MemoryChunkRow[]>([]);
	const [loading, setLoading] = useState(false);

	const refresh = async () => {
		setLoading(true);
		try {
			const r = await apiGet<{ chunks: MemoryChunkRow[] }>(
				`/api/memory/chunks?storeId=${encodeURIComponent(storeId)}`,
			);
			setChunks(r.chunks ?? []);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (open) void refresh();
	}, [open, storeId]);

	const del = (id: string) =>
		run(async () => {
			await api("/api/memory/chunk/delete", {
				method: "POST",
				body: JSON.stringify({ storeId, id }),
			});
			setChunks((cs) => cs.filter((c) => c.id !== id));
			onChanged();
		}, "已删除条目");

	return (
		<div className="memory-chunk-mgr" style={{ marginTop: 8 }}>
			<div className="access-actions" style={{ gap: 8 }}>
				<button
					type="button"
					className="drawer-btn"
					disabled={!enabled}
					onClick={() => setOpen((v) => !v)}
				>
					{open ? "收起条目" : `管理「${label}」条目`}
				</button>
				{open ? (
					<button type="button" className="drawer-btn" disabled={busy || loading} onClick={() => void refresh()}>
						刷新列表
					</button>
				) : null}
			</div>
			{open && (
				<div className="memory-chunk-list">
					{loading && !chunks.length ? <div className="field-hint">加载中…</div> : null}
					{!loading && chunks.length === 0 ? <div className="field-hint">暂无条目</div> : null}
					<ul className="memory-hits">
						{chunks.map((c) => {
							const src =
								c.meta?.source === "import"
									? "导入"
									: c.meta?.source === "manual"
										? "手动"
										: c.meta?.source === "narrative"
											? "剧情"
											: c.meta?.source || "";
							const title = c.meta?.title || c.meta?.fileName || "";
							const merge = c.meta?.mergeCount && c.meta.mergeCount > 1 ? ` · 合并×${c.meta.mergeCount}` : "";
							return (
								<li key={c.id} className="memory-chunk-item">
									<div className="memory-chunk-meta">
										<span className="memory-score">
											{src}
											{title ? ` · ${title}` : ""}
											{merge} · {c.textLen}字
										</span>
										<button
											type="button"
											className="drawer-btn"
											disabled={busy}
											onClick={() => void del(c.id)}
											style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
										>
											删除
										</button>
									</div>
									<div className="memory-chunk-text">
										{c.text.slice(0, 220)}
										{c.text.length > 220 ? "…" : ""}
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}

/** 内置向量记忆：剧情库（agent 合并）+ 额外库（导入/手动 + 条目管理） */
function MemorySection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<MemoryStatus>("/api/memory"), {
		cacheKey: "/api/memory",
	});
	const { busy, run } = useAction(toast);
	const [open, setOpen] = useState(false);
	const [enabled, setEnabled] = useState(false);
	const [searchTopK, setSearchTopK] = useState(5);
	const [injectOnTurn, setInjectOnTurn] = useState(true);
	const [embedMode, setEmbedMode] = useState<"local" | "cloud">("local");
	const [cloudBase, setCloudBase] = useState("https://api.openai.com/v1");
	const [cloudKey, setCloudKey] = useState("");
	const [cloudModel, setCloudModel] = useState("text-embedding-3-small");
	const [keyConfigured, setKeyConfigured] = useState(false);
	const [narrativeEvery, setNarrativeEvery] = useState(3);
	const [narrativeOn, setNarrativeOn] = useState(true);
	const [externalOn, setExternalOn] = useState(true);
	const [probeQ, setProbeQ] = useState("");
	const [probeHits, setProbeHits] = useState<Array<{ text: string; score: number }>>([]);
	const [manualText, setManualText] = useState("");
	const [manualTitle, setManualTitle] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!data) return;
		setEnabled(data.config.enabled);
		setSearchTopK(data.config.searchTopK);
		setInjectOnTurn(data.config.injectOnTurn !== false);
		setEmbedMode(data.config.embedMode === "cloud" ? "cloud" : "local");
		setCloudBase(data.config.cloudEmbed?.baseUrl || "https://api.openai.com/v1");
		setCloudModel(data.config.cloudEmbed?.model || "text-embedding-3-small");
		setKeyConfigured(data.config.cloudEmbedConfigured === true);
		setCloudKey("");
		const nar = data.stores.find((s) => s.id === "narrative");
		const ext = data.stores.find((s) => s.id === "external");
		if (nar) {
			setNarrativeOn(nar.enabled);
			setNarrativeEvery(nar.everyNTurns);
		}
		if (ext) setExternalOn(ext.enabled);
		if (data.config.enabled) setOpen(true);
	}, [data]);

	const save = () =>
		run(async () => {
			await apiPut("/api/memory", {
				enabled,
				searchTopK,
				injectOnTurn,
				embedMode,
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
				stores: [
					{ id: "narrative", enabled: narrativeOn, everyNTurns: narrativeEvery },
					{ id: "external", enabled: externalOn },
				],
			});
			reload();
		}, "记忆设置已保存");

	const probeEmbed = () =>
		run(async () => {
			await apiPut("/api/memory", {
				embedMode: "cloud",
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
			});
			const r = await api<{ ok: boolean; dim?: number; error?: string }>("/api/memory/probe-embed", {
				method: "POST",
				body: "{}",
			});
			if (!r.ok) throw new Error(r.error || "探测失败");
			reload();
		}, "云端 embedding 正常");

	const clearStore = (storeId: string, label: string) =>
		run(async () => {
			await api("/api/memory/clear", { method: "POST", body: JSON.stringify({ storeId }) });
			reload();
		}, `已清空「${label}」`);

	const reembedAll = () =>
		run(async () => {
			await apiPut("/api/memory", {
				enabled,
				searchTopK,
				injectOnTurn,
				embedMode,
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
				stores: [
					{ id: "narrative", enabled: narrativeOn, everyNTurns: narrativeEvery },
					{ id: "external", enabled: externalOn },
				],
			});
			const r = await api<{
				totalUpdated?: number;
				totalChunks?: number;
				mode?: string;
				model?: string;
			}>("/api/memory/reembed", {
				method: "POST",
				body: "{}",
			});
			reload();
			const n = r.totalUpdated ?? 0;
			const t = r.totalChunks ?? 0;
			if (t === 0) toast("info", "当前对话库为空，无需重向量化");
			else toast("info", `重向量化完成：${n}/${t} 条（${r.mode === "cloud" ? r.model : "本地"}）`);
		});

	const retryLatest = () =>
		run(async () => {
			await api("/api/memory/retry-latest", { method: "POST", body: "{}" });
			reload();
		}, "最近一轮已重新向量化入库");

	const onImportFile = async (file: File) => {
		const text = await file.text();
		await run(async () => {
			await api("/api/memory/import", {
				method: "POST",
				body: JSON.stringify({ storeId: "external", text, fileName: file.name }),
			});
			reload();
		});
	};

	const manualAdd = () =>
		run(async () => {
			const text = manualText.trim();
			if (text.length < 8) throw new Error("内容太短");
			await api("/api/memory/manual", {
				method: "POST",
				body: JSON.stringify({
					text,
					title: manualTitle.trim() || undefined,
					storeId: "external",
				}),
			});
			setManualText("");
			reload();
		});

	const probe = () =>
		run(async () => {
			const r = await api<{ hits: Array<{ text: string; score: number }> }>("/api/memory/search", {
				method: "POST",
				body: JSON.stringify({ storeId: "narrative", query: probeQ, topK: searchTopK }),
			});
			setProbeHits(r.hits ?? []);
		}, "检索完成");

	const narCount = data?.stores.find((s) => s.id === "narrative")?.chunkCount ?? 0;
	const narMax = data?.stores.find((s) => s.id === "narrative")?.maxChunks ?? "—";
	const extCount = data?.stores.find((s) => s.id === "external")?.chunkCount ?? 0;
	const extMax = data?.stores.find((s) => s.id === "external")?.maxChunks ?? "—";

	return (
		<section className="sp-section">
			<h4>嵌入连接与旧记忆库（保留回退）</h4>
			<div className="field-hint">
				按「当前角色卡 + 当前对话」隔离。
				<strong>剧情数据库</strong>仅 agent 自动<strong>合并</strong>入库；
				<strong>额外数据库</strong>用于导入与手动向量化（每段可成条目，可逐条删除）。
			</div>
			{data?.scope?.sessionId ? (
				<div className="field-hint">
					当前库作用域：会话 {data.scope.sessionId.slice(0, 8)}…
					{data.scope.card ? ` · 卡 ${data.scope.card.split(/[/\\]/).pop()}` : ""}
				</div>
			) : null}
			{loading && !data ? <div className="field-hint">加载中…</div> : null}
			{error ? <div className="field-hint" style={{ color: "var(--danger, #c44)" }}>{error}</div> : null}
			<div className="toggle-row">
				<span>启用向量记忆</span>
				<Toggle
					checked={enabled}
					onChange={(v) => {
						setEnabled(v);
						setOpen(v);
					}}
				/>
			</div>
			{(open || enabled) && data && (
				<div className="memory-panel">
					<div className="field-label" style={{ marginBottom: 6 }}>
						嵌入模式
					</div>
					<div className="access-actions" style={{ gap: 8, marginBottom: 8 }}>
						<button
							type="button"
							className={`drawer-btn ${embedMode === "local" ? "save-btn" : ""}`}
							onClick={() => setEmbedMode("local")}
						>
							本地（免模型）
						</button>
						<button
							type="button"
							className={`drawer-btn ${embedMode === "cloud" ? "save-btn" : ""}`}
							onClick={() => setEmbedMode("cloud")}
						>
							云端 embedding
						</button>
					</div>
					<div className="field-hint">
						换模式后用「重向量化」保留原文只重算向量（云端只花 embedding 费）。
					</div>
					{embedMode === "cloud" && (
						<div className="memory-cloud">
							<input
								className="field-input"
								placeholder="Base URL（如 https://api.openai.com/v1）"
								value={cloudBase}
								onChange={(e) => setCloudBase(e.target.value)}
							/>
							<input
								className="field-input"
								type="password"
								placeholder={keyConfigured ? "API Key（已保存，留空不改）" : "API Key"}
								value={cloudKey}
								autoComplete="off"
								onChange={(e) => setCloudKey(e.target.value)}
							/>
							<input
								className="field-input"
								placeholder="模型名（如 text-embedding-3-small）"
								value={cloudModel}
								onChange={(e) => setCloudModel(e.target.value)}
							/>
							<button type="button" className="drawer-btn" disabled={busy} onClick={() => void probeEmbed()}>
								测试 embedding 连接
							</button>
						</div>
					)}
					<div className="access-actions" style={{ marginTop: 8 }}>
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy || !enabled}
							onClick={() => void reembedAll()}
						>
							按当前模式重向量化
						</button>
						<button type="button" className="drawer-btn" disabled={busy || !enabled || !narrativeOn} onClick={() => void retryLatest()}>
							重试最近一轮入库
						</button>
					</div>

					{/* —— 剧情数据库 —— */}
					<div className="toggle-row" style={{ marginTop: 14 }}>
						<span>剧情数据库</span>
						<Toggle checked={narrativeOn} onChange={setNarrativeOn} />
					</div>
					<div className="field-hint">
						条数 {narCount} / {narMax}。仅 agent 自动写入：到轮次后<strong>合并进最后一条</strong>
						（约满 1800 字才新开一条），不接受手动/导入。
					</div>
					{narrativeOn && (
						<SliderField
							label="每隔多少轮助手回复合并入库"
							hint="1=每轮尝试合并；3=每 3 轮。0=不自动写"
							value={narrativeEvery}
							min={0}
							max={20}
							onChange={setNarrativeEvery}
						/>
					)}
					<div className="access-actions">
						<button
							type="button"
							className="drawer-btn"
							disabled={busy}
							onClick={() => clearStore("narrative", "剧情数据库")}
						>
							清空剧情库
						</button>
					</div>
					<MemoryChunkManager
						storeId="narrative"
						label="剧情"
						enabled={enabled}
						busy={busy}
						run={run}
						toast={toast}
						onChanged={reload}
					/>

					{/* —— 额外数据库 —— */}
					<div className="toggle-row" style={{ marginTop: 14 }}>
						<span>额外数据库</span>
						<Toggle checked={externalOn} onChange={setExternalOn} />
					</div>
					<div className="field-hint">
						条数 {extCount} / {extMax}。导入文件会切块成多条；手动向量化短文 1 条、长文多条。可逐条删除。
					</div>
					<div className="access-actions">
						<button type="button" className="drawer-btn" disabled={busy || !enabled} onClick={() => fileRef.current?.click()}>
							导入文本文件
						</button>
						<input
							ref={fileRef}
							type="file"
							accept=".txt,.md,.text,text/plain,text/markdown"
							hidden
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) void onImportFile(f);
								if (fileRef.current) fileRef.current.value = "";
							}}
						/>
						<button type="button" className="drawer-btn" disabled={busy} onClick={() => clearStore("external", "额外数据库")}>
							清空额外库
						</button>
					</div>
					<div className="field-label" style={{ marginTop: 10, marginBottom: 4 }}>
						手动向量化（写入额外库）
					</div>
					<input
						className="field-input"
						placeholder="可选标题"
						value={manualTitle}
						onChange={(e) => setManualTitle(e.target.value)}
						disabled={!enabled || busy}
					/>
					<textarea
						className="field-input"
						placeholder="粘贴要记住的设定/摘录…"
						value={manualText}
						onChange={(e) => setManualText(e.target.value)}
						rows={4}
						disabled={!enabled || busy}
						style={{ resize: "vertical", minHeight: 72 }}
					/>
					<div className="access-actions">
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy || !enabled || manualText.trim().length < 8}
							onClick={() => void manualAdd()}
						>
							写入额外库
						</button>
					</div>
					<MemoryChunkManager
						storeId="external"
						label="额外"
						enabled={enabled}
						busy={busy}
						run={run}
						toast={toast}
						onChanged={reload}
					/>

					<div className="toggle-row" style={{ marginTop: 12 }}>
						<span>每轮自动检索并注入模型</span>
						<Toggle checked={injectOnTurn} onChange={setInjectOnTurn} />
					</div>
					<div className="field-hint">
						开=用户发言后检索剧情库+额外库，以【剧情记忆】注入。关=只入库不注入。
					</div>
					<SliderField
						label="检索 / 注入条数 top-k"
						hint="试检索与每轮注入共用上限"
						value={searchTopK}
						min={1}
						max={15}
						onChange={setSearchTopK}
					/>
					<div className="access-actions" style={{ flexWrap: "wrap", gap: 8 }}>
						<input
							className="field-input"
							placeholder="试检索剧情库…"
							value={probeQ}
							onChange={(e) => setProbeQ(e.target.value)}
							style={{ flex: 1, minWidth: 120 }}
						/>
						<button type="button" className="drawer-btn" disabled={busy || !probeQ.trim() || !enabled} onClick={() => void probe()}>
							检索
						</button>
					</div>
					{probeHits.length > 0 && (
						<ul className="memory-hits">
							{probeHits.map((h, i) => (
								<li key={i}>
									<span className="memory-score">{h.score.toFixed(2)}</span> {h.text.slice(0, 160)}
									{h.text.length > 160 ? "…" : ""}
								</li>
							))}
						</ul>
					)}

					<div className="sticky-save" style={{ marginTop: 12 }}>
						<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>
							保存记忆设置
						</button>
					</div>
				</div>
			)}
		</section>
	);
}

/** 访问密码区：未设置=开放（首次零门槛），设置后全端登录才可用 */
function AccessSection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [required, setRequired] = useState<boolean | null>(null);
	const [oldPw, setOldPw] = useState("");
	const [newPw, setNewPw] = useState("");
	const [newPw2, setNewPw2] = useState("");
	const { busy, run } = useAction(toast);

	useEffect(() => {
		void api<{ required: boolean }>("/api/access/status")
			.then((r) => setRequired(r.required))
			.catch(() => setRequired(false));
	}, []);

	const submit = (turningOff: boolean) =>
		run(async () => {
			if (!turningOff) {
				if (newPw.length < 4) throw new Error("新密码至少 4 位");
				if (newPw !== newPw2) throw new Error("两次输入的新密码不一致");
			}
			const r = await api<{ required: boolean }>("/api/access/set", {
				method: "POST",
				body: JSON.stringify({ oldPassword: oldPw, newPassword: turningOff ? "" : newPw }),
			});
			setRequired(r.required);
			setOldPw("");
			setNewPw("");
			setNewPw2("");
		}, turningOff ? "已关闭访问密码" : "已设置访问密码（其他设备需重新登录）");

	return (
		<section className="sp-section">
			<h4>访问密码</h4>
			<div className="field-hint">
				{required
					? "已开启：所有设备访问本站都需输入密码。修改或关闭需先验证当前密码。"
					: "未开启：任何能连到本站的人都可直接使用。部署到公网 / 局域网共享时建议设置。"}
			</div>
			{required === null ? null : (
				<>
					{required && (
						<input
							className="field-input"
							type="password"
							placeholder="当前密码"
							value={oldPw}
							autoComplete="current-password"
							onChange={(e) => setOldPw(e.target.value)}
						/>
					)}
					<input
						className="field-input"
						type="password"
						placeholder={required ? "新密码（至少 4 位）" : "设置密码（至少 4 位）"}
						value={newPw}
						autoComplete="new-password"
						onChange={(e) => setNewPw(e.target.value)}
					/>
					<input
						className="field-input"
						type="password"
						placeholder="再输一次新密码"
						value={newPw2}
						autoComplete="new-password"
						onChange={(e) => setNewPw2(e.target.value)}
					/>
					<div className="access-actions">
						<button className="drawer-btn save-btn" disabled={busy || !newPw} onClick={() => submit(false)}>
							{required ? "修改密码" : "设置密码"}
						</button>
						{required && (
							<button className="drawer-btn" disabled={busy || !oldPw} onClick={() => submit(true)}>
								关闭密码
							</button>
						)}
					</div>
				</>
			)}
		</section>
	);
}

export function SettingsPanel({
	toast,
	generationMode,
	onGenerationModeChange,
	onConfigGenerationMode,
	onOpenDatabase,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	generationMode: GenerationMode;
	onGenerationModeChange: (mode: GenerationMode) => void;
	onConfigGenerationMode: (mode: unknown) => void;
	onOpenDatabase: () => void;
}) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<{ config: RpConfigView }>("/api/config"), { cacheKey: "/api/config" });
	const modelData = usePanelData(() => apiGet<ModelsResponse>("/api/models/catalog"), { cacheKey: "/api/models/catalog", watchModels: true });

	const [scanDepth, setScanDepth] = useState(4);
	const [maxLore, setMaxLore] = useState(3);
	const [compactEvery, setCompactEvery] = useState(30);
	const [backendControl, setBackendControl] = useState(true);
	const [generationTimeoutMinutes, setGenerationTimeoutMinutes] = useState(60);
	const [analysisTimeoutMinutes, setAnalysisTimeoutMinutes] = useState(10);
	const [analysisRecoveryModel,setAnalysisRecoveryModel] = useState<ModelRef|null>(null);
	const [literaryWorldEnabled, setLiteraryWorldEnabled] = useState(true);
	const [literaryEcologyEnabled, setLiteraryEcologyEnabled] = useState(false);
	const [webResearchMode, setWebResearchMode] = useState<"off" | "auto" | "manual">("off");
	const [stepModels, setStepModels] = useState<StepModelOverrides>({});
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const revisionRef = useRef(0);
	const failedRevisionRef = useRef<number | null>(null);
	const stepModelsDirtyRef = useRef(false);
	const [dark, setDark] = useState(() => getTheme() === "dark");
	const formDisabled = saving;

	useEffect(() => {
		if (data) {
			setScanDepth(data.config.scanDepth);
			setMaxLore(data.config.maxLoreInjections);
			setCompactEvery(data.config.compactEveryNTurns ?? 30);
			setGenerationTimeoutMinutes(data.config.generationTimeoutMinutes ?? 60);
			setAnalysisTimeoutMinutes(data.config.analysisTimeoutMinutes ?? 10);
			setAnalysisRecoveryModel(data.config.analysisRecoveryModel??null);
			setBackendControl(data.config.backendControl !== false);
			onConfigGenerationMode(data.config.generationMode);
			setLiteraryWorldEnabled(data.config.literaryWorldEnabled === true);
			setLiteraryEcologyEnabled(data.config.literaryEcologyEnabled === true);
			setWebResearchMode(data.config.webResearchMode ?? "off");
			setStepModels(data.config.stepModels ?? {});
			stepModelsDirtyRef.current = false;
			setDirty(false);
		}
	}, [data, onConfigGenerationMode]);

	const touch = () => {
		revisionRef.current += 1;
		failedRevisionRef.current = null;
		setDirty(true);
	};

	const onTheme = (on: boolean) => {
		const mode: ThemeMode = on ? "dark" : "light";
		setDark(on);
		setTheme(mode);
		toast("info", on ? "已切换到黑夜模式" : "已切换到白昼模式");
	};

	const save = useCallback(async () => {
		if (!data || !dirty || savingRef.current) return;
		const revision = revisionRef.current;
		if (failedRevisionRef.current === revision) return;
		savingRef.current = true;
		setSaving(true);
		try {
			// 只改本面板可见项；不碰 lorebook / importStripTags（由别处或默认处理）
			await apiPut("/api/config", {
				greeting: true,
				scanDepth,
				maxLoreInjections: maxLore,
				compactEveryNTurns: compactEvery,
				generationTimeoutMinutes, analysisTimeoutMinutes, analysisRecoveryModel,
				backendControl,
				literaryWorldEnabled,
				literaryEcologyEnabled,
				webResearchMode,
				...(stepModelsDirtyRef.current ? { stepModels } : {}),
			});
			if (revisionRef.current === revision) {
				failedRevisionRef.current = null;
				stepModelsDirtyRef.current = false;
				setDirty(false);
				reload();
			}
		} catch (error) {
			if (revisionRef.current === revision) failedRevisionRef.current = revision;
			toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	}, [analysisRecoveryModel, analysisTimeoutMinutes, generationTimeoutMinutes, backendControl, compactEvery, data, dirty, literaryEcologyEnabled, literaryWorldEnabled, maxLore, reload, scanDepth, stepModels, toast, webResearchMode]);

	useEffect(() => {
		if (!data || !dirty || saving || failedRevisionRef.current === revisionRef.current) return;
		const timer = window.setTimeout(() => void save(), 450);
		return () => window.clearTimeout(timer);
	}, [data, dirty, saving, save, generationTimeoutMinutes, analysisTimeoutMinutes, scanDepth, maxLore, compactEvery, backendControl, literaryWorldEnabled, literaryEcologyEnabled, webResearchMode, stepModels]);

	return (
		<div className="panel-body panel-body-sticky" aria-busy={saving} style={saving ? { pointerEvents: "none", opacity: 0.72 } : undefined}>
			<PanelStatus loading={loading} error={error} hasData={!!data} />
			{data && <div className="field-hint">{saving ? "设置自动保存中…" : failedRevisionRef.current === revisionRef.current ? "自动保存失败，请再次修改后重试" : dirty ? "修改将在短暂停止操作后自动保存" : "设置会自动保存"}</div>}
			{modelData.error && <div className="sp-empty">模型清单读取失败：{modelData.error}</div>}
			<section className="sp-section">
				<h4>外观</h4>
				<div className="toggle-row">
					<span>黑夜模式</span>
					<Toggle checked={dark} onChange={onTheme} />
				</div>
				<div className="field-hint">白昼 / 黑夜立刻切换，偏好记在本机浏览器，与会话配置无关。</div>
			</section>
			<AccessSection toast={toast} />
			<DatabasePluginPanel toast={toast} onOpenManager={onOpenDatabase} />
			<MemorySection toast={toast} />
			<NovelAiSection toast={toast} />
			{data && (
				<>
					<section className="sp-section">
						<h4>剧情生成模式</h4>
						<GenerationModeControl value={generationMode} onChange={onGenerationModeChange} />
						<div className="field-hint">固定专家失败会先诊断并通过已配置恢复模型重做；仍失败则停止该阶段，不跳过审阅。</div>
						<label className="field-label">整拍总时间预算（分钟，含结算）</label><input className="field-input" type="number" min={1} max={120} value={generationTimeoutMinutes} disabled={formDisabled} onChange={e=>{setGenerationTimeoutMinutes(Math.max(1,Math.min(120,Number(e.target.value)||60)));touch()}} />
						<label className="field-label">单次分析/结算预算（分钟）</label><input className="field-input" type="number" min={1} max={30} value={analysisTimeoutMinutes} disabled={formDisabled} onChange={e=>{setAnalysisTimeoutMinutes(Math.max(1,Math.min(30,Number(e.target.value)||10)));touch()}} />
						<div className="field-hint">预算延长不改变网关自身的超时限制。失败模型、原因及恢复结果会记录在每拍诊断中。</div>
						<ModelPlugSelector label="分析失败恢复模型（重做原岗位，不跳阶段）" value={analysisRecoveryModel} models={modelData.data} disabled={formDisabled||modelData.loading||!!modelData.error} onChange={value=>{setAnalysisRecoveryModel(value);touch()}} />
						<div className="field-hint">
							直出使用已有记忆与世界生态材料，由正常文学导演统筹、单主演直接输出，不新增生态备料、心理画像、脑暴或审稿；导演流程由固定专家团队每拍进行三写前分析、两路构思候选和二审阅，专家不写正文，唯一主 writer 单独写作。
							当前选择只作用于之后提交的剧情输入。
						</div>
					</section>

					<section className="sp-section">
						<h4>世界书</h4>
						<SliderField
							label="关键词扫描深度"
							hint="被动触发回看最近几条消息"
							value={scanDepth}
							min={1}
							max={20}
							onChange={(v) => {
								setScanDepth(v);
								touch();
							}}
						/>
						<SliderField
							label="每轮注入条目上限"
							hint="0 = 关闭被动注入（常驻条目不受影响）"
							value={maxLore}
							min={0}
							max={10}
							onChange={(v) => {
								setMaxLore(v);
								touch();
							}}
						/>
					</section>

					<section className="sp-section">
						<h4>后台世界</h4>
						<div className="toggle-row">
							<span>每拍推演场外世界</span>
							<Toggle checked={literaryWorldEnabled} onChange={(value) => { setLiteraryWorldEnabled(value); touch(); }} />
						</div>
						<div className="field-hint">规则来自 `.liyuan-stage-skills/世界推演/SKILL.md`；关闭时不调用模型、不注入世界动态，已有分支快照保留。</div>
					</section>

					<section className="sp-section">
						<h4>鲜活世界生态</h4>
						<div className="toggle-row">
							<span>让人物、地点与事件独立运行</span>
							<Toggle checked={literaryEcologyEnabled} onChange={(value) => { setLiteraryEcologyEnabled(value); touch(); }} />
						</div>
						<div className="field-hint">每拍调用模型规划搜索、扩充全局原型池、适配当前角色卡，并在演出前后推进人物生活与可错过事件。用户是世界中的探索者，不是世界的主宰。</div>
					</section>

					<WorldProfileSection enabled={literaryWorldEnabled} toast={toast} />

					<section className="sp-section">
						<h4>模型插头</h4>
						<div className="field-hint">
							总插头是连接面板当前选择的剧情模型。保存“主演正文 / 小说开演”也会立即切换当前会话模型；Novel Play 内部卡始终跟随这个当前模型，不冻结创建角色卡时的旧路由。下列其他步骤可分别选择模型。
						</div>
						{([
							["writer", "共用主演正文 / 小说开演"],
							["literaryContinuity", "导演连续性证据"],
							["literaryDirector", "正常文学导演（直出模式）"],
							["literaryWorld", "后台世界推演"],
							["worldProfile", "角色卡世界画像"],
							["literaryWorldFacts", "拍后事实信封"],
							["literaryWorldAudit", "世界转移审计"],
							["ecologySearch", "生态检索规划"],
							["ecologyGlobal", "全局叙事原型池"],
							["ecologyCard", "角色卡生态池"],
							["ecologyRuntime", "人物与场所生态"],
							["directorSetting", "导演设定核对"],
							["directorIdeas", "导演角度构思"],
							["directorReviewFacts", "导演事实审阅"],
							["directorReviewStyle", "导演预设审阅"],
							["outlineBootstrap", "大纲首次规划"],
							["outlineChat", "大纲编剧讨论"],
							["outlineReconcile", "大纲剧情校准"],
							["outlineResearch", "大纲研究灵感"],
							["outlineCorpusResearch", "导演小说研究检索"],
							["novelDigest", "小说消化"],
							["outlineAudit", "大纲提案审计"],
							["scribe", "场记与状态兜底"],
							["compaction", "前情压缩"],
							["presetSort", "预设 AI 分拣"],
						] as Array<[SideModelStep, string]>).map(([step, label]) => (
							<ModelPlugSelector key={step} label={label} value={stepModels[step] ?? null} models={modelData.data} disabled={formDisabled || modelData.loading || !!modelData.error}
									onChange={(value: ModelRef | null) => {
									stepModelsDirtyRef.current = true;
									setStepModels((current) => {
										const next = { ...current };
										if (value) next[step] = value;
										else delete next[step];
										return next;
									});
									touch();
								}} />
						))}
					</section>

					<section className="sp-section">
						<h4>联网查证</h4>
						<label className="field-label" htmlFor="web-research-mode">使用方式</label>
						<select
							id="web-research-mode"
							className="field-input"
							value={webResearchMode}
							onChange={(event) => {
								setWebResearchMode(event.target.value as "off" | "auto" | "manual");
								touch();
							}}
						>
							<option value="off">关闭</option>
							<option value="manual">仅在我明确要求联网时</option>
							<option value="auto">模型按需使用</option>
						</select>
						<div className="field-hint">
							每拍最多三个公开事实查询，不再强制三搜；无公开作品出处的私人角色名会在发网前被拒绝。只有实际执行联网搜索时才读取代理设置；默认使用 127.0.0.1:7890，可用 LIYUAN_WEB_RESEARCH_PROXY=direct 改为直连。
						</div>
					</section>

					<section className="sp-section">
						<h4>上下文压缩</h4>
						<SliderField
							label="固定楼层压缩周期"
							hint="每 N 个剧情轮把早期正文压成接力摘要（原文归档进剧情库可召回）；0 = 关闭自动压缩，仍可手动触发"
							value={compactEvery}
							min={0}
							max={100}
							onChange={(v) => {
								setCompactEvery(v);
								touch();
							}}
						/>
					</section>

					<section className="sp-section">
						<h4>agent 行为</h4>
						<div className="toggle-row">
							<span>后端操控（bash / 文件等通用工具）</span>
							<Toggle
								checked={backendControl}
								onChange={(v) => {
									setBackendControl(v);
									touch();
								}}
							/>
						</div>
						<div className="field-hint">
							开启后 agent 能操作本机（调用你的其他项目、查资料）；全部调用都会显示在过程条。仅在自己的设备上开启。
						</div>
					</section>

				</>
			)}
		</div>
	);
}
