// Admin API surface, mounted under /admin behind isAdmin callers only:
// jobs ops, catalogue lifecycle, token management, canary control, audit.
// The React console (admin-web/) is built against exactly these routes.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthStore } from "../auth/tokens.js";
import type { JobStore } from "../jobs/store.js";
import type { Registry } from "../registry.js";
import type { CanaryScheduler } from "../canary/scheduler.js";

export interface AdminDeps {
  store: JobStore;
  auth: AuthStore;
  registry: Registry;
  canary?: CanaryScheduler;
}

const issueTokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().regex(/^[^:]+:[^:]+$/)).min(1),
  isAdmin: z.boolean().default(false),
});

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req, reply) => {
        if (!req.caller?.isAdmin) {
          return reply.code(403).send({ error: "admin access required" });
        }
      });

      admin.get("/stats", async () => {
        const jobs = await deps.store.countByState();
        return { jobs };
      });

      admin.get("/jobs", async (req) => {
        const { state, limit } = req.query as { state?: string; limit?: string };
        const jobs = await deps.store.list({
          state: state as "QUEUED" | "RUNNING" | "DONE" | undefined,
          limit: Math.min(Number(limit) || 50, 200),
        });
        return { jobs };
      });

      admin.get("/jobs/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const job = await deps.store.get(id);
        if (!job) return reply.code(404).send({ error: "job not found" });
        return job;
      });

      admin.post("/tokens", async (req, reply) => {
        const parsed = issueTokenSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
        }
        const { caller, token } = await deps.auth.issueToken(parsed.data.name, parsed.data.scopes, {
          isAdmin: parsed.data.isAdmin,
        });
        await deps.registry.audit(req.caller.name, "token.issued", caller.name, {
          scopes: parsed.data.scopes,
          isAdmin: parsed.data.isAdmin,
        });
        // The plaintext token appears exactly once, in this response.
        return reply.code(201).send({ caller, token });
      });

      admin.get("/tokens", async () => {
        const callers = await deps.auth.listCallers();
        return { callers };
      });

      admin.post("/tokens/:id/disable", async (req) => {
        const { id } = req.params as { id: string };
        await deps.auth.disable(id);
        await deps.registry.audit(req.caller.name, "token.disabled", id);
        return { ok: true };
      });

      admin.get("/catalogue", async () => {
        const pairs = await deps.registry.listCatalogue();
        return { pairs };
      });

      admin.post("/catalogue/:useCase/validate", async (req, reply) => {
        const { useCase } = req.params as { useCase: string };
        try {
          const result = await deps.registry.validateAction(useCase, req.caller.name);
          return result.ok ? { ok: true } : reply.code(422).send(result);
        } catch (e) {
          return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
        }
      });

      admin.post("/catalogue/:useCase/clients/:client/record-test", async (req, reply) => {
        const { useCase, client } = req.params as { useCase: string; client: string };
        const body = z.object({ jobId: z.uuid() }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "jobId (uuid) required" });
        const result = await deps.registry.recordTestRun(
          useCase,
          client,
          body.data.jobId,
          req.caller.name,
        );
        return result.ok ? { ok: true } : reply.code(422).send(result);
      });

      admin.post("/catalogue/:useCase/clients/:client/enable", async (req, reply) => {
        const { useCase, client } = req.params as { useCase: string; client: string };
        const result = await deps.registry.setLive(useCase, client, req.caller.name);
        return result.ok ? { ok: true } : reply.code(422).send(result);
      });

      admin.post("/catalogue/:useCase/clients/:client/disable", async (req) => {
        const { useCase, client } = req.params as { useCase: string; client: string };
        await deps.registry.disablePair(useCase, client, req.caller.name);
        return { ok: true };
      });

      admin.post("/canaries/run", async (req, reply) => {
        if (!deps.canary) return reply.code(503).send({ error: "canary scheduler not running" });
        const enqueued = await deps.canary.runOnce();
        await deps.registry.audit(req.caller.name, "canary.triggered", "all", { enqueued });
        return { enqueued };
      });

      admin.get("/audit", async (req) => {
        const { limit } = req.query as { limit?: string };
        const entries = await deps.registry.listAudit(Math.min(Number(limit) || 100, 500));
        return { entries };
      });
    },
    { prefix: "/admin" },
  );
}
