import { Stagehand } from "@browserbasehq/stagehand";
import type { z } from "zod";
import type { ActOutcome, BrowserAgent, ObservedAction } from "./types.js";

export interface CreateSessionConfig {
  env?: "BROWSERBASE" | "LOCAL";
  model: string;
  apiKey?: string;
  projectId?: string;
  context?: { id: string; persist?: boolean };
  headless?: boolean;
  verbose?: 0 | 1 | 2;
}

export async function createSession(config: CreateSessionConfig): Promise<BrowserAgent> {
  const env = config.env ?? "BROWSERBASE";
  const projectId = config.projectId ?? process.env.BROWSERBASE_PROJECT_ID;

  const stagehand =
    env === "BROWSERBASE"
      ? new Stagehand({
          env: "BROWSERBASE",
          model: config.model,
          verbose: config.verbose ?? 0,
          selfHeal: true,
          apiKey: config.apiKey ?? process.env.BROWSERBASE_API_KEY,
          projectId,
          browserbaseSessionCreateParams: {
            projectId: projectId ?? "",
            ...(config.context
              ? {
                  browserSettings: {
                    context: { id: config.context.id, persist: config.context.persist ?? false },
                  },
                }
              : {}),
          },
        })
      : new Stagehand({
          env: "LOCAL",
          model: config.model,
          verbose: config.verbose ?? 0,
          selfHeal: true,
          localBrowserLaunchOptions: { headless: config.headless ?? true },
        });

  await stagehand.init();
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  return {
    get sessionReplayUrl() {
      return stagehand.browserbaseSessionURL;
    },
    async goto(url: string) {
      await page.goto(url);
    },
    async observe(instruction: string, variables?: Record<string, string>): Promise<ObservedAction[]> {
      const result = await stagehand.observe(instruction, variables ? { variables } : undefined);
      return result.map((a) => ({
        selector: a.selector,
        description: a.description,
        method: a.method,
        arguments: a.arguments,
      }));
    },
    async act(action: ObservedAction, variables?: Record<string, string>): Promise<ActOutcome> {
      const res = await stagehand.act(action, variables ? { variables } : undefined);
      return { success: res.success, message: res.message };
    },
    async extract<T>(instruction: string, schema: z.ZodType<T>): Promise<T> {
      // Cast at the adapter boundary: Stagehand accepts Zod 3/4 schemas via its own type.
      return stagehand.extract(instruction, schema as never) as Promise<T>;
    },
    async close() {
      await stagehand.close();
    },
  };
}
