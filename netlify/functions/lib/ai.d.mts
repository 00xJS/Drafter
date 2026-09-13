export interface CompletionInput {
  system?: string
  prompt: string
  maxTokens?: number
  json?: boolean
}

/**
 * An answer, or why there is none. Each side names the other's fields as
 * absent, so the functions (plain JavaScript) can test `.error` and read `.text`.
 */
export type Completion =
  | { text: string; provider: 'nvidia' | 'anthropic'; status?: undefined; error?: undefined }
  | { status: number; error: string; text?: undefined; provider?: undefined }

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
