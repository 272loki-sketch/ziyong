export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) {
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}

/** Standard abort error used by provider streams. */
export function createAbortError(message = "Request was aborted"): Error {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

/**
 * Race an async iterable against AbortSignal.
 *
 * Why: many OpenAI-compatible proxies ignore request cancellation mid-SSE.
 * Checking `signal.aborted` only between chunks still hangs if no chunk arrives.
 * Racing each `iterator.next()` with abort forces the consumer to tear down
 * immediately when the user hits Stop.
 */
export async function* abortableAsyncIterable<T>(
	source: AsyncIterable<T>,
	signal?: AbortSignal,
): AsyncGenerator<T, void, undefined> {
	if (!signal) {
		yield* source;
		return;
	}
	if (signal.aborted) {
		throw createAbortError();
	}

	const iterator = source[Symbol.asyncIterator]();
	const pending: { reject?: (err: Error) => void } = {};
	const onAbort = () => {
		try {
			void iterator.return?.();
		} catch {
			// best-effort cancel
		}
		pending.reject?.(createAbortError());
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal.aborted) throw createAbortError();
			const next = await Promise.race([
				iterator.next(),
				new Promise<never>((_, reject) => {
					pending.reject = reject;
					if (signal.aborted) reject(createAbortError());
				}),
			]);
			pending.reject = undefined;
			if (next.done) return;
			yield next.value;
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
