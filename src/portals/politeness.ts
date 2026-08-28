/**
 * Politeness budget — a per-client sliding-window rate limiter + backoff, so the
 * gateway stays an extremely light guest on a portal (issue #467; the top design
 * constraint for LightReach/Palmetto). A safety net against runaway loops, well
 * under anything that could look abusive.
 *
 * Pure and clock-injected: every method takes `now` (epoch ms) so behavior is
 * deterministic and unit-testable — no ambient time.
 */

export interface PolitenessConfig {
  /** Max logins per client per rolling hour (steady state is ~1/day). */
  loginsPerHour: number;
  /** Max reads per client per rolling hour. */
  readsPerHour: number;
  /** Backoff base (ms) for the first 429/anti-bot retry. Default 1000. */
  baseBackoffMs?: number;
  /** Backoff ceiling (ms). Default 60000. */
  maxBackoffMs?: number;
}

const HOUR_MS = 3_600_000;

export class PolitenessBudget {
  private readonly loginsPerHour: number;
  private readonly readsPerHour: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly logins = new Map<string, number[]>();
  private readonly reads = new Map<string, number[]>();

  constructor(config: PolitenessConfig) {
    this.loginsPerHour = config.loginsPerHour;
    this.readsPerHour = config.readsPerHour;
    this.baseBackoffMs = config.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
  }

  /** Try to spend one login for `client`. Returns false (spends nothing) if over budget. */
  tryLogin(client: string, now: number): boolean {
    return this.spend(this.logins, client, 1, this.loginsPerHour, now);
  }

  /** Try to spend `count` reads for `client`. All-or-nothing. */
  tryReads(client: string, count: number, now: number): boolean {
    return this.spend(this.reads, client, count, this.readsPerHour, now);
  }

  /** Backoff delay (ms) for retry `attempt` (0-based) after a throttle signal.
   *  Exponential, capped, with jitter in [half, full]. `rand` in [0,1). */
  backoffMs(attempt: number, rand: number): number {
    const full = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    return full / 2 + rand * (full / 2);
  }

  private spend(
    store: Map<string, number[]>,
    client: string,
    count: number,
    limit: number,
    now: number,
  ): boolean {
    const cutoff = now - HOUR_MS;
    const recent = (store.get(client) ?? []).filter((t) => t > cutoff);
    if (recent.length + count > limit) {
      store.set(client, recent); // persist the prune even on rejection
      return false;
    }
    for (let i = 0; i < count; i++) recent.push(now);
    store.set(client, recent);
    return true;
  }
}
