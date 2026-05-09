import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';
import { db } from '../db/index.js';
import { llmConfig } from '../db/schema.js';
import { decryptGlobal } from './crypto.js';

export interface ActiveLlmConfig {
  id: number;
  name: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  /** Decrypted plaintext API key. Treat as sensitive. */
  apiKey: string;
}

const CACHE_TTL_MS = 60_000;

let cached: { config: ActiveLlmConfig; expiresAt: number } | null = null;

/**
 * Bust the in-process active-config cache. Call this from admin endpoints
 * after PUTting a new active config so changes propagate within the request.
 */
export function clearLlmConfigCache(): void {
  cached = null;
}

/**
 * Returns the row in llm_config where isActive = true.
 * Decrypts apiKey via decryptGlobal. Cached for 60s.
 *
 * Throws if no active row exists or the env key fails to decrypt the row.
 */
export async function getActiveLlmConfig(): Promise<ActiveLlmConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;

  const rows = await db
    .select()
    .from(llmConfig)
    .where(eq(llmConfig.isActive, true))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error('No active LLM config — set one in /admin first');
  }

  const apiKey = decryptGlobal(row.apiKeyEncrypted);
  if (!apiKey) {
    throw new Error(`LLM config "${row.name}" has empty/invalid api key`);
  }

  const config: ActiveLlmConfig = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    maxOutputTokens: row.maxOutputTokens,
    apiKey,
  };
  cached = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

/**
 * Build an OpenAI SDK client using the active config's baseUrl + apiKey.
 * Returns both the client and the config so callers can inspect the model name.
 */
export async function getLlmClient(): Promise<{
  client: OpenAI;
  config: ActiveLlmConfig;
}> {
  const config = await getActiveLlmConfig();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return { client, config };
}

export interface StreamChatArgs {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  responseFormat?: ChatCompletionCreateParamsStreaming['response_format'];
}

/**
 * Issue a streamed chat completion via the active config. Returns the raw
 * SDK stream — caller iterates and decides how to surface deltas / tool
 * calls / final text.
 *
 * `maxTokens` is clamped to config.maxOutputTokens. `tool_choice` is only
 * forwarded when `tools` is provided.
 */
export async function streamChat(
  args: StreamChatArgs,
): Promise<Stream<ChatCompletionChunk>> {
  const { client, config } = await getLlmClient();

  const requestedMax = args.maxTokens ?? config.maxOutputTokens;
  const maxTokens = Math.max(
    1,
    Math.min(config.maxOutputTokens, Math.floor(requestedMax)),
  );

  const body: ChatCompletionCreateParamsStreaming = {
    model: config.model,
    messages: args.messages,
    temperature: args.temperature ?? 0.7,
    max_tokens: maxTokens,
    stream: true,
  };
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    if (args.toolChoice !== undefined) {
      body.tool_choice = args.toolChoice;
    }
  }
  if (args.responseFormat) {
    body.response_format = args.responseFormat;
  }

  return client.chat.completions.create(body, {
    signal: args.signal,
  });
}
