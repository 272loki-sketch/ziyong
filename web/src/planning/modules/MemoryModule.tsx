import type { MemoryDiffRecord, MemoryEventCard } from "../types.ts";
function list<T>(value: T[] | undefined | null): T[] { return Array.isArray(value) ? value : []; }
const LINK_LABEL: Record<string, string> = { caused_by: "引发", evolved_from: "演进自", resolved_the: "化解了", contradicts: "与…冲突" };
export interface MemoryModuleProps { memoryError: string; loadMemory: () => void; memoryLoading: boolean; memoryEvents: MemoryEventCard[]; memoryDiff: MemoryDiffRecord[]; eventsById: Map<string, MemoryEventCard>; }
export function MemoryModule({ memoryError, loadMemory, memoryLoading, memoryEvents, memoryDiff, eventsById }: MemoryModuleProps) { return <div className="planning-page planning-memory">
					<div className="planning-page-note"><strong>剧情记忆 · 事件卡与弧线</strong>。事件卡是检索投影，不覆盖权威状态；编码为代码生成的 canonical id；arc 是长期剧情线名；links 追踪因果演进链。</div>
					{memoryError && <div className="panel-error planning-error">{memoryError}<button className="drawer-btn" onClick={() => void loadMemory()}>重试</button></div>}
					{memoryLoading && !memoryEvents.length && <div className="planning-empty">正在读取剧情记忆…</div>}
					{!memoryLoading && !memoryError && memoryEvents.length === 0 && <div className="planning-empty">还没有事件卡。每 N 拍滚动提取会自动建卡。</div>}
					{memoryEvents.length > 0 && <><section>
						<div className="planning-section-head"><h3 className="planning-section-title">事件卡</h3><span>{memoryEvents.length} 张 · core {memoryEvents.filter((e) => e.importance === "core").length} · major {memoryEvents.filter((e) => e.importance === "major").length} · normal {memoryEvents.filter((e) => e.importance === "normal").length}</span></div>
						{([...new Set(memoryEvents.map((e) => e.arc || "未归类"))].sort()).map((arc) => <div className="planning-memory-arc" key={arc}>
							<h4 className="planning-memory-arc-name">◆ {arc}</h4>
							<div className="planning-grid">
								{memoryEvents.filter((e) => (e.arc || "未归类") === arc).sort((a, b) => (a.turnRange?.from ?? 0) - (b.turnRange?.from ?? 0)).map((event) => <article className={`planning-card planning-memory-card importance-${event.importance}`} key={event.id}>
									<div className="planning-card-head">
										<strong>{event.title}</strong>
										<span>{event.status === "resolved" ? "已化解" : event.status === "active" ? "进行中" : event.status === "retired" ? "已退役" : "候选"}{event.turnRange ? ` · 拍${event.turnRange.from}–${event.turnRange.to}` : ""}</span>
									</div>
									<p className="planning-memory-summary">{event.summary.length > 180 ? `${event.summary.slice(0, 180)}…` : event.summary}</p>
									<div className="planning-memory-meta">
										{event.time && <span>⏱ {event.time}</span>}
										{event.location && <span>📍 {event.location}</span>}
										<span className={`planning-memory-importance importance-${event.importance}`}>{event.importance}</span>
									</div>
									{list(event.participants).length > 0 && <div className="planning-memory-tags">{event.participants!.map((p) => <em key={p}>{p}</em>)}</div>}
									{list(event.tags).length > 0 && <div className="planning-memory-tags">{event.tags.map((tag) => <em key={tag}>{tag}</em>)}</div>}
									{list(event.links).length > 0 && <div className="planning-memory-links">{event.links!.map((link, i) => <span key={i} className={`planning-memory-link kind-${link.type}`}>{LINK_LABEL[link.type] ?? link.type} → {eventsById.get(link.to)?.title ?? link.to.slice(0, 16)}{link.note ? `（${link.note.slice(0, 60)}）` : ""}</span>)}</div>}
									{list(event.sourceRefs).length > 0 && <details className="planning-memory-refs"><summary>原文锚点 {event.sourceRefs.length} 处</summary>{event.sourceRefs.map((ref) => <span key={ref.entryId} className="planning-memory-ref">{ref.entryType ?? "tree"} · {ref.entryId.slice(0, 12)}…{ref.turn ? ` · 拍${ref.turn}` : ""}</span>)}</details>}
								</article>)}
							</div>
						</div>)}
					</section>
					{memoryDiff.length > 0 && <section>
						<div className="planning-section-head"><h3 className="planning-section-title">审计日志</h3><span>{memoryDiff.length} 条</span></div>
						<div className="planning-memory-diff">
							{memoryDiff.slice(0, 30).map((record, index) => <div className={`planning-memory-diff-row op-${record.op}`} key={index}>
								<span className="planning-memory-diff-op">{record.op === "create" ? "+" : record.op === "merge" ? "⇄" : record.op === "update" ? "✎" : "−"}</span>
								<span className="planning-memory-diff-title">{record.title}</span>
								{record.arc && <span className="planning-memory-diff-arc">◆ {record.arc}</span>}
								<span className="planning-memory-diff-reason">{record.reason}</span>
								<time className="planning-memory-diff-time">{new Date(record.ts).toLocaleTimeString()}</time>
							</div>)}
						</div>
					</section>}
					</>}
				</div>; }
