// GET /openapi.json: the API's self-description, generated from the same zod
// schemas the routes validate with. Error codes are a closed enum; keep this
// and AGENTS.md in sync with the shipped surface in the same PR.
import { z } from "zod";
import { CATALOGUE } from "../catalogue.js";

/** The closed set of envelope error codes callers may branch on. */
export const ERROR_CODES = [
  "INVALID_INPUT",
  "AUTH_UNAVAILABLE",
  "RUN_ERROR",
  "ACTION_BLOCKED",
  "TIMEOUT",
  "MATCH_FAILED",
  "NTP_FIELD_NOT_FOUND",
  "GOAL_NOT_COMPLETED",
  "GATEWAY_ERROR",
] as const;

const envelopeSchema = {
  type: "object",
  required: ["jobId", "useCase", "status", "meta"],
  properties: {
    jobId: { type: "string", format: "uuid" },
    useCase: { type: "string" },
    client: { type: "string" },
    status: {
      type: "string",
      enum: ["success", "failure", "error"],
      description:
        "success: goal met and data extracted. failure: clean negative business outcome; callers may automate on it. error: system/auth/navigation problem; callers alert on it.",
    },
    data: { description: "Shaped by the action's locked extract schema." },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: [...ERROR_CODES] },
        message: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
      },
    },
    meta: {
      type: "object",
      required: ["ranAt", "durationMs", "attempts"],
      properties: {
        sessionId: { type: "string" },
        sessionReplayUrl: { type: "string" },
        ranAt: { type: "string", format: "date-time" },
        durationMs: { type: "integer" },
        attempts: { type: "integer" },
        stepsUsed: { type: "integer" },
      },
    },
  },
} as const;

export function buildOpenApiDocument() {
  const bearer = [{ bearerAuth: [] }];
  return {
    openapi: "3.1.0",
    info: {
      title: "Browser Automation Gateway",
      version: "2.0.0",
      description:
        "API access to web portals that have no API. Submit {useCase, client, input}; poll the job until DONE; read the envelope.",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Per-caller scoped token (bgw_...)",
        },
      },
      schemas: { JobEnvelope: envelopeSchema },
    },
    paths: {
      "/health": {
        get: { summary: "Liveness", responses: { "200": { description: "ok" } } },
      },
      "/catalogue": {
        get: {
          summary: "Machine-readable action catalogue",
          security: bearer,
          responses: {
            "200": {
              description:
                "useCases (v1 compatible) plus actions with JSON schemas and client rosters",
            },
          },
        },
      },
      "/jobs": {
        post: {
          summary: "Submit a job (async; poll GET /jobs/{id} until state DONE)",
          security: bearer,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["useCase", "input"],
                  properties: {
                    useCase: {
                      type: "string",
                      enum: Object.keys(CATALOGUE),
                    },
                    client: { type: "string", default: "default" },
                    input: { description: "Validated against the action's input schema" },
                    idempotencyKey: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "202": { description: "{ jobId, state: QUEUED }" },
            "400": { description: "Unknown useCase, unknown client, or invalid input" },
            "403": { description: "Token not scoped for the pair, or pair not live" },
          },
        },
      },
      "/jobs/{id}": {
        get: {
          summary: "Poll a job you submitted (ownership enforced)",
          security: bearer,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "{ jobId, state, envelope? }",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jobId: { type: "string" },
                      state: { type: "string", enum: ["QUEUED", "RUNNING", "DONE"] },
                      envelope: { $ref: "#/components/schemas/JobEnvelope" },
                    },
                  },
                },
              },
            },
            "404": { description: "Not found or not yours" },
          },
        },
      },
      "/admin": {
        description:
          "Admin surface (isAdmin tokens): /admin/stats, /admin/jobs, /admin/tokens, /admin/catalogue lifecycle transitions, /admin/canaries/run, /admin/audit.",
      },
    },
    "x-actions": Object.values(CATALOGUE).map((entry) => ({
      useCase: entry.useCase,
      platform: entry.portalKey,
      clients: ["default", ...Object.keys(entry.clients ?? {})],
      inputSchema: z.toJSONSchema(entry.inputSchema),
      extractSchema: z.toJSONSchema(entry.extractSchema),
    })),
  };
}
