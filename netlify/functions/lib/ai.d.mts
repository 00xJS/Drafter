export interface CompletionInput {
  system?: string
  prompt: string
  maxTokens?: number
  json?: boolean
  /** Anthropic alone, never NVIDIA: Ask Drafter with the journal in it. */
  claudeOnly?: boolean
}

/**
 * An answer, or why there is none. Each side names the other's fields as
 * absent, so the functions (plain JavaScript) can test `.error` and read `.text`.
 * `code` is CLAUDE_ONLY when a claudeOnly request could not be answered.
 */
export type Completion =
  | { text: string; provider: 'nvidia' | 'anthropic'; status?: undefined; error?: undefined; code?: undefined }
  | { status: number; error: string; code?: string; text?: undefined; provider?: undefined }

export declare const CLAUDE_ONLY: 'claude_only'

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

export function completeNvidia(input: CompletionInput): Promise<Completion>
export function completeAnthropic(input: CompletionInput): Promise<Completion>
export function complete(input: CompletionInput): Promise<Completion>
