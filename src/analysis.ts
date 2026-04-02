import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CollectedItem, ExtractionResult, PainPointTheme, Result, Sentiment } from '@mia/shared-core'
import { callLLM } from './llm.js'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ExtractionResultSchema = z.object({
  pain_points: z.array(z.string()),
  sentiment: z.enum(['negative', 'neutral', 'positive']),
  category: z.enum(['complaint', 'feature-request', 'workflow-friction', 'pricing', 'switching-signal']),
  mentioned_tools: z.array(z.string()),
  key_quote: z.string(),
})

const JinaResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
})

// ─── Prompt helpers ───────────────────────────────────────────────────────────

const PROMPTS_DIR = process.env.MIA_PROMPTS_DIR ?? join(__dirname, '../../../../prompts')

function loadPrompt(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), 'utf8')
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), template)
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()
}

// ─── Jina embeddings ──────────────────────────────────────────────────────────

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (!process.env.JINA_API_KEY) {
    throw new Error('JINA_API_KEY is required for embeddings')
  }
  const res = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'jina-embeddings-v4',
      task: 'text-matching',
      input: texts,
    }),
  })
  if (!res.ok) {
    throw new Error(`Jina embeddings failed: ${res.status} ${res.statusText}`)
  }
  const parsed = JinaResponseSchema.parse(await res.json())
  return parsed.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

// ─── Clustering helpers ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  if (magA === 0 || magB === 0) return 0
  return dot / (magA * magB)
}

type ClusterState<T> = { clusters: T[][]; assignedIndices: ReadonlySet<number> }

function greedyCluster<T>(items: T[], embeddings: number[][], threshold: number): T[][] {
  const { clusters } = items.reduce<ClusterState<T>>(
    ({ clusters, assignedIndices }, item, i) => {
      if (assignedIndices.has(i)) return { clusters, assignedIndices }

      const { members, newAssigned } = items.reduce<{ members: T[]; newAssigned: Set<number> }>(
        (acc, candidate, j) => {
          if (j === i || acc.newAssigned.has(j) || assignedIndices.has(j)) return acc
          if (cosineSimilarity(embeddings[i], embeddings[j]) >= threshold) {
            return { members: [...acc.members, candidate], newAssigned: new Set([...acc.newAssigned, j]) }
          }
          return acc
        },
        { members: [item], newAssigned: new Set([i]) },
      )

      return {
        clusters: [...clusters, members],
        assignedIndices: new Set([...assignedIndices, ...newAssigned]),
      }
    },
    { clusters: [], assignedIndices: new Set() },
  )

  return clusters
}

// ─── Sentiment scoring ──────────────────────────────────────────���─────────────

const sentimentScore: Record<Sentiment, number> = { negative: -1, neutral: 0, positive: 1 }

// ─── Exported functions ───────────────────────────────────────────────────────

export async function extractItem(item: CollectedItem): Promise<Result<ExtractionResult>> {
  try {
    const content = [item.title, item.body, ...item.raw_replies.slice(0, 5)].join('\n\n')
    const template = loadPrompt('extract_pain_points.txt')
    const prompt = fillTemplate(template, { content, source: item.source })
    const raw = await callLLM([{ role: 'user', content: prompt }])
    const parsed: unknown = JSON.parse(stripFences(raw))
    return { ok: true, value: ExtractionResultSchema.parse(parsed) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

type ExtractionPair = { item: CollectedItem; extraction: ExtractionResult }

function clusterByStringDedup(pairs: ExtractionPair[]): ExtractionPair[][] {
  const seen = pairs.reduce<Map<string, ExtractionPair[]>>((acc, pair) => {
    const key = pair.extraction.key_quote
    return acc.set(key, [...(acc.get(key) ?? []), pair])
  }, new Map())
  return Array.from(seen.values())
}

export async function aggregateThemes(
  pairs: ExtractionPair[],
  options?: { skipEmbeddings?: boolean },
): Promise<Result<PainPointTheme[]>> {
  try {
    if (pairs.length === 0) return { ok: true, value: [] }

    const clusters = options?.skipEmbeddings
      ? clusterByStringDedup(pairs)
      : greedyCluster(
          pairs,
          await getEmbeddings(
            pairs.map((p) => p.extraction.pain_points.join(' ') + ' ' + p.extraction.key_quote),
          ),
          0.75,
        )

    return {
      ok: true,
      value: clusters
        .map((cluster) => {
          const avgSentiment =
            cluster.reduce((sum, p) => sum + sentimentScore[p.extraction.sentiment], 0) / cluster.length
          return {
            theme: cluster[0].extraction.key_quote,
            frequency: cluster.length,
            sources: [...new Set(cluster.map((p) => p.item.source))],
            sentiment: avgSentiment,
            evidence: cluster.slice(0, 3).map((p) => ({
              source: p.item.source,
              url: p.item.url,
              excerpt: p.extraction.key_quote,
            })),
          } satisfies PainPointTheme
        })
        .sort((a, b) => b.frequency - a.frequency),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export async function synthesizeReport(
  query: string,
  themes: { painPoints: PainPointTheme[]; competitorWeaknesses: PainPointTheme[]; emergingGaps: PainPointTheme[] },
): Promise<Result<string>> {
  try {
    const template = loadPrompt('synthesize_report.txt')
    const prompt = fillTemplate(template, { query, themes: JSON.stringify(themes, null, 2) })
    const value = await callLLM([{ role: 'user', content: prompt }], { maxTokens: 2048, temperature: 0.2 })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
