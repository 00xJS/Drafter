export interface CompletionInput {
  system?: string
  prompt: string
  maxTokens?: number
  json?: boolean
}

export type Completion = { text: string; provider: 'nvidia' | 'anthropic' } | { status: number; error: string }

export function resolveProvider(): 'nvidia' | 'anthropic' | null

export function anthropicRequest(input: CompletionInput & { model: string }): {
  model: string
  max_tokens: number
  messages: { role: 'user'; content: string }[]
  system?: string
  output_config?: { effort: 'low' }
  betas?: string[]
  fallbacks?: 'default'
}

export function completeNvidia(input: CompletionInput): Promise<Completion>
export function completeAnthropic(input: CompletionInput): Promise<Completion>
export function complete(input: CompletionInput): Promise<Completion>
