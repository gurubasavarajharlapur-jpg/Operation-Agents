// The only file that talks to the Anthropic API. The agent loop receives a CreateMessage function,
// so tests can pass a scripted fake instead and run without an API key or any spend.
import Anthropic from '@anthropic-ai/sdk';

export type CreateMessage = (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

// Models that support the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export function anthropicCreateMessage(): CreateMessage {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY; retries 429/5xx twice with backoff
  return (params) =>
    client.beta.messages.create(
      FALLBACK_MODELS.has(params.model)
        ? // If a safety classifier ever declines a request, the API reruns it on a fallback model
          // inside the same call instead of failing the case.
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : params,
    );
}
