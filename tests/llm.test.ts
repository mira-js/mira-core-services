import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Prevent real OpenAI client construction
vi.mock('openai', () => {
  const create = vi.fn()
  const ctor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create } },
  }))
  ;(ctor as unknown as { _create: typeof create })._create = create
  return { default: ctor, OpenAI: ctor }
})

import { OpenAI } from 'openai'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = 'test-key'
})

describe('callLLM — no console.log of prompts or responses', () => {
  it('does not contain any console.log calls in llm.ts source', () => {
    // Read the source file directly and assert no console.log is present.
    // This is the canonical test for the logging-removal fix.
    const src = readFileSync(resolve('src/llm.ts'), 'utf8')
    expect(src).not.toContain('console.log')
  })

  it('does not call console.log when callLLM is invoked', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'hello' } }],
      usage: { total_tokens: 5 },
    })
    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }) as unknown as OpenAI)

    const consoleSpy = vi.spyOn(console, 'log')

    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'test prompt' }])

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
