import assert from "node:assert/strict";
import { test } from "node:test";

import { harvestLocalMediaPaths } from "../src/media-paths.ts";

test("harvestLocalMediaPaths：Windows 绝对路径", () => {
	const text = "已解码保存为 `C:\\Users\\test-user\\qingwu.png`（约 319KB）";
	const paths = harvestLocalMediaPaths(text);
	assert.ok(paths.some((p) => /qingwu\.png$/i.test(p)), paths.join("|"));
});

test("harvestLocalMediaPaths：正斜杠 Windows 路径", () => {
	const paths = harvestLocalMediaPaths("saved C:/tmp/out.webp ok");
	assert.deepEqual(paths, ["C:/tmp/out.webp"]);
});

test("harvestLocalMediaPaths：忽略 http 与无扩展名", () => {
	assert.deepEqual(harvestLocalMediaPaths("https://x.com/a.png 以及 C:\\Users\\x\\readme"), []);
});
