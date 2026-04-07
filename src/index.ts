import { loadConfig } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { ClaudeCodeExecutor } from './executors/claude-code.js';
import { CodexExecutor } from './executors/codex.js';
import { formatCycleResult } from './output.js';
import { GitWorkspacePreparer } from './repo-workspace.js';
import { JsonSessionStore } from './session-store.js';
import { RemoteWorkerAgent } from './worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ControlPlaneClient(config.controlPlaneBaseUrl, config.controlPlaneToken);
  const sessionStore = new JsonSessionStore(config.sessionStorePath);
  const workspacePreparer = new GitWorkspacePreparer(config.workspaceRoot, config.gitEnv);
  const executors = new Map([
    [
      'codex',
      new CodexExecutor({
        executionMode: config.executionMode,
        bin: config.codexBin,
        model: config.codexModel,
        sandbox: config.codexSandbox,
        env: config.runtimeEnv
      })
    ],
    ['claude-code', new ClaudeCodeExecutor(config.executionMode)]
  ] as const);

  const agent = new RemoteWorkerAgent(config, {
    client,
    sessionStore,
    workspacePreparer,
    executors
  });

  await agent.register();

  if (process.argv.includes('--once')) {
    const result = await agent.runCycle();
    console.log(formatCycleResult(result));
    return;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await agent.runLoop(controller.signal, (result) => {
    console.log(formatCycleResult(result));
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
