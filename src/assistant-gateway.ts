/**
 * 剧情 agent ↔ 右栏助手 的进程内网关（P0：助手工具化）。
 *
 * main 在启动助手 Host 后 register；roleplay 的 assistant_run 工具通过本模块调用。
 * 扩展与 server 解耦：扩展不 import server/*，只依赖本纯注册表。
 *
 * 【双模块陷阱】roleplay 由 jiti 加载（tryNative:false），main 走 Node 原生 ESM，
 * 两边对同一文件会各得到一份 module scope。runner / delegateDepth 必须挂在
 * globalThis 上，否则 register 写进 A、execute 读 B → 永远「助手不可用」。
 */

export type AssistantRunMode = "ops" | "author" | "diagnose" | "auto";

export interface AssistantRunRequest {
	/** 交给助手的任务说明（含用户原意与必要上下文摘要） */
	task: string;
	mode?: AssistantRunMode;
	/** 是否附带剧情快照（默认 true） */
	needStoryContext?: boolean;
	signal?: AbortSignal;
}

export interface AssistantRunMedia {
	src: string;
	kind: "image" | "audio" | "video";
	caption?: string;
}

export interface AssistantRunResult {
	ok: boolean;
	/** 给剧情模型看的摘要（工具结果正文） */
	summary: string;
	/** 本轮助手交付到剧情流的媒体（若有） */
	media: AssistantRunMedia[];
	/** 是否已写入剧情侧面板 */
	panelsWritten: string[];
	/** 用户/助手通过 ask 选择放弃 */
	abandoned?: boolean;
	/** 是否由 return_answer 正式交回（否则为回合结束时的兜底摘录） */
	viaReturnTool?: boolean;
	error?: string;
}

export type AssistantRunner = (req: AssistantRunRequest) => Promise<AssistantRunResult>;

type GatewaySlot = {
	runner: AssistantRunner | null;
	delegateDepth: number;
};

const SLOT_KEY = "__liyuanAssistantGateway__";

function slot(): GatewaySlot {
	const g = globalThis as typeof globalThis & { [SLOT_KEY]?: GatewaySlot };
	if (!g[SLOT_KEY]) {
		g[SLOT_KEY] = { runner: null, delegateDepth: 0 };
	}
	return g[SLOT_KEY];
}

/** server 启动助手后注册；测试可注入 mock */
export function registerAssistantRunner(fn: AssistantRunner | null): void {
	slot().runner = fn;
}

export function hasAssistantRunner(): boolean {
	return slot().runner !== null;
}

export function beginAssistantDelegate(): void {
	slot().delegateDepth++;
}

export function endAssistantDelegate(): void {
	const s = slot();
	s.delegateDepth = Math.max(0, s.delegateDepth - 1);
}

/** 当前是否处于剧情→助手委托回合（助手工具可双写剧情流） */
export function isAssistantDelegateActive(): boolean {
	return slot().delegateDepth > 0;
}

export async function runAssistantTask(req: AssistantRunRequest): Promise<AssistantRunResult> {
	const runner = slot().runner;
	if (!runner) {
		return {
			ok: false,
			summary: "助手不可用（未启动或没有可用模型）。请用户打开右栏助手面板，或检查模型配置。",
			media: [],
			panelsWritten: [],
			error: "no_runner",
		};
	}
	beginAssistantDelegate();
	try {
		return await runner(req);
	} finally {
		endAssistantDelegate();
	}
}
