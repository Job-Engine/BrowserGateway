// Canary runs (OPS): each live platform.client pair gets a scheduled
// known-record job (its recorded test input). A canary whose envelope is not
// success signals a broken login or layout drift; alerts go to Slack when a
// webhook is configured, otherwise to the log.
import type { JobStore } from "../jobs/store.js";
import type { Registry } from "../registry.js";
import type { Logger } from "../observability/logger.js";

export interface CanaryDeps {
  store: JobStore;
  registry: Registry;
  logger: Logger;
  /** Caller identity canary jobs run as (a seeded system caller). */
  callerId: string;
  intervalMs?: number;
  slackWebhookUrl?: string;
}

export function createCanaryScheduler(deps: CanaryDeps) {
  const log = deps.logger.child({ module: "canary" });
  // Canary jobs awaiting a verdict: jobId -> pair.
  const pending = new Map<string, { useCase: string; client: string }>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function alert(text: string): Promise<void> {
    if (deps.slackWebhookUrl) {
      try {
        await fetch(deps.slackWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        return;
      } catch (e) {
        log.error({ err: e }, "slack alert failed; falling back to log");
      }
    }
    log.warn({ alert: text }, "canary alert");
  }

  async function collectVerdicts(): Promise<void> {
    for (const [jobId, pair] of pending) {
      const job = await deps.store.get(jobId);
      if (!job || job.state !== "DONE") continue;
      pending.delete(jobId);
      const status = job.envelope?.status ?? "error";
      await deps.registry.recordCanaryResult(pair.useCase, pair.client, jobId, status);
      if (status !== "success") {
        await alert(
          `Canary failed for ${pair.useCase} (client ${pair.client}): ${status} ` +
            `${job.envelope?.error?.code ?? ""}. Job ${jobId}.`,
        );
      }
    }
  }

  async function runOnce(): Promise<string[]> {
    await collectVerdicts();
    const targets = await deps.registry.listCanaryTargets();
    const enqueued: string[] = [];
    for (const target of targets) {
      const { job } = await deps.store.enqueue({
        useCase: target.useCase,
        client: target.client,
        platform: target.useCase.split(".")[0],
        input: target.input,
        callerId: deps.callerId,
        idempotencyKey: `canary-${target.useCase}-${target.client}-${Math.floor(
          Date.now() / Math.max(deps.intervalMs ?? 3_600_000, 60_000),
        )}`,
      });
      pending.set(job.id, { useCase: target.useCase, client: target.client });
      enqueued.push(job.id);
    }
    if (enqueued.length > 0) log.info({ count: enqueued.length }, "canaries enqueued");
    return enqueued;
  }

  return {
    runOnce,
    collectVerdicts,
    start(): void {
      if (timer || !deps.intervalMs || deps.intervalMs <= 0) return;
      timer = setInterval(
        () => void runOnce().catch((e) => log.error({ err: e })),
        deps.intervalMs,
      );
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type CanaryScheduler = ReturnType<typeof createCanaryScheduler>;
