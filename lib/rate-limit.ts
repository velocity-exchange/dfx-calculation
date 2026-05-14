export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

export function isRetryableRpcError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  const lower = msg.toLowerCase();

  // Includes the plan's matchers plus a few common transient network failures.
  return (
    msg.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("etimedout") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("502")
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.retries || !isRetryableRpcError(e)) throw e;
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt) + jitter;
      await sleep(delay);
      attempt++;
    }
  }
}

export async function limitConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });

  await Promise.all(workers);
  return results;
}
