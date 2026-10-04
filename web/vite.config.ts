import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
	throw new Error("根 package.json 缺少有效 version，无法标记梨园前端构建版本");
}
const buildVersion = packageJson.version.trim();

/** public 目录不会经过 Rollup transform；在静态文件复制完成后给本应用 SW 注入同一构建版本。 */
function versionedServiceWorker(): Plugin {
	let outputPath = "";
	return {
		name: "liyuan-service-worker-build-version",
		apply: "build",
		configResolved(config) {
			outputPath = resolve(config.root, config.build.outDir, "sw.js");
		},
		writeBundle() {
			const marker = "__LIYUAN_BUILD_VERSION__";
			const source = readFileSync(outputPath, "utf8");
			if (source.split(marker).length - 1 !== 1) {
				this.error("web/public/sw.js 必须且只能包含一个构建版本标记");
			}
			writeFileSync(outputPath, source.replace(marker, buildVersion), "utf8");
		},
	};
}

// dev 时 /ws 代理到本机 server（node server/main.ts）；host:true 让手机连 dev server 调试
export default defineConfig({
	define: {
		__LIYUAN_BUILD_VERSION__: JSON.stringify(buildVersion),
	},
	plugins: [react(), versionedServiceWorker()],
	server: {
		host: true,
		proxy: {
			"/ws": { target: "http://localhost:7620", ws: true },
			"/healthz": { target: "http://localhost:7620" },
		},
	},
});
