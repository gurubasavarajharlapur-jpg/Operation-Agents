import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnv);
} catch {
  // no .env file: rely on the real environment
}

export type AgentMode = 'llm' | 'rules';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// AGENT_MODE=auto (default) uses Claude when ANTHROPIC_API_KEY is set, otherwise the rules-only
// engine. Every case records which mode decided it, so a rules decision is never passed off as the agent.
function resolveMode(): AgentMode {
  const mode = process.env.AGENT_MODE ?? 'auto';
  if (mode === 'llm' || mode === 'rules') return mode;
  return process.env.ANTHROPIC_API_KEY ? 'llm' : 'rules';
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/operation_agents',
  agentMode: resolveMode(),
  model: process.env.AGENT_MODEL ?? 'claude-opus-5-5',
  effort: (process.env.AGENT_EFFORT ?? 'medium') as Effort,
  maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 8),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  voyageApiKey: process.env.VOYAGE_API_KEY || undefined,
};
