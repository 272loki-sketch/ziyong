/** wire 协议类型：单一事实源在 server/wire.ts；此处仅添加 Web 端兼容扩展。 */
import type {
	ClientFrame as ServerClientFrame,
	ServerFrame as ServerServerFrame,
} from "../../server/wire.ts";
import type { GenerationMode } from "./generation-mode.ts";

export type {
	AssistantModelInfo,
	AssistantMsg,
	AssistantSessionInfo,
	RpPanel,
	UpdateWire,
	WireActivity,
	WireChannel,
	WireChoice,
	WireMsg,
	WireBeatWorkflow,
	WireTurnPerformance,
	WireWorkflowStage,
	WireWorkflowStatus,
	WireSessionInfo,
	WireStats,
	WireSwipe,
	WorldState,
} from "../../server/wire.ts";
export type { GenerationMode } from "./generation-mode.ts";

type ClientFrameWithGenerationMode<T> = T extends { type: "prompt" }
	? T & { generationMode?: GenerationMode }
	: T;
type ServerFrameWithGenerationMode<T> = T extends { type: "hello" }
	? T & { generationMode?: GenerationMode }
	: T;

/** 后端发布 generationMode 字段前后，前端都保持类型安全。 */
export type ClientFrame = ClientFrameWithGenerationMode<ServerClientFrame>;
export type ServerFrame = ServerFrameWithGenerationMode<ServerServerFrame>;
