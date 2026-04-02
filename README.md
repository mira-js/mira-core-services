# @mia/core-services

[![npm](https://img.shields.io/npm/v/@mia/core-services)](https://www.npmjs.com/package/@mia/core-services)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://github.com/mira-js/mia-core/blob/main/LICENSE)

Shared service implementations for the MIA pipeline. This package contains the core business logic for job orchestration, LLM analysis, database operations, and Redis/OpenViking integration. Used by `@mia/api-core` and any custom implementations that need to reuse the pipeline logic.

---

## Install

```bash
npm install @mia/core-services
# or
pnpm add @mia/core-services
```

---

## Exports

### Orchestrator (`orchestrator`)

BullMQ queue management for research jobs.

```ts
import { orchestrator } from '@mia/core-services'

// Enqueue a new research job
const { id } = await orchestrator.enqueue({
  query: 'CRM pain points',
  depth: 'quick',
  sources: ['reddit', 'hackernews']
})

// Get job status and result
const job = await orchestrator.getJob(id)
// Returns: { jobId, status, query, sources, depth, createdAt, result? }

// List recent jobs
const jobs = await orchestrator.listJobs()
```

### LLM Service (`callLLM`, `extractFromItem`)

OpenAI-compatible LLM calls with structured output parsing.

```ts
import { callLLM, extractFromItem } from '@mia/core-services'

// Raw LLM call with structured output
const result = await callLLM({
  systemPrompt: 'You are a helpful assistant.',
  userPrompt: 'Extract pain points from this text...',
  outputSchema: z.object({ pain_points: z.array(z.string()) })
})

// Extract structured data from a CollectedItem
const extraction = await extractFromItem(item, query)
// Returns: ExtractionResult { pain_points, sentiment, category, mentioned_tools, key_quote }
```

### Analysis Pipeline (`analyzeItems`)

Full pipeline from raw items to synthesized research result.

```ts
import { analyzeItems } from '@mia/core-services'

const result = await analyzeItems({
  query: 'project management tools',
  items: collectedItems, // CollectedItem[] from collectors
  depth: 'quick'
})
// Returns: ResearchResult { summary, painPoints, competitorWeaknesses, emergingGaps, rawItems }
```

### Database (`db`)

PostgreSQL client with typed queries for research jobs.

```ts
import { db } from '@mia/core-services'

// Create a job record
const job = await db.createJob({
  jobId: 'abc123',
  query: 'CRM pain points',
  depth: 'quick',
  sources: ['reddit', 'hackernews']
})

// Update job status
await db.updateJobStatus('abc123', 'completed', result)

// Get job by ID
const job = await db.getJob('abc123')

// List recent jobs
const jobs = await db.listJobs({ limit: 50 })
```

### Redis (`redis`)

Redis client with connection pooling and typed operations.

```ts
import { redis } from '@mia/core-services'

// Set/get cached embeddings
await redis.setEmbeddings('key', embeddings)
const cached = await redis.getEmbeddings('key')

// Cache LLM responses
await redis.cacheLLMResponse('prompt-hash', response)
const cached = await redis.getCachedLLMResponse('prompt-hash')
```

### OpenViking (`openviking`)

OpenViking context store integration for semantic search and storage.

```ts
import { openviking } from '@mia/core-services'

// Store collected items
await openviking.ingestItems(items, { query, depth })

// Search for relevant context
const context = await openviking.findRelevantContext(query, { maxResults: 10 })

// Get resource by URI
const resource = await openviking.getResource('viking://resources/mia/items/abc123')
```

### Concurrency Utilities (`withConcurrency`)

Parallel execution with configurable concurrency limits.

```ts
import { withConcurrency } from '@mia/core-services'

// Process items in parallel with rate limiting
const results = await withConcurrency(
  items,
  async (item) => await extractFromItem(item, query),
  { concurrency: 5 }
)
```

---

## Pipeline Flow

The services work together to implement the full MIA research pipeline:

```
1. Job Orchestration
   └── orchestrator.enqueue() → BullMQ job

2. Collection Phase
   └── External collectors (@mia/core-collectors) → CollectedItem[]

3. OpenViking Ingestion (optional)
   └── openviking.ingestItems() → Store for future context

4. LLM Extraction
   └── withConcurrency(items, extractFromItem) → ExtractionResult[]

5. Embedding & Clustering
   └── getEmbeddings() + DBSCAN → Thematic clusters

6. Synthesis
   └── analyzeItems() → ResearchResult

7. Job Completion
   └── db.updateJobStatus() + orchestrator job completion
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | LLM provider API key |
| `OPENAI_BASE_URL` | No | DeepSeek | Any OpenAI-compatible base URL |
| `OPENAI_MODEL` | No | `deepseek-chat` | Model to use for extraction and synthesis |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `JINA_API_KEY` | No | — | Required for embeddings and clustering |
| `OPENVIKING_URL` | No | — | OpenViking base URL (optional) |
| `OPENVIKING_API_KEY` | No | — | OpenViking API key (optional) |
| `MIA_PROMPTS_DIR` | No | `../../prompts` | Directory for custom prompt overrides |
| `MIA_EXTRACTION_CONCURRENCY` | No | `5` | Parallel LLM calls during extraction |
| `MIA_OPENVIKING_INGEST_CONCURRENCY` | No | `10` | Parallel writes to OpenViking |

---

## Error Handling

All service functions return `Result<T, Error>` types (from `@mia/shared-core`) instead of throwing exceptions. This enables railway-oriented programming patterns:

```ts
import type { Result } from '@mia/shared-core'
import { analyzeItems } from '@mia/core-services'

const result: Result<ResearchResult> = await analyzeItems({ query, items, depth })

if (result.ok) {
  console.log('Analysis succeeded:', result.value)
} else {
  console.error('Analysis failed:', result.error)
  // Handle gracefully without try/catch
}
```

---

## Customization

### Prompt Overrides

Override any of the three pipeline prompts by setting `MIA_PROMPTS_DIR`:

```bash
MIA_PROMPTS_DIR=/path/to/my-prompts
```

Required files:
- `categorize_content.txt` — First-pass relevance classification
- `extract_pain_points.txt` — Structured per-item extraction
- `synthesize_report.txt` — Final cross-item synthesis

### LLM Provider

Use any OpenAI-compatible provider:

```ts
process.env.OPENAI_BASE_URL = 'https://api.groq.com/openai/v1'
process.env.OPENAI_MODEL = 'llama-3.3-70b-versatile'
```

### Concurrency Tuning

Adjust parallelism for your infrastructure:

```bash
MIA_EXTRACTION_CONCURRENCY=10        # More parallel LLM calls
MIA_OPENVIKING_INGEST_CONCURRENCY=5  # Slower OpenViking writes
```

---

## Part of mia-core

This package is part of the [mia-core](https://github.com/mira-js/mia-core) monorepo — a self-hostable market intelligence engine.