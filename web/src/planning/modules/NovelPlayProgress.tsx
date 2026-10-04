import type { NovelPlayJob } from "../novel-play-client.ts";

export function NovelProgress({ job, total }: { job: NovelPlayJob | undefined; total: number }) {
	if (!job) return null;
	const completed = job.progress?.completed ?? 0;
	const chunks = job.progress?.total || total || 0;
	const percent = chunks > 0 ? Math.min(100, Math.round((completed / chunks) * 100)) : 0;
	const label = job.status === "running" ? "演化中" : job.status === "queued" ? "排队中" : job.status === "failed" ? "上次失败，可断点重试" : job.status === "succeeded" ? "演化完成" : "已取消";
	return <div className="novel-play-progress" role="status" aria-label={`${label}，${completed}/${chunks} 块`}>
		<div className="novel-play-progress-head"><span>{label}</span><b>{completed}/{chunks} 块 · {percent}%</b></div>
		<div className="novel-play-progress-track"><span className={`novel-play-progress-fill is-${job.status}`} style={{ width: `${percent}%` }} /></div>
	</div>;
}
