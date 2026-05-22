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

/** Process-wide retry counter — used by callers that want to surface a
 * "we're being rate-limited" indicator without instrumenting every call site. */
export const retryStats = { totalRetries: 0 };

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
      retryStats.totalRetries += 1;
      const jitter = Math.floor(Math.random() * 250);
      const delay =
        Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt) + jitter;
      await sleep(delay);
      attempt++;
    }
  }
}

/**
 * Token-paced rate limiter. Each `wait()` reserves the next available slot
 * `intervalMs` after the last one; concurrent callers serialize by
 * monotonically advancing the cursor before sleeping. Use to cap an RPC
 * endpoint's request rate independent of concurrency.
 *
 * Example: `new RateLimiter(1000 / 15)` → 15 requests/second.
 */
export class RateLimiter {
  private next = Date.now();
  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const myTurn = Math.max(this.next, now);
    this.next = myTurn + this.intervalMs;
    const delay = myTurn - now;
    if (delay > 0) await sleep(delay);
  }

  /** Helper: rate-limit + retry an RPC call in one. */
  async run<T>(
    fn: () => Promise<T>,
    retryOpts: { retries: number; baseDelayMs: number; maxDelayMs: number },
  ): Promise<T> {
    await this.wait();
    return await withRetry(fn, retryOpts);
  }
}

export async function limitConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (i < tasks.length) {
        const idx = i++;
        results[idx] = await tasks[idx]();
      }
    },
  );

  await Promise.all(workers);
  return results;
}
