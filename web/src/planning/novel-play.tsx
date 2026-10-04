import { useEffect, useRef, useState } from "react";
import {
	buildNovelPlay, cancelNovelPlayJob, getNovelPlayJob, getNovelPlayStartOptions, listNovelPlayJobs,
	previewNovelPlay, startNovelPlay, type NovelPlayJob, type NovelPlayPreview, type NovelPlayStartOptions,
	type NovelPlayStartResult,
} from "./novel-play-client.ts";

type Step = "build" | "setup" | "preview" | "recovery";
const terminal = (job: NovelPlayJob) => ["succeeded", "failed", "cancelled"].includes(job.status);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function NovelPlayDialog({ docId, title, onClose }: { docId: string; title: string; onClose: () => void }) {
	const [step, setStep] = useState<Step>("build");
	const [job, setJob] = useState<NovelPlayJob | null>(null);
	const [options, setOptions] = useState<NovelPlayStartOptions | null>(null);
	const [nodeId, setNodeId] = useState("");
	const [position, setPosition] = useState<"before" | "after">("before");
	const [mode, setMode] = useState<"new-character" | "existing-character">("new-character");
	const [startKind, setStartKind] = useState<"node" | "source-end">("node");
	const [continuationAcknowledged, setContinuationAcknowledged] = useState(false);
	const [name, setName] = useState("");
	const [identity, setIdentity] = useState("");
	const [preview, setPreview] = useState<NovelPlayPreview | null>(null);
	const [recovery, setRecovery] = useState<Extract<NovelPlayStartResult, { session: "recovery-required" }> | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const generation = useRef(0);
	const controller = useRef<AbortController | null>(null);

	const invalidate = () => { generation.current += 1; controller.current?.abort(); controller.current = null; };
	const loadOptions = async (result: NonNullable<NovelPlayJob["result"]>, request: number, signal?: AbortSignal) => {
		const response = await getNovelPlayStartOptions(docId, result.revision, signal);
		if (request !== generation.current) return;
		setOptions(response.package);
		setNodeId(response.package.nodes[0]?.nodeId ?? "");
		setStep("setup");
	};

	useEffect(() => {
		const request = ++generation.current;
		const abort = new AbortController();
		controller.current = abort;
		void listNovelPlayJobs().then(async ({ jobs }) => {
			if (request !== generation.current) return;
			const found = jobs.find((item) => item.docId === docId);
			if (!found) { void build(); return; }
			setJob(found);
			if (found.status === "succeeded" && found.result) await loadOptions(found.result, request, abort.signal);
			else if (found.status === "failed" || found.status === "cancelled") void build();
		}).catch((cause) => { if (request === generation.current && !abort.signal.aborted) setError(errorText(cause)); });
		return invalidate;
	}, [docId]);

	useEffect(() => {
		if (!job || terminal(job)) return;
		const request = generation.current;
		const abort = new AbortController();
		controller.current = abort;
		let timer = 0;
		const poll = async () => {
			try {
				const response = await getNovelPlayJob(job.id, abort.signal);
				if (request !== generation.current) return;
				setJob(response.job);
				if (response.job.status === "succeeded" && response.job.result) await loadOptions(response.job.result, request, abort.signal);
				else if (!terminal(response.job)) timer = window.setTimeout(() => void poll(), 1_500);
			} catch (cause) {
				if (request === generation.current && !abort.signal.aborted) { setError(errorText(cause)); timer = window.setTimeout(() => void poll(), 3_000); }
			}
		};
		timer = window.setTimeout(() => void poll(), 800);
		return () => { window.clearTimeout(timer); abort.abort(); };
	}, [job?.id, job?.status]);

	const build = async () => {
		if (busy || (job && !terminal(job))) return;
		invalidate(); const request = generation.current; setBusy(true); setError(""); setPreview(null); setOptions(null); setStep("build");
		try { const response = await buildNovelPlay(docId); if (request === generation.current) setJob(response.job); }
		catch (cause) { if (request === generation.current) setError(errorText(cause)); }
		finally { if (request === generation.current) setBusy(false); }
	};
	const cancel = async () => {
		if (!job || busy || terminal(job)) return;
		invalidate(); const request = generation.current; setBusy(true); setError("");
		try { const response = await cancelNovelPlayJob(job.id); if (request === generation.current) setJob(response.job); }
		catch (cause) { if (request === generation.current) setError(errorText(cause)); }
		finally { if (request === generation.current) setBusy(false); }
	};
	const makePreview = async () => {
		if (busy || !options || (startKind === "node" && !nodeId) || !name.trim() || !identity.trim() || (startKind === "source-end" && !continuationAcknowledged)) return;
		invalidate(); const request = generation.current; const abort = new AbortController(); controller.current = abort; setBusy(true); setError(""); setPreview(null);
		try {
			const response = await previewNovelPlay({ docId, revision: options.revision, startKind, ...(startKind === "node" ? { nodeId, position } : { continuationAcknowledged: true }), player: { mode, name: name.trim(), identity: identity.trim() } }, abort.signal);
			if (request === generation.current) { setPreview(response.preview); setStep("preview"); }
		} catch (cause) { if (request === generation.current && !abort.signal.aborted) setError(errorText(cause)); }
		finally { if (request === generation.current) setBusy(false); }
	};
	const confirmStart = async () => {
		if (busy || !preview) return;
		invalidate(); const request = generation.current; const abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
		try {
			const response = await startNovelPlay(preview.token, abort.signal);
			if (request !== generation.current) return;
			setPreview(null);
			if (response.started.session === "created") onClose();
			else { setRecovery(response.started); setStep("recovery"); }
		} catch (cause) { if (request === generation.current && !abort.signal.aborted) setError(errorText(cause)); }
		finally { if (request === generation.current) setBusy(false); }
	};
	const close = () => { invalidate(); onClose(); };
	const active = job && !terminal(job);
	const selectedNodeIndex = options?.nodes.findIndex((node) => node.nodeId === nodeId) ?? -1;
	const selectedNode = selectedNodeIndex >= 0 ? options?.nodes[selectedNodeIndex] : undefined;
	const emptyPrefixRisk = selectedNodeIndex === 0 && position === "before";

	return <div className="planning-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
		<section className="planning-proposal planning-digest" role="dialog" aria-modal="true" aria-labelledby="novel-play-title" style={{ maxWidth: 760, maxHeight: "90vh", overflow: "auto", margin: "5vh auto", padding: 20 }}>
			<header><div><span>NOVEL PLAY</span><h2 id="novel-play-title">从《{title}》开演</h2></div><button className="drawer-btn" onClick={close} aria-label="关闭">关闭</button></header>
			<div className="planning-page-note">开演只使用服务器从原文提取的有界公开资料。可创建新角色，也可接管截至开演点已经登场的原著角色；可从公开节点或导入原文终点之后开始。预览确认后才会创建并切换到新会话。</div>
			{error && <div className="panel-error planning-error" role="alert">{error}</div>}

			{step === "build" && <section>
				<h3>1. 构建作品包</h3>
				{!job && <><p>先从已消化原文构建可开演节点。此过程不会删除或修改藏书。</p><p>构建记录只属于当前会话。切换会话或角色卡后，任务列表可能为空。</p></>}
				{job && <div className="planning-warning">状态：{job.status === "queued" ? "排队中" : job.status === "running" ? "构建中" : job.status === "succeeded" ? "已完成" : job.status === "cancelled" ? "已取消" : "失败"}{job.progress && job.progress.total > 0 ? ` · 已处理 ${job.progress.completed}/${job.progress.total} 块` : ""}{job.error ? ` · ${job.error}` : ""}</div>}
				{active ? <button className="drawer-btn" disabled={busy} onClick={() => void cancel()}>{busy ? "正在取消…" : "取消构建"}</button>
					: <button className="drawer-btn primary" disabled={busy} onClick={() => void build()}>{busy ? "正在提交…" : job?.status === "failed" || job?.status === "cancelled" ? "重试构建" : "开始构建"}</button>}
				{active && <p>关闭窗口只停止前端查询。要停止服务器构建，请使用“取消构建”。取消不会删除藏书。</p>}
				{job?.status === "failed" && <p>失败结果会保留。你可以直接重试，不需要重新上传原文。</p>}
			</section>}

			{step === "setup" && options && <section>
				<h3>2. 选择身份和开演点</h3>
				<div className="planning-grid">
					<label>玩家模式<select className="planning-input" value={mode} onChange={(event) => { setMode(event.target.value as typeof mode); setIdentity(""); }}><option value="new-character">创建新角色</option><option value="existing-character">接管原著角色</option></select></label>
					<label>玩家名 / 原著角色名<input className="planning-input" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder={mode === "new-character" ? "新角色的名字" : "原文中的准确角色名"} /></label>
					<label>{mode === "new-character" ? "玩家身份" : "角色资料确认"}<textarea className="planning-input" maxLength={1500} rows={4} value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder={mode === "new-character" ? "新角色在故事中的公开身份" : "先填写你确认的角色公开资料；预览仍会按开演点原文校验"} /></label>
					<label>开演位置<select className="planning-input" value={startKind} onChange={(event) => setStartKind(event.target.value as typeof startKind)}><option value="node">公开节点</option><option value="source-end">导入原文终点之后</option></select></label>
					{startKind === "node" && <><label>公开节点<select className="planning-input" value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{options.nodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.source.chapters.length ? node.source.chapters.join(" / ") : `分块 ${node.source.chunkIndex + 1}`} · {node.title}</option>)}</select></label><label>位置<select className="planning-input" value={position} onChange={(event) => setPosition(event.target.value as "before" | "after")}><option value="before">节点之前</option><option value="after">节点之后</option></select></label></>}
				</div>
				{startKind === "source-end" && <label className="toggle-row"><input type="checkbox" checked={continuationAcknowledged} onChange={(event) => setContinuationAcknowledged(event.target.checked)} />我确认从导入原文终点继续原创剧情；系统不判断作品是否正式断更，也不会提供原著未来候选。</label>}
				{startKind === "node" && selectedNode && <article className="planning-research-card novel-play-node-preview"><div className="planning-card-head"><strong>{selectedNode.title}</strong><span>{selectedNode.source.chapters.length ? selectedNode.source.chapters.join(" / ") : `分块 ${selectedNode.source.chunkIndex + 1}`} · 阶段 {selectedNode.stageOrder} · 节点 {selectedNode.nodeOrder}</span></div><p>{selectedNode.summary}</p><small>这是公开节点摘要，不是原文全文；当前分支事实和用户选择优先。</small></article>}
				{options.nodes.length === 0 && <div className="planning-warning">作品包没有可选的公开节点。</div>}
				{startKind === "node" && emptyPrefixRisk && <div className="planning-warning">首个节点之前可能没有可提取的原文，因此预览可能失败。可改选“节点之后”，或选择更后的公开节点。</div>}
				<button className="drawer-btn primary" disabled={busy || (startKind === "node" && !nodeId) || !name.trim() || !identity.trim() || (startKind === "source-end" && !continuationAcknowledged)} onClick={() => void makePreview()}>{busy ? "正在提取开场并生成结构化人物画像（最长约 5 分钟）…" : "生成有界预览"}</button>
			</section>}

			{step === "preview" && preview && <section>
				<h3>3. 确认一次性预览</h3>
				<p><b>{preview.draft.time}</b> · {preview.draft.place}</p>
				<article className="planning-research-card"><h4>场景</h4><p>{preview.draft.sceneText}</p></article>
				<article className="planning-research-card"><h4>玩家</h4><p><b>{preview.draft.user.name}</b> · {preview.draft.user.identity}</p></article>
				{preview.draft.publicCharacterProfiles.length > 0 && <div><h4>公开人物</h4>{preview.draft.publicCharacterProfiles.map((item, index) => <article className="planning-research-card" key={`${item.name}-${index}`}><b>{item.name}</b><p>{item.profile}</p></article>)}</div>}
				{preview.draft.publicWorldFacts.length > 0 && <div><h4>公开世界信息</h4><ul>{preview.draft.publicWorldFacts.map((fact, index) => <li key={`${index}-${fact}`}>{fact}</li>)}</ul></div>}
				{preview.draft.characterProfiles && preview.draft.characterProfiles.length > 0 && <div><h4>人物画像（按开演点原文生成）</h4>{preview.draft.characterProfiles.map((profile) => <article className="planning-research-card" key={profile.name}><div className="planning-card-head"><strong>{profile.name}</strong><span>{profile.keys.join(" / ")}</span></div><pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{profile.content}</pre><small>证据引句 {profile.evidenceQuotes.length} 条。画像是当前开演点的写作参考，不包含后文自动补全。</small></article>)}</div>}
				<article className="planning-research-card"><h4>开场旁白</h4><p>{preview.draft.openingNarration}</p></article>
				<div className="planning-warning">点击确认会消耗服务器一次性令牌，创建角色卡并切换到新会话。模型预览最长约 5 分钟，角色切换最长约 30 秒；超时或模型错误会在此窗口显示。令牌于 {new Date(preview.expiresAt).toLocaleTimeString()} 过期。</div>
				<div className="planning-corpus-acts"><button className="drawer-btn" disabled={busy} onClick={() => { invalidate(); setPreview(null); setStep("setup"); }}>返回修改</button><button className="drawer-btn primary" disabled={busy} onClick={() => void confirmStart()}>{busy ? "正在开演…" : "确认并开演"}</button></div>
			</section>}

			{step === "recovery" && recovery && <section>
				<h3>需要恢复角色切换</h3>
				<div className="planning-warning" role="status">{recovery.recovery}</div>
				{recovery.card && <p><b>已保存角色卡：</b><code>{recovery.card}</code></p>}
				<p>开演令牌已经消耗，请勿重复提交。先检查当前会话是否已经切换。若仍卡住，请按服务器提示重启服务后恢复。角色卡和配置已保留。</p>
				<button className="drawer-btn primary" onClick={close}>关闭并检查会话</button>
			</section>}
		</section>
	</div>;
}
