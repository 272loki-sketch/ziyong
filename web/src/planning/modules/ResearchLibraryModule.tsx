import type { Dispatch, SetStateAction } from "react";

type ResearchDisplayItem = {
	id: string;
	title: string;
	url?: string;
	note?: string;
	excerpt?: string;
	appliesWhen?: string;
	warnings?: string[];
	failureWarnings?: string[];
	sourceIds?: string[];
	origin: "web" | "corpus";
	confidence?: string;
};

function list<T>(value: T[] | undefined | null): T[] { return Array.isArray(value) ? value : []; }

export interface ResearchLibraryModuleProps {
	items: ResearchDisplayItem[];
	filter: string;
	setFilter: Dispatch<SetStateAction<string>>;
	confidence: string;
	setConfidence: Dispatch<SetStateAction<string>>;
}

function MaterialCard({ item }: { item: ResearchDisplayItem }) {
	return <article className="planning-research-card material-library-card">
		<div className="planning-card-head"><strong>{item.title}</strong><span>{item.confidence === "audited" ? "证据已审计" : item.confidence === "system-grounded" ? "系统定位" : item.origin === "web" ? "网页提炼" : "藏书提炼"}</span></div>
		{item.appliesWhen && <p><b>适用：</b>{item.appliesWhen}</p>}
		{item.note && <p>{item.note}</p>}
		{item.excerpt && <blockquote>{item.excerpt}</blockquote>}
		{list(item.failureWarnings ?? item.warnings).map((warning) => <div className="planning-warning" key={warning}>{warning}</div>)}
	</article>;
}

function MaterialSection({ title, eyebrow, items, empty }: { title: string; eyebrow: string; items: ResearchDisplayItem[]; empty: string }) {
	return <section className="material-library-section">
		<div className="material-library-section-head"><div><span>{eyebrow}</span><h3>{title}</h3></div><b>{items.length} 条</b></div>
		{items.length > 0 ? <div className="material-library-grid">{items.map((item) => <MaterialCard item={item} key={item.id} />)}</div> : <div className="material-library-empty">{empty}</div>}
	</section>;
}

export function ResearchLibraryModule({ items, filter, setFilter, confidence, setConfidence }: ResearchLibraryModuleProps) {
	const visible = items.filter((item) => {
		const matchesText = !filter.trim() || `${item.title} ${item.appliesWhen ?? ""} ${item.note ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase());
		return matchesText && (confidence === "all" || item.confidence === confidence);
	});
	const webItems = visible.filter((item) => item.origin === "web");
	const corpusItems = visible.filter((item) => item.origin === "corpus");
	return <div className="planning-page planning-archive material-library">
		<div className="planning-page-note"><strong>创作素材库</strong><br />网页研究和藏书消化分开呈现。两类素材都只是可复用的研究参考，不是已经发生的剧情；小说全文仍只保留在藏书消化页，不会进入这里。</div>
		<div className="material-library-toolbar"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索机制、适用条件或作品"/><select value={confidence} onChange={(event) => setConfidence(event.target.value)}><option value="all">全部可信度</option><option value="audited">证据已审计</option><option value="system-grounded">系统定位</option><option value="legacy-claimed">旧定位未复核</option></select></div>
		<MaterialSection eyebrow="WEB RESEARCH" title="网页研究素材" items={webItems} empty="暂无网页研究素材。可到“研究搜索”执行一次公开资料研究。" />
		<MaterialSection eyebrow="BOOK DIGEST" title="藏书消化素材" items={corpusItems} empty="暂无藏书消化素材。完成一本小说消化后，提炼出的机制会出现在这里。" />
	</div>;
}
