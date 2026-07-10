import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { pathToFileURL } from "node:url";
import { runAgent, autoApprove } from "./index.js";
import type { AgentEvent, ConfirmFn, ProposedAction } from "./types.js";

export interface CliArgs {
  url: string;
  goal: string;
  data: Record<string, string>;
  credentials: Record<string, string>;
  model?: string;
  auto: boolean;
  local: boolean;
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function parseArgs(args: string[]): CliArgs {
  const url = getFlag(args, "--url");
  const goal = getFlag(args, "--goal");
  if (!url) throw new Error("Missing required flag: --url");
  if (!goal) throw new Error("Missing required flag: --goal");
  const dataRaw = getFlag(args, "--data");
  const credsRaw = getFlag(args, "--creds");
  return {
    url,
    goal,
    data: dataRaw ? (JSON.parse(dataRaw) as Record<string, string>) : {},
    credentials: credsRaw ? (JSON.parse(credsRaw) as Record<string, string>) : {},
    model: getFlag(args, "--model"),
    auto: args.includes("--auto"),
    local: args.includes("--local"),
  };
}

function interactiveConfirm(): ConfirmFn {
  const rl = createInterface({ input: stdin, output: stdout });
  return async (action: ProposedAction) => {
    const answer = await rl.question(
      `\n[confirm] Risky action: ${action.description}\n          (instruction: ${action.instruction})\n          Approve? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y";
  };
}

function printEvent(e: AgentEvent): void {
  switch (e.type) {
    case "planned":
      stdout.write(`\n[step ${e.step}] plan: ${e.isDone ? "(goal complete)" : e.instruction}\n`);
      break;
    case "risk":
      stdout.write(`[step ${e.step}] risk: ${e.assessment.level} — ${e.assessment.reason}\n`);
      break;
    case "acted":
      stdout.write(`[step ${e.step}] acted: ${e.outcome}${e.message ? ` — ${e.message}` : ""}\n`);
      break;
    case "done":
      stdout.write(`\n[done] status: ${e.status}\n`);
      break;
    default:
      break;
  }
}

export async function main(rawArgs: string[]): Promise<void> {
  const args = parseArgs(rawArgs);
  if (args.local) process.env.WAA_ENV = "LOCAL";

  // Only create a readline interface (which keeps the event loop alive) when
  // we actually need interactive confirmation.
  const onBeforeAction: ConfirmFn = args.auto ? autoApprove : interactiveConfirm();

  const result = await runAgent({
    url: args.url,
    goal: args.goal,
    data: args.data,
    credentials: args.credentials,
    model: args.model,
    onBeforeAction,
    onEvent: printEvent,
  });
  stdout.write(`\n=== RESULT ===\n${JSON.stringify(result, null, 2)}\n`);
  // The interactive readline interface keeps the process alive, so exit
  // explicitly — with a non-zero code when the run did not complete, so
  // callers/automation can detect failure from the exit status.
  process.exit(result.success ? 0 : 1);
}

// Run only when executed directly (not when imported by tests).
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main(argv.slice(2)).catch((err) => {
    process.stderr.write(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
