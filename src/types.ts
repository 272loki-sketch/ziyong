/**
 * 领域层共享类型。
 * 本目录（src/）不允许 import pi 的任何东西（PLAN.md D3）。
 */

/** 归一化后的角色卡（兼容 V1 / V2 chara_card_v2 / V3 chara_card_v3 / ST 导出格式） */
export interface CharacterCard {
	name: string;
	description: string;
	personality: string;
	scenario: string;
	firstMes: string;
	mesExample: string;
	/** 卡作者自带的 system prompt（规范语义：非空时优先于应用默认主提示） */
	systemPrompt: string;
	/** 卡作者的 post-history instructions（注入上下文末端） */
	postHistoryInstructions: string;
	creatorNotes: string;
	alternateGreetings: string[];
	tags: string[];
	/** 卡内嵌世界书（character_book），已归一化 */
	book: LorebookEntry[];
}

/** 归一化后的世界书条目（兼容 ST world info 格式与卡内嵌 character_book 格式） */
export interface LorebookEntry {
	uid: number;
	keys: string[];
	secondaryKeys: string[];
	comment: string;
	content: string;
	constant: boolean;
	enabled: boolean;
	/** 是否要求次要关键词也命中（AND_ANY 语义，v0 仅实现该逻辑） */
	selective: boolean;
	order: number;
	/** 统一知识集合中的来源，仅供审计；不参与检索或冲突判定。 */
	source?: string;
}

/**
 * 登场名录：人物/物品/事件三张**追加式索引表**（供 agent 索引，不是给正文全量注入的内容）。
 * 登场过就永远在案——活跃状态里删掉（离场/消耗/了结）后名录仍保留，
 * 配合 memory_search 可召回细节。值为登记时的一句话（可空）。
 */
export interface StateRoster {
	characters: Record<string, string>;
	items: Record<string, string>;
	events: Record<string, string>;
}

/** 结构化世界状态（v0 schema，可扩展） */
export interface WorldState {
	/** 剧情内时间，自由文本（如「第二天清晨」） */
	time: string;
	/** 当前地点 */
	location: string;
	/** 出场角色状态，键为角色名 */
	characters: Record<string, CharacterState>;
	/** {{user}} 的物品栏 */
	inventory: string[];
	/** 自由键值对（誓言、秘密、天气等） */
	flags: Record<string, string>;
	/** 未了结的剧情线/伏笔 */
	plot_threads: string[];
	/** 登场名录（applyPatch 咽喉点自动登记；旧存档无此字段按空处理） */
	roster?: StateRoster;
}

export interface CharacterState {
	/** 对 {{user}} 的好感/态度，-100..100 */
	affinity: number;
	/** 当前身体/处境状态 */
	status: string;
	/** 备注（承诺、得知的秘密等） */
	notes: string;
}

/** 项目配置（app/liyuan.config.json；旧名 rp.config.json 启动时迁移） */
export interface RpConfig {
	/** 角色卡路径（.png 或 .json），相对项目根 */
	card: string;
	/**
	 * 已挂载的独立世界书路径列表（可 0..N 本同时启用；与角色卡无关，换卡不清除）。
	 * 装配顺序即数组合序；条目按内容指纹去重。
	 */
	lorebooks?: string[];
	/**
	 * @deprecated 旧版单本挂载；读时迁入 lorebooks，写盘时只保留 lorebooks。
	 */
	lorebook?: string;
	/** {{user}} 的名字 */
	userName: string;
	/** Web 顶栏的角色显示名覆盖（可选；不影响 {{char}} 宏与提示词，仅显示层。适用于卡 name 是剧本标题的场景卡） */
	displayName?: string;
	/** {{user}} 的人设描述（可选） */
	userPersona: string;
	/** 回复语言 */
	language: string;
	/** 关键词扫描回溯的消息条数 */
	scanDepth: number;
	/** 每轮关键词自动注入的条目上限 */
	maxLoreInjections: number;
	/** 是否在新会话注入开场白 */
	greeting: boolean;
	/** 开场白选择：0=卡的 first_mes（默认），1..n=alternate_greetings 第 n 条；越界回落 first_mes */
	greetingIndex?: number;
	/** 被用户停用的世界书条目（内容指纹列表，见 lorebook.ts loreFingerprint；跨 uid 冲突稳定） */
	disabledLore?: string[];
	/** /import 清洗时额外剥离的标签（叠加在默认思维链/状态栏列表之上，按预设约定配置） */
	importStripTags?: string[];
	/** 转换后的预设文件路径（liyuan-preset.json，可选；由 scripts/convert-preset.mjs 生成） */
	preset?: string;
	/** 本机工具总开关：开则 bash/读写等回到工具底座；本机开发默认开，分发默认关 */
	backendControl?: boolean;
	/** 决策门禁档位（PLAN-PHASE4 柱 1）：ask=关键剧情决策点停笔询问用户；silent=不问，等同旧行为。默认 silent */
	creationMode?: "ask" | "silent";
	/**
	 * 固定楼层压缩：每 N 个叙事轮主动压缩一次早期正文（被裁正文先完整归档进剧情库供召回）。
	 * 0 = 关闭自动压缩（仍可手动触发）。缺省 30。
	 */
	compactEveryNTurns?: number;
	/**
	 * 右栏「助手」的独立模型（2026-07-14 拆分决策）：缺省=跟随剧情模型。
	 * 剧情尺度大时可在助手面板单独指定宽容系模型（拒答风险与剧情模型解耦）。
	 */
	assistantModel?: { provider: string; id: string };
	/** 一档卡皮肤:显示向美化正则被用户关闭的卡路径列表(默认开;spec 2026-07-22 §7 P1) */
	cardSkinOff?: string[];
	/** 文学工作流：profile=周期画像；guided=画像+条件连续性+每拍导演；均不修改状态 */
	literaryQuality?: "off" | "profile" | "guided";
	/** 文学画像刷新周期（完成的叙事拍数）；首次启用会在第一拍后生成 */
	literaryProfileEveryNTurns?: number;
	/** 后台世界推演；规则来自 workflow: world 的用户 Skill，状态随分支树回档。 */
	literaryWorldEnabled?: boolean;
	/** 鲜活世界生态：每拍补充双池并推进人物、地点、日程与可错过事件。 */
	literaryEcologyEnabled?: boolean;
	/** 联网查证：off=关闭；auto=模型按需；manual=仅用户本拍明确要求联网时可用 */
	webResearchMode?: "off" | "auto" | "manual";
	/** 小说长文消化：支持手动导入、手动选书与可选的每日自动任务。 */
	novelDigest?: {
		enabled: boolean;
		chunkChars: number;
		maxCallsPerDoc: number;
		autoSchedule?: {
			enabled: boolean;
			hour: number;
			minute: number;
			maxPerRun: number;
			queries: string[];
		};
	};
	/** 普通研究搜索的每日自动任务；默认关闭，避免未确认的联网和模型成本。 */
	researchSearchSchedule?: {
		enabled: boolean; hour: number; minute: number; maxPerRun: number; topics: string[];
	};
	/** 各旁路步骤的项目级模型覆盖；缺少某项即继承当前剧情总插头 */
	stepModels?: import("./model-routing.ts").StepModelOverrides;
}

export const DEFAULT_CONFIG: RpConfig = {
	card: "assets/cards/default_Qingwu.json",
	// 默认不挂书：角色卡与世界书解耦，用户按需多选挂载
	lorebooks: [],
	userName: "旅人",
	userPersona: "",
	language: "中文",
	scanDepth: 4,
	maxLoreInjections: 3,
	greeting: true,
	backendControl: true,
	compactEveryNTurns: 30,
	literaryQuality: "off",
	literaryProfileEveryNTurns: 8,
	literaryWorldEnabled: false,
	literaryEcologyEnabled: false,
	creationMode: "silent",
	webResearchMode: "off",
	researchSearchSchedule: { enabled: false, hour: 6, minute: 0, maxPerRun: 3, topics: ["校园恋爱中的慢热互信", "日常剧情中的关系推进", "悬疑故事的信息分配"] },
	novelDigest: {
		enabled: true,
		chunkChars: 20000,
		maxCallsPerDoc: 800,
		autoSchedule: { enabled: false, hour: 5, minute: 0, maxPerRun: 3, queries: ["学園 日常", "現代 日常 社会人", "青春 日常"] },
	},
};

/** 宏替换上下文 */
export interface MacroContext {
	charName: string;
	userName: string;
}
