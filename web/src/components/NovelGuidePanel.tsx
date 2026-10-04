import { useState } from "react";

export interface NovelGuideData {
	mode: "new-character" | "existing-character";
	startKind: "node" | "source-end";
	visible: boolean;
	positionLabel: string;
	candidates: Array<{ title: string; summary: string }>;
	note: string;
}

export function NovelGuidePanel({ guide, onUse, onModify }: { guide: NovelGuideData; onUse: (text: string) => void; onModify: () => void }) {
	const [open, setOpen] = useState(true);
	if (!guide.visible && guide.startKind !== "source-end") return null;
	return <aside className="novel-guide-panel" aria-label="原著走向提示">
		<header><div><span>CANON GUIDE</span><strong>原著走向提示</strong></div><button type="button" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "展开"}</button></header>
		{open && <>
			<div className="novel-guide-meta">{guide.positionLabel}</div>
			<p className="novel-guide-note">{guide.note}</p>
			{guide.candidates.length === 0 ? <div className="novel-guide-empty">导入文本后没有已知原著后续，接下来由你的选择原创发展。</div> : <div className="novel-guide-candidates">{guide.candidates.map((candidate, index) => <article key={`${candidate.title}-${index}`}><b>{index === 0 ? "原著下一步" : `后续候选 ${index + 1}`}</b><strong>{candidate.title}</strong><p>{candidate.summary}</p><button type="button" onClick={() => onUse(`请尽量按原著走向推进：${candidate.title}。但保留当前分支事实和我的主动选择，不要替我决定角色未表达的行动。`)}>按此方向推进</button></article>)}</div>}
			{guide.candidates.length > 0 && <button className="novel-guide-modify" type="button" onClick={onModify}>我要修改这一节点</button>}
		</>}
	</aside>;
}
