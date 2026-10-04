export type DirectorTab = "room" | "diagnostics" | "map" | "characters" | "foreshadowing" | "proposals" | "versions" | "research" | "search" | "corpus" | "novel-play" | "memory" | "world" | "system";
export interface DirectorModuleDefinition { id: DirectorTab; label: string; note: string; group: "创作" | "故事" | "资料" | "系统"; }
export const DIRECTOR_MODULES: DirectorModuleDefinition[] = [
 { id: "room", label: "创作对谈", note: "和导演讨论下一步", group: "创作" },
 { id: "proposals", label: "提案审阅", note: "确认大纲修改", group: "创作" },
 { id: "map", label: "故事脉络", note: "主线、线索与里程碑", group: "故事" },
 { id: "characters", label: "人物成长", note: "角色变化与方向", group: "故事" },
 { id: "foreshadowing", label: "伏笔追踪", note: "埋设、强化与回收", group: "故事" },
 { id: "world", label: "世界状态", note: "世界画像与模块运行态", group: "故事" },
	{ id: "corpus", label: "藏书消化", note: "提炼小说结构与素材", group: "资料" },
	{ id: "novel-play", label: "小说开演", note: "从已消化小说创建新会话", group: "资料" },
 { id: "search", label: "研究搜索", note: "搜索书评影评提炼套路", group: "资料" },
 { id: "research", label: "创作素材库", note: "检索可复用机制", group: "资料" },
 { id: "diagnostics", label: "演出回放", note: "查看每拍执行工件", group: "系统" },
 { id: "memory", label: "记忆", note: "事件卡 · 弧线 · 审计日志", group: "系统" },
 { id: "versions", label: "版本与设置", note: "历史记录和工作模式", group: "系统" },
 { id: "system", label: "系统总览", note: "配置、模型与后台任务", group: "系统" },
];
export const DIRECTOR_GROUPS = ["创作", "故事", "资料", "系统"] as const;
export const DIRECTOR_MODULE_GROUPS = DIRECTOR_GROUPS.map((group) => ({ label: group, tabs: DIRECTOR_MODULES.filter((item) => item.group === group) }));
export const DIRECTOR_MODULE_BY_ID = new Map(DIRECTOR_MODULES.map((item) => [item.id, item] as const));
