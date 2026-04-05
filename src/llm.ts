import { OpenAI } from 'openai'

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMOptions {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
}

export async function callLLM(messages: LLMMessage[], options?: LLMOptions): Promise<string> {
  const apiKey = (process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY)?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY (or DEEPSEEK_API_KEY) is missing')
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
  })
  const model = process.env.OPENAI_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat'

  // DEBUG: Log request
  console.log('\n[LLM REQUEST]', JSON.stringify({
    model,
    messages: options?.systemPrompt
      ? [{ role: 'system', content: options.systemPrompt }, ...messages]
      : messages,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0,
  }, null, 2))

  const response = await client.chat.completions.create({
    model,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0,
    messages: options?.systemPrompt
      ? [{ role: 'system', content: options.systemPrompt }, ...messages]
      : messages,
  })

  // DEBUG: Log response
  console.log('\n[LLM RESPONSE]', JSON.stringify({
    content: response.choices[0].message.content,
    usage: response.usage,
  }, null, 2))

  return response.choices[0].message.content ?? ''
}
