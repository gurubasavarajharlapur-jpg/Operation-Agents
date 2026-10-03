// USD per million tokens (Anthropic first-party API prices, September 2026).
// Cache writes (5-minute TTL) cost 1.25x input; cache reads are listed per model.
import type Anthropic from '@anthropic-ai/sdk';

interface Price { input: number; output: number; cacheRead: number }

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Returns null for a model not in the table, so an unknown price is never reported as $0. */
export function costUsd(model: string, usage: Anthropic.Beta.BetaUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.cacheRead + usage.output_tokens * p.output) / 1_000_000
  );
}

export function totalTokens(usage: Anthropic.Beta.BetaUsage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens;
}
