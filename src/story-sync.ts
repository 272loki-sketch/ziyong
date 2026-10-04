/**
 * 剧情扩展内存同步（进程内直达，不经 /panelsync 命令桥）。
 *
 * 背景：助手写面板/账本落盘后，若再用 handlePrompt("/panelsync") 收编，
 * 在剧情回合中（assistant_run 工具执行期间）会 followUp 排队 → 死锁。
 * roleplay 在 session_start 注册回调；server 写盘后直接调用。
 */

type SyncFn = () => void;

let panelSync: SyncFn | null = null;
let stateSync: SyncFn | null = null;

export function registerStoryPanelSync(fn: SyncFn | null): void {
	panelSync = fn;
}

export function registerStoryStateSync(fn: SyncFn | null): void {
	stateSync = fn;
}

/** 从磁盘收编剧情扩展的面板内存 + 树快照（无注册时 no-op） */
export function syncStoryPanelsFromDisk(): void {
	try {
		panelSync?.();
	} catch {
		// 扩展未就绪时忽略；下轮 context 仍会从盘读
	}
}

/** 从磁盘收编剧情扩展的世界状态内存 + 树快照 */
export function syncStoryStateFromDisk(): void {
	try {
		stateSync?.();
	} catch {
		// ignore
	}
}
