export interface CompletionInput {
  system?: string
  prompt: string
  maxTokens?: number
  json?: boolean
  /**
   * 'off' asks a model that has a switch for it (Nemotron 3) to answer without thinking first; 'on' asks it to
   * think. Unset, and for a model with no switch, nothing is sent and the model does what it always does.
   */
  reasoning?: 'off' | 'on'
  /** Work the server starts by itself (Sunday's draft, email-in triage): with a second NVIDIA key, that key goes first. */
  background?: boolean
  /** When the request began (epoch ms): the budget, AI_BUDGET_MS, counts from here. Now, when not given. */
  startedAt?: number
  /**
   * When every attempt must be done by (epoch ms), in place of the budget. Without it, background work
   * is held to no deadline here: it stops waiting at one of its own.
   */
  deadline?: number
}

/** How long one completion may take in all, from when its request began (ms). */
export declare const AI_BUDGET_MS: number
/** No further attempt (the next NVIDIA key) starts with less than this left (ms). */
export declare const MIN_ATTEMPT_MS: number

/**
 * An answer, or why there is none. Each side names the other's fields as
 * absent, so the functions (plain JavaScript) can test `.error` and read `.text`.
 * `upstream` is the HTTP status NVIDIA answered a failed call with, when it answered.
 */
export type Completion =
  | { text: string; provider: 'nvidia' | 'anthropic'; status?: undefined; error?: undefined; upstream?: undefined }
  | { status: number; error: string; upstream?: number; text?: undefined; provider?: undefined }

/** The pattern an NVIDIA key's name matches: NVIDIA_API_KEY, or NVIDIA_API_KEY_ and a number. */
export declare const NVIDIA_KEY_NAME: RegExp

/** An NVIDIA key, by its name on the host: NVIDIA_API_KEY, NVIDIA_API_KEY_2, NVIDIA_API_KEY_3 and on. */
export type NvidiaKeyName = `NVIDIA_API_KEY` | `NVIDIA_API_KEY_${number}`

/** The NVIDIA keys that are set, in the order a request tries them: the main key first, or for background work the second and the main key last. */
export function nvidiaKeyOrder(opts?: { background?: boolean }): NvidiaKeyName[]

export function resolveProvider(): 'nvidia' | 'anthropic' | null

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: { role: 'user'; content: string }[]
  system?: string
  output_config?: { effort: 'low' }
  betas?: string[]
  fallbacks?: 'default'
}

export function anthropicRequest(input: CompletionInput & { model: string }): AnthropicRequest

export function completeNvidia(input: CompletionInput & { keyName?: NvidiaKeyName }): Promise<Completion>
export function completeAnthropic(input: CompletionInput): Promise<Completion>
export function complete(input: CompletionInput): Promise<Completion>

/** An answer NVIDIA has begun to stream (lib/ai.mjs): its first words, the rest as they come, and its own clock. */
export interface AnswerOnItsWay {
  first: string
  words: { next(): Promise<{ text: string; reset: boolean } | null>; raw(): string; close(): void }
  /** Whether the answer's own clock ran out. */
  late(): boolean
  close(): void
}

/** What one attempt that may stream answers, inside lib/ai.mjs: a Completion, or an answer on its way. */
export type Attempted =
  | (Completion & { stream?: undefined; model?: undefined })
  | { stream: AnswerOnItsWay; provider: 'nvidia'; model: string; text?: undefined; status?: undefined; error?: undefined; upstream?: undefined }

/**
 * What completeStream answers: a failure, or a whole answer where NVIDIA would not stream one (or the host names
 * Anthropic), as complete() answers them; or `body`, the answer's event stream for the app, with the model writing it.
 */
export type StreamedCompletion =
  | (Completion & { body?: undefined; model?: undefined })
  | { body: ReadableStream<Uint8Array>; provider: 'nvidia'; model: string; text?: undefined; status?: undefined; error?: undefined; upstream?: undefined }

export function completeStream(input: Omit<CompletionInput, 'json' | 'background'>): Promise<StreamedCompletion>
