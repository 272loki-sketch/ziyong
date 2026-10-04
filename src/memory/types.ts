/**
 * 梨园内置向量记忆（设置面板一等公民，非 Skill/MCP 栏）。
 * 两库：
 *  - narrative 剧情库：仅 agent 自动写入，合并入库（少条数）
 *  - external 额外库：导入文件 + 手动向量化（每条独立条目，可管理删除）
 * 嵌入：本地规则 / 云端专用 embedding（与 RP 连接分离）
 * 数据作用域：角色卡 + 对话会话
 */

export type MemoryStoreKind = "narrative" | "external" | "custom";

/**
 * 记忆数据作用域（与世界状态 / 面板同款：按会话隔离）。
 * sessionId = 当前对话；card = 角色卡路径（相对或绝对均可，内部会归一化）。
 */
export interface MemoryScope {
	sessionId: string;
	card?: string;
}

/** 嵌入模式：local=本机规则；cloud=OpenAI 兼容 embeddings 接口 */
export type EmbedMode = "local" | "cloud";

export interface MemoryCloudEmbed {
	/** 如 https://api.openai.com/v1 或中转 …/v1（不要带 /embeddings） */
	baseUrl: string;
	apiKey: string;
	/** 如 text-embedding-3-small */
	model: string;
}

export interface MemoryStoreConfig {
	id: string;
	name: string;
	kind: MemoryStoreKind;
	/** 单库开关（总开关关闭时全部不写不搜） */
	enabled: boolean;
	/**
	 * 仅 narrative：每隔多少次「助手叙事完成」合并入库。
	 * 1=每轮；3=每 3 轮；0=不自动写。剧情库禁止手动/导入。
	 */
	everyNTurns: number;
	/** 单库最大条数，超则丢最旧 */
	maxChunks: number;
}

export interface MemoryConfig {
	version: 1;
	/** 总开关：关=服务空转，不读写 */
	enabled: boolean;
	/** 检索默认条数（试检索 / 每轮注入） */
	searchTopK: number;
	/**
	 * 每轮剧情开始前，用用户本轮输入检索已启用库并注入【剧情记忆】。
	 * 总开关关闭时无效。
	 */
	injectOnTurn: boolean;
	/** 嵌入模式 */
	embedMode: EmbedMode;
	/** 云端 embedding（仅 embedMode=cloud；与剧情模型配置完全分离） */
	cloudEmbed: MemoryCloudEmbed;
	stores: MemoryStoreConfig[];
	/** 作用域维度计数：scopeId → 累计 agent_end 次数 */
	turnCounters?: Record<string, number>;
	/** 滚动事件提取游标：scopeId → 上次成功处理到的分支条目 id */
	eventCursors?: Record<string, string>;
}

export interface MemoryChunkMeta {
	sessionId?: string;
	card?: string;
	source?: "narrative" | "import" | "manual" | "archive" | "event" | "digest";
	/** 语义类型（PLAN-RP-MEMORY）：事件卡 / 纪要 / 原文证据 / 旧数据 */
	kind?: MemoryChunkKind;
	/** 重要性（core/major 不参与自动淘汰） */
	importance?: MemoryImportance;
	/** 事件卡稳定 id（event_first_meeting_001） */
	eventId?: string;
	/** 条目标题（手动录入/导入用） */
	title?: string;
	/** 原文锚点（压缩归档/事件卡必备） */
	sourceRefs?: MemorySourceRef[];
	/** 历史回照措辞（「那把伞」「第一次见面」「当年」） */
	recallAnchors?: string[];
	/** 证据锚定级别：source-backed=可回忆细节；summary-only=只能概括 */
	evidenceLevel?: MemoryEvidenceLevel;
	/** 生成时分支叶（后代分支可继承；兄弟分支不可见） */
	branchLeafId?: string;
	/** 事件所属剧情弧线，供扫荡型召回按线聚合。 */
	arc?: string;
	/** 导入文件名 */
	fileName?: string;
	/** 写入时的嵌入模式，检索时混用会质量差 */
	embedMode?: EmbedMode;
	embedModel?: string;
	/** 合并入库次数（剧情库） */
	mergeCount?: number;
	/** 最后更新时间 ISO */
	updatedAt?: string;
}

export interface MemoryChunk {
	id: string;
	text: string;
	/** L2 归一化向量 */
	embedding: number[];
	meta: MemoryChunkMeta;
	createdAt: string;
}

/** 列表用（不回传 embedding，省流量） */
export interface MemoryChunkListItem {
	id: string;
	text: string;
	textLen: number;
	meta: MemoryChunkMeta;
	createdAt: string;
}

export interface MemorySearchHit {
	id: string;
	text: string;
	score: number;
	meta: MemoryChunkMeta;
	createdAt: string;
}

export interface MemoryStoreStats {
	id: string;
	name: string;
	kind: MemoryStoreKind;
	enabled: boolean;
	everyNTurns: number;
	chunkCount: number;
	maxChunks: number;
}

export interface MemoryDiffRecord {
	ts: string;
	op: "create" | "merge" | "update" | "skip";
	eventId: string;
	title: string;
	arc?: string;
	reason: string;
}

export const DEFAULT_CLOUD_EMBED: MemoryCloudEmbed = {
	baseUrl: "https://api.openai.com/v1",
	apiKey: "",
	model: "text-embedding-3-small",
};

/** 剧情合并条目的软上限（字），超则新开一条 */
export const NARRATIVE_MERGE_MAX_CHARS = 1800;

/** 记忆对象语义类型（PLAN-RP-MEMORY §2/§5.2） */
export type MemoryChunkKind =
	| "digest" // 滚动剧情纪要 / 长期故事纪要（语义概括）
	| "event" // 事件卡（检索投影 + 原文锚定）
	| "evidence" // 原文证据（被压缩归档的早期正文）
	| "legacy"; // 旧数据，无 kind 标记

/** 事件/证据重要性（分级保活，core/major 不自动淘汰） */
export type MemoryImportance = "core" | "major" | "normal" | "minor";

/** 证据锚定级别：source-backed=有原文可用；summary-only=只有纪要 */
export type MemoryEvidenceLevel = "source-backed" | "summary-only";

/** 事件之间的显式关系；用于构造因果/演进链，不成为事实权威。 */
export type RpEventLinkType = "caused_by" | "evolved_from" | "resolved_the" | "contradicts";

export interface RpEventLink {
	/** 目标事件 canonical id；提取阶段可暂用同批 sourceKey，入库前会重写。 */
	to: string;
	type: RpEventLinkType;
	note?: string;
}

/** 原文锚点的可定位坐标（PLAN-RP-MEMORY §2.1） */
export interface MemorySourceRef {
	/** 分支条目 id（message/custom 等树条目） */
	entryId: string;
	/** 条目类型（message/custom/custom_message…）；未知时省略 */
	entryType?: string;
	/** 叙事拍序号（用户消息计数，1 起）；未知时省略 */
	turn?: number;
	/** 在该 entry 文本中的可选字符范围（精确证据回源） */
	charFrom?: number;
	charTo?: number;
}

/**
 * 一级事件卡（PLAN-RP-MEMORY §2.1）。
 * 检索投影 + 原文锚定，不成为第二套事实权威——事实以 rp-state/outline/当前分支为准。
 */
export interface RpEventDigest {
	kind: "rp-event-digest";
	id: string;
	/** 模型输出的稳定来源键；最终 id 由代码按 sourceRef 生成。 */
	sourceKey?: string;
	status: "candidate" | "active" | "resolved" | "retired";
	importance: MemoryImportance;
	title: string;
	turnRange?: { from: number; to: number };
	sourceRefs: MemorySourceRef[];
	participants?: string[];
	time?: string;
	location?: string;
	tags: string[];
	recallAnchors: string[];
	summary: string;
	evidenceLevel: MemoryEvidenceLevel;
	branchLeafId?: string;
	/** 同一长期剧情线的稳定名称（如“初遇误会线”）。 */
	arc?: string;
	/** 与其他事件的因果、演进、化解或冲突关系。 */
	links?: RpEventLink[];
	/** 提取旁路的去重意图；入库前由编排层消费，不持久化为事实字段。 */
	op?: "create" | "skip" | `merge:${string}`;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	version: 1,
	enabled: false,
	searchTopK: 5,
	injectOnTurn: true,
	embedMode: "local",
	cloudEmbed: { ...DEFAULT_CLOUD_EMBED },
	stores: [
		{
			id: "narrative",
			name: "剧情数据库",
			kind: "narrative",
			enabled: true,
			everyNTurns: 3,
			maxChunks: 300,
		},
		{
			id: "external",
			name: "额外数据库",
			kind: "external",
			enabled: true,
			everyNTurns: 0,
			maxChunks: 5000,
		},
	],
	turnCounters: {},
	eventCursors: {},
};
