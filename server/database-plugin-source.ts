import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync, closeSync, existsSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync,
	readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

export const DEFAULT_DATABASE_PLUGIN_REF = "https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js";
export const DEFAULT_DATABASE_PLUGIN_SHA256 = "ff8981ea9f60bbada765ce79d576bf84963e842c12b683feb6e8fe22b74b8bac";
export const DATABASE_PLUGIN_MAX_BYTES = 12 * 1024 * 1024;
export const DATABASE_PLUGIN_MAX_CACHE_BYTES = 48 * 1024 * 1024;
export const DATABASE_PLUGIN_MAX_CACHED_SOURCES = 4;
export const DATABASE_PLUGIN_MAX_CACHED_REFS = 32;
const URL_PREFIX = "https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@";
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_WAIT_MS = 10_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DatabasePluginSourceConfig {
	ref: string;
	expectedSha256: string;
}

export interface DatabasePluginSource {
	ref: string;
	url: string;
	sha256: string;
	bytes: number;
	filePath: string;
	active: boolean;
}

export interface DatabasePluginSourceStoreOptions {
	cwd?: string;
	ref?: string;
	expectedSha256?: string;
	fetch?: FetchLike;
	/** Shorter values are useful for deterministic timeout tests; production defaults to 60 seconds. */
	downloadTimeoutMs?: number;
}

export interface DatabasePluginSourceRequest {
	ref?: string;
	expectedSha256?: string;
}

interface StoredSource {
	version: 1;
	ref: string;
	url: string;
	sha256: string;
	bytes: number;
}

interface ActivePointer {
	version: 1;
	current: StoredSource | null;
	previous: StoredSource | null;
}

interface CacheManifest {
	path: string;
	name: string;
	meta: StoredSource | null;
	size: number;
	mtimeMs: number;
}

interface CacheBlob {
	path: string;
	hash: string;
	size: number;
	mtimeMs: number;
}

interface CacheInventory {
	blobs: Map<string, CacheBlob>;
	manifests: CacheManifest[];
}

function normalizeRef(ref: unknown): string {
	if (typeof ref !== "string" || !ref.startsWith(URL_PREFIX)) {
		throw new Error("Database plugin ref must use the pinned jsDelivr host and package path");
	}
	const tag = ref.slice(URL_PREFIX.length, -"/index.js".length);
	if (!ref.endsWith("/index.js") || !TAG_PATTERN.test(tag) || tag === "." || tag === "..") {
		throw new Error("Database plugin ref must be a canonical tag URL ending in /index.js");
	}
	let parsed: URL;
	try { parsed = new URL(ref); }
	catch { throw new Error("Invalid database plugin ref URL"); }
	if (parsed.protocol !== "https:" || parsed.hostname !== "gcore.jsdelivr.net" || parsed.host !== "gcore.jsdelivr.net"
		|| parsed.username || parsed.password || parsed.search || parsed.hash
		|| parsed.pathname !== `/gh/AlbusKen/shujuku@${tag}/index.js` || parsed.href !== ref) {
		throw new Error("Database plugin ref contains a forbidden URL variant");
	}
	return ref;
}

function normalizeHash(hash: unknown): string {
	if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) throw new Error("expectedSha256 must be a 64-character SHA-256 hex digest");
	return hash.toLowerCase();
}

/** Parse explicit caller-provided configuration; application and production config files are never read here. */
export function readDatabasePluginSourceConfig(value?: Partial<DatabasePluginSourceConfig> | null): DatabasePluginSourceConfig {
	const ref = normalizeRef(value?.ref ?? DEFAULT_DATABASE_PLUGIN_REF);
	const expectedSha256 = normalizeHash(value?.expectedSha256 ?? DEFAULT_DATABASE_PLUGIN_SHA256);
	return { ref, expectedSha256 };
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function isExists(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "EEXIST"; }

/** Create/check each path component separately; no parent component may be a symlink. */
function ensureDirectoryTree(path: string, privateMode?: number): void {
	const absolute = resolve(path);
	const parsed = parse(absolute);
	const pieces = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
	let current = parsed.root;
	for (const piece of pieces) {
		current = join(current, piece);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe database plugin cache path component: ${current}`);
		} catch (error) {
			if (!isMissing(error)) throw error;
			try { mkdirSync(current, { mode: PRIVATE_DIR_MODE }); }
			catch (createError) { if (!isExists(createError)) throw createError; }
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe database plugin cache path component: ${current}`);
		}
	}
	if (privateMode !== undefined) chmodSync(absolute, privateMode);
}

function fsyncDirectory(path: string): void {
	try { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
	catch { /* Directory fsync is not supported on every platform. */ }
}

function writeTemp(path: string, bytes: Uint8Array): string {
	const temp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
	const fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
	try { writeFileSync(fd, bytes); fsyncSync(fd); }
	catch (error) { try { unlinkSync(temp); } catch {} throw error; }
	finally { closeSync(fd); }
	chmodSync(temp, PRIVATE_FILE_MODE);
	return temp;
}

/** Atomically publish a content-addressed sibling without ever replacing existing bytes. */
function publishImmutable(path: string, bytes: Uint8Array, isValidExisting: () => boolean): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || !isValidExisting()) {
			throw new Error(`Refusing to replace an invalid database plugin cache entry: ${path}`);
		}
		chmodSync(path, PRIVATE_FILE_MODE);
		return;
	} catch (error) { if (!isMissing(error)) throw error; }

	const temp = writeTemp(path, bytes);
	try {
		try { linkSync(temp, path); }
		catch (error) {
			if (!isExists(error) || !isValidExisting()) throw error;
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe database plugin cache entry: ${path}`);
		chmodSync(path, PRIVATE_FILE_MODE);
		fsyncDirectory(dirname(path));
	} finally { try { unlinkSync(temp); } catch {} }
}

function atomicReplace(path: string, bytes: Uint8Array): void {
	const temp = writeTemp(path, bytes);
	try {
		renameSync(temp, path);
		chmodSync(path, PRIVATE_FILE_MODE);
		fsyncDirectory(dirname(path));
	} finally { try { unlinkSync(temp); } catch {} }
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function refKey(ref: string, hash: string): string { return createHash("sha256").update(`${ref}\0${hash}`).digest("hex"); }

function isStoredSource(value: unknown): value is StoredSource {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StoredSource>;
	try {
		return item.version === 1 && normalizeRef(item.ref) === item.ref && item.url === item.ref
			&& normalizeHash(item.sha256) === item.sha256 && Number.isSafeInteger(item.bytes)
			&& Number(item.bytes) > 0 && Number(item.bytes) <= DATABASE_PLUGIN_MAX_BYTES;
	} catch { return false; }
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Database plugin download aborted");
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

function cancelResponse(response: Response): void { try { void response.body?.cancel().catch(() => {}); } catch {} }

/** Private local content-addressed cache of unchanged upstream source candidates. */
export class DatabasePluginSourceStore {
	readonly config: DatabasePluginSourceConfig;
	readonly cacheDir: string;
	readonly filesDir: string;
	readonly manifestsDir: string;
	readonly activePointerPath: string;
	private readonly fetchImpl: FetchLike;
	private readonly downloadTimeoutMs: number;

	constructor(options: DatabasePluginSourceStoreOptions = {}) {
		this.config = readDatabasePluginSourceConfig({ ref: options.ref, expectedSha256: options.expectedSha256 });
		const cwd = resolve(options.cwd ?? process.cwd());
		const productDir = join(cwd, ".liyuan-database-plugin");
		this.cacheDir = join(productDir, "cache");
		this.filesDir = join(this.cacheDir, "files");
		this.manifestsDir = join(this.cacheDir, "refs");
		this.activePointerPath = join(this.cacheDir, "active.json");
		this.ensureSafeStorage();
		this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.downloadTimeoutMs = options.downloadTimeoutMs ?? 60_000;
		if (!Number.isFinite(this.downloadTimeoutMs) || this.downloadTimeoutMs <= 0 || this.downloadTimeoutMs > 60_000) {
			throw new Error("downloadTimeoutMs must be greater than 0 and at most 60000");
		}
	}

	private ensureSafeStorage(): void {
		const productDir = dirname(this.cacheDir);
		ensureDirectoryTree(productDir, PRIVATE_DIR_MODE);
		ensureDirectoryTree(this.cacheDir, PRIVATE_DIR_MODE);
		ensureDirectoryTree(this.filesDir, PRIVATE_DIR_MODE);
		ensureDirectoryTree(this.manifestsDir, PRIVATE_DIR_MODE);
	}

	private blobPath(hash: string): string { return join(this.filesDir, `${hash}.js`); }
	private manifestPath(ref: string, hash: string): string { return join(this.manifestsDir, `${refKey(ref, hash)}.json`); }

	private withCacheLock<T>(run: () => T): T {
		this.ensureSafeStorage();
		const lockPath = join(this.cacheDir, ".source-cache.lock");
		const token = randomBytes(16).toString("hex");
		const deadline = Date.now() + LOCK_WAIT_MS;
		let lockFd: number | undefined;
		const waitCell = new Int32Array(new SharedArrayBuffer(4));
		for (;;) {
			try {
				lockFd = openSync(lockPath, "wx", PRIVATE_FILE_MODE);
				writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token }));
				fsyncSync(lockFd);
				chmodSync(lockPath, PRIVATE_FILE_MODE);
				break;
			} catch (error) {
				if (lockFd !== undefined) {
					try { closeSync(lockFd); } catch {}
					lockFd = undefined;
					try {
						const stat = lstatSync(lockPath);
						if (!stat.isSymbolicLink() && stat.isFile()) unlinkSync(lockPath);
					} catch { /* Preserve a lock path changed by another process. */ }
					throw error;
				}
				if (!isExists(error)) throw error;
				this.ensureSafeStorage();
				let lockStat;
				try {
					lockStat = lstatSync(lockPath);
					if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error("Unsafe database plugin cache lock");
				} catch (statError) { if (isMissing(statError)) continue; throw statError; }
				let ownerPid = 0;
				try {
					const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
					if (Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) ownerPid = Number(lock.pid);
				} catch { /* An incomplete lock will be reclaimed only if its owner is not alive. */ }
				// A newly-created lock is briefly empty before its owner writes PID/token.
				let alive = !ownerPid && Date.now() - lockStat.mtimeMs < 1_000;
				if (ownerPid) {
					try { process.kill(ownerPid, 0); alive = true; }
					catch (killError) { alive = (killError as NodeJS.ErrnoException).code === "EPERM"; }
				}
				if (!alive) {
					try { unlinkSync(lockPath); } catch (unlinkError) { if (!isMissing(unlinkError)) throw unlinkError; }
					continue;
				}
				if (Date.now() >= deadline) throw new Error("Timed out waiting for database plugin cache lock");
				Atomics.wait(waitCell, 0, 0, 20);
			}
		}
		try {
			this.ensureSafeStorage();
			return run();
		} finally {
			if (lockFd !== undefined) { try { closeSync(lockFd); } catch {} }
			try {
				const stat = lstatSync(lockPath);
				if (!stat.isSymbolicLink() && stat.isFile()) {
					const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
					if (lock.token === token) unlinkSync(lockPath);
				}
			} catch { /* Preserve unexpected lock changes; subsequent operations fail closed if needed. */ }
		}
	}

	private activeState(): ActivePointer {
		this.ensureSafeStorage();
		try {
			const stat = lstatSync(this.activePointerPath);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error("Database plugin active pointer is unsafe");
			chmodSync(this.activePointerPath, PRIVATE_FILE_MODE);
			const parsed: unknown = JSON.parse(readFileSync(this.activePointerPath, "utf8"));
			const pointer = parsed as Partial<ActivePointer> | null;
			if (!pointer || pointer.version !== 1 || !(pointer.current === null || isStoredSource(pointer.current))
				|| !(pointer.previous === null || isStoredSource(pointer.previous))) {
				throw new Error("Database plugin active pointer is invalid; refusing to alter it");
			}
			return { version: 1, current: pointer.current ?? null, previous: pointer.previous ?? null };
		} catch (error) {
			if (isMissing(error)) return { version: 1, current: null, previous: null };
			throw error;
		}
	}

	private readStoredBytes(source: StoredSource): Buffer | null {
		this.ensureSafeStorage();
		const path = this.blobPath(source.sha256);
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== source.bytes || stat.size > DATABASE_PLUGIN_MAX_BYTES) return null;
			chmodSync(path, PRIVATE_FILE_MODE);
			const bytes = readFileSync(path);
			return sha256(bytes) === source.sha256 ? bytes : null;
		} catch { return null; }
	}

	private sourceResult(meta: StoredSource): DatabasePluginSource {
		const current = this.activeState().current;
		return { ref: meta.ref, url: meta.url, sha256: meta.sha256, bytes: meta.bytes,
			filePath: this.blobPath(meta.sha256), active: current?.ref === meta.ref && current.sha256 === meta.sha256 };
	}

	private readManifest(ref: string, hash: string): StoredSource | null {
		this.ensureSafeStorage();
		const path = this.manifestPath(ref, hash);
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2048) return null;
			chmodSync(path, PRIVATE_FILE_MODE);
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isStoredSource(parsed) || parsed.ref !== ref || parsed.sha256 !== hash) return null;
			return parsed;
		} catch { return null; }
	}

	private async readResponseBody(response: Response, signal: AbortSignal): Promise<Buffer> {
		const contentLength = response.headers.get("content-length");
		if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > DATABASE_PLUGIN_MAX_BYTES) {
			cancelResponse(response);
			throw new Error(`Database plugin source exceeds ${DATABASE_PLUGIN_MAX_BYTES} byte limit`);
		}
		if (!response.body) throw new Error("Database plugin response has no body");
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await waitWithAbort(reader.read(), signal);
				if (done) break;
				total += value.byteLength;
				if (total > DATABASE_PLUGIN_MAX_BYTES) {
					try { void reader.cancel().catch(() => {}); } catch {}
					throw new Error(`Database plugin source exceeds ${DATABASE_PLUGIN_MAX_BYTES} byte limit`);
				}
				chunks.push(Buffer.from(value));
			}
		} catch (error) {
			try { void reader.cancel(error).catch(() => {}); } catch {}
			throw error;
		} finally {
			try { reader.releaseLock(); } catch { /* A canceled stream may still be settling its pending read. */ }
		}
		return Buffer.concat(chunks, total);
	}

	private cleanupTemporaryEntries(): void {
		for (const dir of [this.cacheDir, this.filesDir, this.manifestsDir]) {
			this.ensureSafeStorage();
			for (const name of readdirSync(dir)) {
				if (!name.startsWith(".tmp-")) continue;
				const path = join(dir, name), stat = lstatSync(path);
				if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe temporary database plugin cache entry: ${path}`);
				unlinkSync(path);
			}
		}
	}

	private inventory(): CacheInventory {
		this.ensureSafeStorage();
		const blobs = new Map<string, CacheBlob>();
		for (const name of readdirSync(this.filesDir)) {
			if (name.startsWith(".tmp-")) continue;
			const path = join(this.filesDir, name), stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || !name.endsWith(".js") || !HASH_PATTERN.test(name.slice(0, -3))) {
				throw new Error(`Unexpected or unsafe database plugin cache blob: ${path}`);
			}
			const hash = name.slice(0, -3);
			if (stat.size <= 0 || stat.size > DATABASE_PLUGIN_MAX_BYTES || sha256(readFileSync(path)) !== hash) {
				throw new Error(`Corrupt database plugin cache blob: ${path}`);
			}
			blobs.set(hash, { path, hash, size: stat.size, mtimeMs: stat.mtimeMs });
		}
		const manifests: CacheManifest[] = [];
		for (const name of readdirSync(this.manifestsDir)) {
			if (name.startsWith(".tmp-")) continue;
			const path = join(this.manifestsDir, name), stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || !name.endsWith(".json") || !/^[a-f0-9]{64}\.json$/.test(name)) {
				throw new Error(`Unexpected or unsafe database plugin cache metadata: ${path}`);
			}
			let meta: StoredSource | null = null;
			if (stat.size <= 2048) {
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (isStoredSource(value) && name === `${refKey(value.ref, value.sha256)}.json`) meta = value;
				} catch { /* Corrupt metadata counts toward quota and is not eligible for eviction. */ }
			}
			manifests.push({ path, name, meta, size: stat.size, mtimeMs: stat.mtimeMs });
		}
		return { blobs, manifests };
	}

	private makeCacheRoom(incoming: StoredSource, manifestBytes: Buffer): void {
		const inventory = this.inventory();
		const state = this.activeState();
		const protectedHashes = new Set([state.current?.sha256, state.previous?.sha256, incoming.sha256].filter((x): x is string => !!x));
		const protectedManifestNames = new Set([
			state.current && `${refKey(state.current.ref, state.current.sha256)}.json`,
			state.previous && `${refKey(state.previous.ref, state.previous.sha256)}.json`,
			`${refKey(incoming.ref, incoming.sha256)}.json`,
		].filter((x): x is string => !!x));
		const keptBlobs = new Set(inventory.blobs.keys());
		const keptManifests = new Set(inventory.manifests.map((row) => row.name));
		const blobByHash = inventory.blobs;
		const manifestByName = new Map(inventory.manifests.map((row) => [row.name, row]));
		const incomingManifestName = `${refKey(incoming.ref, incoming.sha256)}.json`;
		const existingIncomingManifest = manifestByName.get(incomingManifestName);
		if (existingIncomingManifest && (!existingIncomingManifest.meta
			|| existingIncomingManifest.meta.ref !== incoming.ref
			|| existingIncomingManifest.meta.sha256 !== incoming.sha256
			|| existingIncomingManifest.meta.bytes !== incoming.bytes)) {
			throw new Error("Existing database plugin candidate metadata is invalid; refusing to evict cache entries");
		}
		if (keptBlobs.has(incoming.sha256)) {
			const existing = this.readStoredBytes(incoming);
			if (!existing) throw new Error("Existing content-addressed database plugin blob is invalid; refusing to replace it");
		}
		const selectedBlobDeletes = new Set<string>();
		const selectedManifestDeletes = new Set<string>();
		const blobSize = (hash: string) => blobByHash.get(hash)?.size ?? (hash === incoming.sha256 ? incoming.bytes : 0);
		const manifestSize = (name: string) => manifestByName.get(name)?.size ?? (name === incomingManifestName ? manifestBytes.length : 0);
		const totals = () => {
			const blobs = [...keptBlobs].reduce((sum, hash) => sum + blobSize(hash), 0) + (keptBlobs.has(incoming.sha256) ? 0 : incoming.bytes);
			const manifests = [...keptManifests].reduce((sum, name) => sum + manifestSize(name), 0)
				+ (keptManifests.has(incomingManifestName) ? 0 : manifestBytes.length);
			const blobCount = keptBlobs.size + (keptBlobs.has(incoming.sha256) ? 0 : 1);
			const manifestCount = keptManifests.size + (keptManifests.has(incomingManifestName) ? 0 : 1);
			return { blobs, manifests, blobCount, manifestCount };
		};
		const removeBlobGroup = (hash: string): void => {
			if (protectedHashes.has(hash)) return;
			keptBlobs.delete(hash);
			selectedBlobDeletes.add(hash);
			for (const row of inventory.manifests) {
				if (row.meta?.sha256 === hash && !protectedManifestNames.has(row.name)) {
					keptManifests.delete(row.name);
					selectedManifestDeletes.add(row.name);
				}
			}
		};
		const evictOldestBlob = (): boolean => {
			const choices = [...keptBlobs].filter((hash) => !protectedHashes.has(hash) && hash !== incoming.sha256)
				.sort((a, b) => (blobByHash.get(a)?.mtimeMs ?? 0) - (blobByHash.get(b)?.mtimeMs ?? 0));
			if (!choices.length) return false;
			removeBlobGroup(choices[0]);
			return true;
		};
		const evictOldestManifest = (): boolean => {
			const choices = [...keptManifests].map((name) => manifestByName.get(name)).filter((row): row is CacheManifest => !!row
				&& !!row.meta && !protectedManifestNames.has(row.name))
				.sort((a, b) => a.mtimeMs - b.mtimeMs);
			if (!choices.length) return false;
			const row = choices[0];
			keptManifests.delete(row.name);
			selectedManifestDeletes.add(row.name);
			if (row.meta && !protectedHashes.has(row.meta.sha256)
				&& ![...keptManifests].some((name) => manifestByName.get(name)?.meta?.sha256 === row.meta!.sha256)) {
				keptBlobs.delete(row.meta.sha256);
				selectedBlobDeletes.add(row.meta.sha256);
			}
			return true;
		};

		let current = totals();
		while (current.blobCount > DATABASE_PLUGIN_MAX_CACHED_SOURCES || current.blobs > DATABASE_PLUGIN_MAX_CACHE_BYTES) {
			if (!evictOldestBlob()) throw new Error("Database plugin cache is full; active and rollback sources are retained");
			current = totals();
		}
		while (current.manifestCount > DATABASE_PLUGIN_MAX_CACHED_REFS) {
			if (!evictOldestManifest()) throw new Error("Database plugin candidate reference cache is full");
			current = totals();
		}
		while (current.blobs + current.manifests > DATABASE_PLUGIN_MAX_CACHE_BYTES) {
			if (!evictOldestBlob() && !evictOldestManifest()) throw new Error("Database plugin cache byte limit reached; active and rollback sources are retained");
			current = totals();
		}

		for (const name of selectedManifestDeletes) {
			const row = manifestByName.get(name);
			if (row) unlinkSync(row.path);
		}
		for (const hash of selectedBlobDeletes) {
			const row = blobByHash.get(hash);
			if (row) unlinkSync(row.path);
		}
		fsyncDirectory(this.filesDir);
		fsyncDirectory(this.manifestsDir);
	}

	/** Downloads only a canonical pinned jsDelivr ref and stores a SHA-256-verified update candidate. */
	async downloadSource(request: DatabasePluginSourceRequest = {}): Promise<DatabasePluginSource> {
		const ref = normalizeRef(request.ref ?? this.config.ref);
		const expectedSha256 = normalizeHash(request.expectedSha256 ?? this.config.expectedSha256);
		this.ensureSafeStorage();
		const existing = this.readManifest(ref, expectedSha256);
		if (existing && this.readStoredBytes(existing)) return this.sourceResult(existing);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error("Database plugin download timed out")), this.downloadTimeoutMs);
		let bytes: Buffer;
		try {
			const response = await waitWithAbort(this.fetchImpl(ref, {
				method: "GET", redirect: "manual", signal: controller.signal,
				headers: { accept: "application/javascript, text/javascript;q=0.9, */*;q=0.1" },
			}), controller.signal);
			if (response.status >= 300 && response.status < 400) {
				cancelResponse(response);
				throw new Error("Database plugin redirects are forbidden");
			}
			if (!response.ok || response.status !== 200) {
				cancelResponse(response);
				throw new Error(`Database plugin download failed with HTTP ${response.status}`);
			}
			if (response.url && response.url !== ref) {
				cancelResponse(response);
				throw new Error("Database plugin response URL does not match the pinned ref");
			}
			bytes = await this.readResponseBody(response, controller.signal);
		} finally { clearTimeout(timeout); }
		if (!bytes.length) throw new Error("Database plugin source is empty");
		const actualHash = sha256(bytes);
		if (actualHash !== expectedSha256) throw new Error(`Database plugin SHA-256 mismatch (expected ${expectedSha256}, got ${actualHash})`);
		const meta: StoredSource = { version: 1, ref, url: ref, sha256: actualHash, bytes: bytes.length };
		const manifestBytes = Buffer.from(JSON.stringify(meta), "utf8");

		return this.withCacheLock(() => {
			this.ensureSafeStorage();
			this.cleanupTemporaryEntries();
			const raced = this.readManifest(ref, actualHash);
			if (raced && this.readStoredBytes(raced)) return this.sourceResult(raced);
			this.makeCacheRoom(meta, manifestBytes);
			const blobPath = this.blobPath(actualHash);
			publishImmutable(blobPath, bytes, () => {
				try {
					const stat = lstatSync(blobPath);
					return !stat.isSymbolicLink() && stat.isFile() && stat.size === bytes.length && sha256(readFileSync(blobPath)) === actualHash;
				} catch { return false; }
			});
			const manifestPath = this.manifestPath(ref, actualHash);
			publishImmutable(manifestPath, manifestBytes, () => {
				const stored = this.readManifest(ref, actualHash);
				return !!stored && stored.bytes === bytes.length;
			});
			return this.sourceResult(meta);
		});
	}

	/** Reports local readiness metadata for a pinned source without downloading or activating it. */
	resolveSource(request: DatabasePluginSourceRequest = {}): DatabasePluginSource | null {
		const ref = normalizeRef(request.ref ?? this.config.ref);
		const hash = normalizeHash(request.expectedSha256 ?? this.config.expectedSha256);
		this.ensureSafeStorage();
		const meta = this.readManifest(ref, hash);
		if (!meta || !this.readStoredBytes(meta)) return null;
		return this.sourceResult(meta);
	}

	/** Reads current active JS, or the configured pin before an active override exists; read-only and network-free. */
	readCurrentPinnedJS(): Buffer {
		const active = this.activeState().current;
		if (active) {
			const bytes = this.readStoredBytes(active);
			if (!bytes) throw new Error("Active database plugin source failed revalidation");
			return bytes;
		}
		const source = this.resolveSource();
		if (!source) throw new Error("Configured pinned database plugin source is not ready in the local cache");
		const meta: StoredSource = { version: 1, ref: source.ref, url: source.url, sha256: source.sha256, bytes: source.bytes };
		const bytes = this.readStoredBytes(meta);
		if (!bytes) throw new Error("Cached database plugin source failed revalidation");
		return bytes;
	}

	/** Explicitly activates a verified cached candidate, retaining the former current source for rollback. */
	async activateRef(hash: string): Promise<DatabasePluginSource> {
		const expected = normalizeHash(hash);
		return this.withCacheLock(() => {
			this.cleanupTemporaryEntries();
			const candidates: StoredSource[] = [];
			for (const entry of readdirSync(this.manifestsDir)) {
				if (!entry.endsWith(".json")) continue;
				const path = join(this.manifestsDir, entry), stat = lstatSync(path);
				if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2048) continue;
				try {
					const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (isStoredSource(parsed) && parsed.sha256 === expected && entry === `${refKey(parsed.ref, parsed.sha256)}.json`
						&& this.readStoredBytes(parsed)) candidates.push(parsed);
				} catch { /* Ignore unrelated or invalid candidates; activation still requires a verified manifest/blob. */ }
			}
			candidates.sort((a, b) => a.ref.localeCompare(b.ref));
			const candidate = candidates[0];
			if (!candidate) throw new Error(`No verified cached database plugin candidate for SHA-256 ${expected}`);
			const state = this.activeState();
			if (state.current?.sha256 !== candidate.sha256 || state.current?.ref !== candidate.ref) {
				const next: ActivePointer = { version: 1, current: candidate, previous: state.current };
				atomicReplace(this.activePointerPath, Buffer.from(JSON.stringify(next), "utf8"));
			}
			return this.sourceResult(candidate);
		});
	}

	/** Swaps the active source with its retained predecessor after re-verifying the predecessor bytes. */
	async rollback(): Promise<DatabasePluginSource | null> {
		return this.withCacheLock(() => {
			const state = this.activeState();
			if (!state.previous) return null;
			if (!this.readStoredBytes(state.previous)) throw new Error("Previous database plugin source is missing or invalid; active source was not changed");
			const next: ActivePointer = { version: 1, current: state.previous, previous: state.current };
			atomicReplace(this.activePointerPath, Buffer.from(JSON.stringify(next), "utf8"));
			return this.sourceResult(state.previous);
		});
	}
}
