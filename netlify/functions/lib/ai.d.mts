export interface CompletionInput {
  system?: string
  prompt: string
  maxTokens?: number
  json?: boolean
  /** Work the server starts by itself (Sunday's draft, email-in triage): with a second NVIDIA key, that key goes first. */
  background?: boolean
}

/**
 * An answer, or why there is none. Each side names the other's fields as
 * absent, so the functions (plain JavaScript) can test `.error` and read `.text`.
 * `upstream` is the HTTP status NVIDIA answered a failed call with, when it answered.
 */
export type Completion =
  | { text: string; provider: 'nvidia' | 'anthropic'; status?: undefined; error?: undefined; upstream?: undefined }
  | { status: number; error: string; upstream?: number; text?: undefined; provider?: undefined }

/** The host's NVIDIA keys, by name. */
export type NvidiaKeyName = 'NVIDIA_API_KEY' | 'NVIDIA_API_KEY_2'

/** The NVIDIA keys that are set, in the order a request tries them: the main key first, or for background work the second. */
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
