/**
 * Launcher error type and exit codes shared by the entrypoint
 * (script/agent.ts) and its extracted modules (script/agent/omp.ts).
 * ContractError remains the data-boundary error; AgentError carries the
 * process exit code the CLI maps to.
 */

export const EXIT_USAGE = 2;
export const EXIT_RUNTIME = 1;

export class AgentError extends Error {
  code: number;
  constructor(message: string, code: number = EXIT_USAGE) {
    super(message);
    this.code = code;
  }
}
