// Fastify API surface: health, catalogue discovery, job submission and
// polling. Auth is per-caller bearer tokens, fail closed (S2); job reads are
// ownership-scoped (S1); body size is capped (S5). Admin routes arrive with
// the OPS epic.
import Fastify from "fastify";
import { z } from "zod";
import { CATALOGUE, getEntry, resolveAction } from "../catalogue.js";
import type { AuthStore, Caller } from "../auth/tokens.js";
import { hasScope } from "../auth/tokens.js";
import type { JobStore } from "../jobs/store.js";
import type { Logger } from "../observability/logger.js";
import type { Registry } from "../registry.js";
import type { CanaryScheduler } from "../canary/scheduler.js";
import { registerAdminRoutes } from "./admin.js";
import { buildOpenApiDocument } from "./openapi.js";

declare module "fastify" {
  interface FastifyRequest {
    caller: Caller;
  }
}

export interface AppDeps {
  store: JobStore;
  auth: AuthStore;
  logger: Logger;
  registry: Registry;
  canary?: CanaryScheduler;
}

const submitJobSchema = z.object({
  useCase: z.string().min(1),
  client: z.string().min(1).default("default"),
  input: z.unknown(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  app.get("/health", async () => ({ ok: true }));

  // Self-description for humans and agents; carries no secrets.
  app.get("/openapi.json", async () => buildOpenApiDocument());

  // Everything below requires a valid caller token.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.url === "/openapi.json") return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const caller = await deps.auth.verifyToken(token);
    if (!caller) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.caller = caller;
  });

  app.get("/catalogue", async (req) => {
    const actions = Object.values(CATALOGUE).map((entry) => ({
      useCase: entry.useCase,
      platform: entry.portalKey,
      clients: ["default", ...Object.keys(entry.clients ?? {})],
      inputSchema: z.toJSONSchema(entry.inputSchema),
      extractSchema: z.toJSONSchema(entry.extractSchema),
      requiresLogin: entry.requiresLogin,
    }));
    req.log.info({ callerId: req.caller.id }, "catalogue read");
    // useCases preserved from v1; actions is the additive machine-readable form.
    return { useCases: Object.keys(CATALOGUE), actions };
  });

  app.post("/jobs", async (req, reply) => {
    const parsed = submitJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid request",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const { useCase, client, input, idempotencyKey } = parsed.data;

    try {
      getEntry(useCase);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }

    if (!hasScope(req.caller.scopes, useCase, client)) {
      return reply.code(403).send({ error: "token is not scoped for this useCase and client" });
    }

    // WL: the client must be on the action's roster ("default" always is).
    let action;
    try {
      action = resolveAction(useCase, client);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }

    // Lifecycle gate (first-live-run rule): only live pairs serve caller
    // traffic. Admin callers may submit test runs against any pair.
    if (!req.caller.isAdmin && !(await deps.registry.isLive(useCase, client))) {
      return reply.code(403).send({
        error: `action-client pair ${useCase}:${client} is not live; a passing test run must be recorded and the pair enabled first`,
      });
    }

    const inputParsed = action.inputSchema.safeParse(input);
    if (!inputParsed.success) {
      return reply.code(400).send({
        error: "invalid input",
        details: inputParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }

    const { job, deduplicated } = await deps.store.enqueue({
      useCase,
      client,
      platform: action.portalKey,
      input: inputParsed.data,
      callerId: req.caller.id,
      idempotencyKey,
    });
    req.log.info(
      { jobId: job.id, useCase, client, callerId: req.caller.id, deduplicated },
      "job accepted",
    );
    return reply.code(202).send({ jobId: job.id, state: job.state });
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).send({ error: "job not found" });
    }
    const job = req.caller.isAdmin
      ? await deps.store.get(id)
      : await deps.store.getForCaller(id, req.caller.id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    return { jobId: job.id, state: job.state, envelope: job.envelope ?? undefined };
  });

  // Cast: the admin routes are logger-type agnostic; Fastify's generics are
  // over-specific about the pino instance.
  registerAdminRoutes(app as unknown as Parameters<typeof registerAdminRoutes>[0], deps);

  return app;
}

export type App = ReturnType<typeof buildApp>;
