import type { ServerFrame } from "./wire.ts";

/** 本地静态 bundle 的版本，由 Vite 从仓库根 package.json 注入。 */
declare const __LIYUAN_BUILD_VERSION__: string;

/** 延迟读取注入常量，让比较逻辑可以在无浏览器 fixture 中独立测试。 */
export function getFrontendBuildVersion(): string {
	return __LIYUAN_BUILD_VERSION__;
}

export type BuildVersionAlignment = "unknown" | "match" | "mismatch";

export type ServerVersionFrame =
	| Pick<Extract<ServerFrame, { type: "hello" | "assistant_hello" }>, "type" | "appVersion">
	| Pick<Extract<ServerFrame, { type: "update" }>, "type" | "update">;

/** 每个 hello 都是新的版本快照：字段缺失时返回未知，不回落到旧连接版本。 */
export function readServerVersion(frame: ServerVersionFrame): string | null {
	const version = frame.type === "update" ? frame.update.currentVersion : frame.appVersion;
	return typeof version === "string" ? version.trim() || null : null;
}

/** 未收到可信服务端版本时保持 unknown；绝不把“未知”显示成“版本一致”。 */
export function getBuildVersionAlignment(frontendVersion: string, serverVersion: string | null | undefined): BuildVersionAlignment {
	const frontend = frontendVersion.trim();
	const server = serverVersion?.trim();
	if (!frontend || !server) return "unknown";
	return frontend === server ? "match" : "mismatch";
}
