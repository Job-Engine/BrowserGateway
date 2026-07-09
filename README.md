# web-action-agent

Autonomous web action agent. Given a URL and a natural-language goal, it drives a
Browserbase cloud browser (via Stagehand v3) to fill forms and take actions on
arbitrary sites, pausing for human confirmation before risky/irreversible actions.

## Usage

```ts
import { runAgent, autoApprove } from "web-action-agent";

const result = await runAgent({
  url: "https://example.com/apply",
  goal: "Complete and submit the job application",
  data: { firstName: "Ada", email: "ada@example.com" },
  onBeforeAction: async (action) => {
    console.log("About to:", action.description);
    return true; // approve
  },
});
console.log(result.status, result.summary);
```

See `docs/superpowers/specs/` for the design and `.env.example` for configuration.
