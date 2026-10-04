import { useEffect, useState } from "react";
import { NovelPlayDialog } from "../novel-play.tsx";
import { buildNovelPlayExtension, commitNovelPlayUpgrade, listNovelPlayJobs, previewNovelPlayUpgrade, type NovelPlayJob } from "../novel-play-client.ts";
import { markNovelPlaySelected, selectedNovelPlayDocs } from "../novel-play-selection.ts";
import type { CorpusDocument } from "../types.ts";
import { NovelProgress } from "./NovelPlayProgress.tsx";

const CORPUS_STATUS: Record<string, string> = {
	ready: "已完成",
	failed: "失败",
	paused: "已暂停",
};

export function NovelPlayModule({ documents }: { documents: CorpusDocument[] }) {
	const [playing, setPlaying] = useState<CorpusDocument | null>(null);
	const [selected, setSelected] = useState<string[]>(() => selectedNovelPlayDocs());
	const [jobs, setJobs] = useState<NovelPlayJob[]>([]);
	useEffect(() => {
		let alive = true;
		const load = () => { void listNovelPlayJobs().then(({ jobs: next }) => { next.forEach((job) => markNovelPlaySelected(job.docId)); if (alive) { setJobs(next); setSelected(selectedNovelPlayDocs()); } }).catch(() => {}); };
		load(); const timer = window.setInterval(load, 1_500);
		return () => { alive = false; window.clearInterval(timer); };
	}, []);
	useEffect(() => setSelected(selectedNovelPlayDocs()), [documents.length]);
	const activeDocIds = new Set(jobs.map((job) => job.docId));
	const ready = documents.filter((document) => document.status === "ready" && (selected.includes(document.id) || activeDocIds.has(document.id)));
	const startJobs = new Map(jobs.filter((job) => job.kind !== "extension" && job.status === "succeeded" && job.result).map((job) => [job.docId, job]));
	const extensionJobs = new Map(jobs.filter((job) => job.kind === "extension" || job.result?.parentRevision).map((job) => [job.docId, job]));
	const buildExtension = async (target: CorpusDocument) => {
		if (!target.parentDocId) return;
		const base = startJobs.get(target.parentDocId)?.result;
		if (!base) { window.alert("请先为旧版本构建作品包，再构建追加作品包。"); return; }
		try { await buildNovelPlayExtension(target.parentDocId, base.revision, target.id); } catch (cause) { window.alert(cause instanceof Error ? cause.message : String(cause)); }
	};
	const upgrade = async (job: NovelPlayJob) => {
		const revision = job.result?.revision;
		if (!revision) return;
		try {
			const preview = await previewNovelPlayUpgrade(job.docId, revision);
			if (window.confirm("确认将当前分支采用这个追加版原著？旧卡、旧会话和已发生剧情不会被改写；回档到升级前会恢复旧版。")) {
				await commitNovelPlayUpgrade(preview.preview.token);
				window.alert("当前分支已采用新版原著候选。");
			}
		} catch (cause) { window.alert(cause instanceof Error ? cause.message : String(cause)); }
	};

	return <div className="planning-page planning-corpus">
		<div className="planning-page-note">
			<strong>小说开演 · 从已消化作品创建独立会话。</strong>
			选择一部已经完成消化的小说，构建作品包、填写玩家身份并预览开场。确认后会创建新角色卡和新会话，不会覆盖当前会话。
		</div>
		{ready.length === 0 && <div className="planning-empty">
			<strong>还没有可开演的小说</strong>
			<span>请先在“藏书消化”中点击某本书的“从这本小说开演”，它才会出现在这里。</span>
		</div>}
		{ready.map((document) => { const job = jobs.find((item) => item.docId === document.id); const extension = extensionJobs.get(document.id); return <article className="planning-proposal planning-corpus-item" key={document.id}>
			<header><div><span>NOVEL · READY</span><h3>{document.title}</h3></div><b>{job?.status === "running" ? `演化中 · ${job.progress?.completed ?? 0}/${job.progress?.total ?? document.chunkCount} 块` : job?.status === "queued" ? "等待开始" : job?.status === "failed" ? `演化失败 · ${job.progress?.completed ?? 0}/${job.progress?.total ?? document.chunkCount} 块` : `${document.chars > 10000 ? `${Math.round(document.chars / 10000) / 100}万字` : `${document.chars}字`} · ${document.chunkCount}块 · ${CORPUS_STATUS[document.status]}`}</b></header>
			<NovelProgress job={job} total={document.chunkCount} />
			{job?.error && <div className="planning-warning" role="alert">{job.error}。点击下方按钮可从断点重试。</div>}
			<div className="planning-corpus-acts"><button className="drawer-btn primary" onClick={() => { markNovelPlaySelected(document.id); setPlaying(document); }}>{job?.status === "failed" || job?.status === "cancelled" ? "从断点重试" : job?.status === "running" ? "查看演化" : "从这本小说开演"}</button>{document.parentDocId && <button className="drawer-btn" disabled={!!extension && !["failed", "cancelled", "succeeded"].includes(extension.status)} onClick={() => void buildExtension(document)}>{extension?.status === "succeeded" ? "追加包已完成" : extension?.status === "running" ? "追加包构建中" : "构建追加包"}</button>}{extension?.status === "succeeded" && <button className="drawer-btn" onClick={() => void upgrade(extension)}>当前分支采用新版</button>}</div>
		</article>; })}
		{playing && <NovelPlayDialog docId={playing.id} title={playing.title} onClose={() => setPlaying(null)} />}
	</div>;
}
