#!/usr/bin/env node
import { runAgent } from "./agent.js";
import type { SchedulerAgent } from "../shared/contracts.js";

try {
  const agent = JSON.parse(
    process.env.CLOUDCLI_SCHEDULER_AGENT || "{}",
  ) as SchedulerAgent;
  if (!["codex", "dsh"].includes(agent.provider))
    throw new Error("AGENT_EXEC 仅能在调度任务中使用");
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt.trim()) throw new Error("请向 AGENT_EXEC 传入提示词");
  const result = await runAgent(
    agent,
    prompt,
    process.cwd(),
    {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
      event: () => {},
      child: () => {},
    },
    false,
  );
  if (!result.success && result.reason)
    process.stderr.write(result.reason + "\n");
  process.exitCode = result.success ? 0 : result.code || 1;
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
}
