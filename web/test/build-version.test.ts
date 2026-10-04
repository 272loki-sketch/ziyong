import assert from "node:assert/strict";
import test from "node:test";
import { getBuildVersionAlignment, readServerVersion, type ServerVersionFrame } from "../src/build-version.ts";

test("build version alignment requires an actual server version", () => {
	assert.equal(getBuildVersionAlignment("bundle-fixture", null), "unknown");
	assert.equal(getBuildVersionAlignment("bundle-fixture", "  "), "unknown");
});

test("build version alignment distinguishes a match from a mismatch", () => {
	assert.equal(getBuildVersionAlignment("bundle-fixture", "bundle-fixture"), "match");
	assert.equal(getBuildVersionAlignment("bundle-fixture", "server-fixture"), "mismatch");
});

test("legacy hello snapshots replace a previously known version with unknown", () => {
	for (const type of ["hello", "assistant_hello"] as const) {
		let serverVersion = readServerVersion({ type, appVersion: "previous-host-fixture" });
		assert.equal(serverVersion, "previous-host-fixture");
		serverVersion = readServerVersion({ type });
		assert.equal(serverVersion, null);
		assert.equal(getBuildVersionAlignment("bundle-fixture", serverVersion), "unknown");
		assert.equal(readServerVersion({ type, appVersion: "  " }), null);
	}
});

test("reconnecting hello replaces the old host version even for the same session", () => {
	let serverVersion: string | null = null;
	const snapshots: ServerVersionFrame[] = [
		{ type: "hello", appVersion: "old-host-fixture" },
		{ type: "assistant_hello", appVersion: "old-host-fixture" },
		{ type: "hello", appVersion: "bundle-fixture" },
		{ type: "assistant_hello", appVersion: "bundle-fixture" },
	];
	for (const frame of snapshots) {
		serverVersion = readServerVersion(frame);
		assert.equal(serverVersion, frame.appVersion);
	}
	assert.equal(getBuildVersionAlignment("bundle-fixture", serverVersion), "match");
});

test("version mismatch uses the host's appVersion, not the frontend build", () => {
	for (const type of ["hello", "assistant_hello"] as const) {
		const serverVersion = readServerVersion({ type, appVersion: "different-host-fixture" });
		assert.equal(serverVersion, "different-host-fixture");
		assert.equal(getBuildVersionAlignment("bundle-fixture", serverVersion), "mismatch");
	}
});

test("update frames refresh currentVersion but never substitute latestVersion", () => {
	let serverVersion = readServerVersion({ type: "hello", appVersion: "hello-host-fixture" });
	serverVersion = readServerVersion({
		type: "update",
		update: { phase: "none", currentVersion: "  update-host-fixture  ", latestVersion: "bundle-fixture" },
	});
	assert.equal(serverVersion, "update-host-fixture");
	assert.equal(getBuildVersionAlignment("bundle-fixture", serverVersion), "mismatch");
	serverVersion = readServerVersion({ type: "hello" });
	assert.equal(serverVersion, null);
});
