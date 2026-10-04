import type { Dispatch, SetStateAction } from "react";
import type { OutlineResearchSearchResponse, ResearchSearchLog, ResearchSearchScheduleStatus } from "../types.ts";
function list<T>(value: T[] | undefined | null): T[] { return Array.isArray(value) ? value : []; }
export interface ResearchSearchModuleProps { searchTopic: string; setSearchTopic: Dispatch<SetStateAction<string>>; searchBusy: boolean; searchSchedule: ResearchSearchScheduleStatus | null; runSearch: () => void; runAutoSearch: () => void; searchError: string; searchResult: OutlineResearchSearchResponse | null; searchLogs: ResearchSearchLog[]; busy: boolean; expandedLog: Set<string>; toggleLog: (id: string) => void; runRetryExtraction: (log: ResearchSearchLog) => void; setTab: (tab: "research" | "search") => void; }
export function ResearchSearchModule({ searchTopic, setSearchTopic, searchBusy, searchSchedule, runSearch, runAutoSearch, searchError, searchResult, searchLogs, busy, expandedLog, toggleLog, runRetryExtraction, setTab }: ResearchSearchModuleProps) { return <div className="planning-page planning-archive">
				<div className="planning-page-note">研究搜索会按你看重的方向生成去隐私的检索式，搜索公开书评、影评与叙事分析摘要，再把其中的桥段结构、信息分配、节奏与失败原因提炼成可复用机制存入创作素材库（跨卡共享，可直接拿去设计剧情）。需先启用联网研究（「版本与设置 → 研究方式」）。请只研究你有权使用的公开资料。</div>
				<div className="planning-research-refresh"><input value={searchTopic} onChange={(event) => setSearchTopic(event.target.value)} placeholder="想研究什么机制或类型，如：争风吃醋 / 慢热互信 / 悬疑铺陈（留空用默认话题）"/><button className="drawer-btn primary" disabled={searchBusy} onClick={() => void runSearch()}>{searchBusy ? "搜索中…" : "开始研究"}</button><button className="drawer-btn" disabled={searchBusy || searchSchedule?.running} onClick={() => void runAutoSearch()}>自动搜索主题</button></div>
				<div className="planning-page-note">每日自动搜索：{searchSchedule?.enabled ? "已启用" : "未启用（可在 liyuan.config.json 开启）"}{searchSchedule?.lastRunAt ? ` · 上次 ${new Date(searchSchedule.lastRunAt).toLocaleString()} · ${searchSchedule.lastStatus ?? "未知"}` : ""}</div>
				{searchError && <div className="panel-error planning-error">{searchError}</div>}
				{searchBusy && <div className="planning-empty">正在联网搜索并提炼，通常几秒到几十秒…</div>}
				{!searchResult && !searchBusy && <div className="planning-empty">还没有运行过研究搜索。输入主题后点「开始研究」，这里会展示本次搜到的来源与提炼出的可复用机制。</div>}
				{searchResult && <>
					<section>
						<div className="planning-section-head"><h3 className="planning-section-title">检索式</h3><span>{searchResult.search.queries.length} 组（已脱敏）</span></div>
						{list(searchResult.search.queries).map((query) => <div className="planning-research-card" key={query}><p><code>{query}</code></p></div>)}
					</section>
					<section>
						<div className="planning-section-head"><h3 className="planning-section-title">搜索来源</h3><span>{searchResult.search.sources.length} 条</span></div>
						{list(searchResult.search.results).map((row) => <div key={row.query} className="planning-search-group">
							<h4>{row.query}</h4>
							{row.rejected && <div className="planning-warning">已拒绝：{row.rejected}</div>}
							{row.error && <div className="planning-warning">失败：{row.error}</div>}
							{!row.results?.length && !row.error && !row.rejected && <div className="planning-empty">没有找到可用结果。</div>}
							{list(row.results).map((result, index) => <article className="planning-research-card" key={`${row.query}-${index}`}><h4>{result.title}</h4><a href={result.url} target="_blank" rel="noreferrer">{result.url}</a><p>{result.snippet.length > 260 ? `${result.snippet.slice(0, 260)}…` : result.snippet}</p></article>)}
						</div>)}
					</section>
					<section>
						<div className="planning-section-head"><h3 className="planning-section-title">本轮提炼（已入库）</h3><span>{searchResult.search.extracted.length} 条</span></div>
						{searchResult.search.extracted.length === 0 && <div className="planning-empty">材料不足，没有提炼出可用机制；换个说法或换主题再试。</div>}
						<div className="planning-grid">{list(searchResult.search.extracted).map((item, index) => {
							const origin = list(item.sourceIds).map((id) => searchResult!.search.sources.find((source) => source.id === id)?.title).filter(Boolean).slice(0, 3).join("、");
							return <article className="planning-research-card" key={index}><div className="planning-card-head"><strong>{item.mechanism}</strong><span>已入库</span></div><p><b>适用：</b>{item.appliesWhen}</p><div className="planning-warning">失败警告：{item.failureWarning}</div>{origin && <small>来源：{origin}</small>}</article>;
						})}</div>
						<div className="planning-research-refresh"><button className="drawer-btn" onClick={() => setTab("research")}>查看创作素材库 →</button></div>
					</section>
					<section>
						<div className="planning-section-head"><h3 className="planning-section-title">历史搜索（保留）</h3><span>{searchLogs.length} 条</span></div>
						{searchLogs.length === 0 && <div className="planning-empty">还没有保留的研究搜索记录。每次搜索的来源与提炼结果都会留存在这里，可随时回看、或对已保留的来源再次提炼。</div>}
						{list(searchLogs).map((log) => <article className="planning-research-card" key={log.id}>
							<div className="planning-card-head"><strong>{log.topic || "（默认话题）"}</strong><span>{new Date(log.createdAt).toLocaleString()}</span></div>
							<p>来源 {log.sources.length} 条 · 提炼 {log.extracted.length} 条</p>
							<button className="drawer-btn" disabled={busy} onClick={() => toggleLog(log.id)}>{expandedLog.has(log.id) ? "收起" : "详情▾"}</button>
							{expandedLog.has(log.id) && <>
								{list(log.queries).map((query) => <p key={query}><code>{query}</code></p>)}
								{list(log.sources).slice(0, 8).map((source, index) => <p key={`${source.id}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><br /><small>{source.snippet.length > 160 ? `${source.snippet.slice(0, 160)}…` : source.snippet}</small></p>)}
								{log.sources.length > 8 && <div className="planning-warning">来源较多，仅展示前 8 条。</div>}
								<details open>
									{log.extracted.length === 0
										? <summary>上次提炼：无结果</summary>
										: <summary>上次提炼（已入库）</summary>}
									<div className="planning-grid">{list(log.extracted).map((item, index) => <article className="planning-research-card" key={index}><div className="planning-card-head"><strong>{item.mechanism}</strong><span>已入库</span></div><p><b>适用：</b>{item.appliesWhen}</p><div className="planning-warning">失败警告：{item.failureWarning}</div></article>)}</div>
								</details>
							</>}
							<div className="planning-research-refresh"><button className="drawer-btn" disabled={searchBusy} onClick={() => void runRetryExtraction(log)}>仅再次提炼（不重新联网）</button></div>
						</article>)}
					</section>
				</>}
			</div>; }
