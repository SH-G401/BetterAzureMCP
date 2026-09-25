// Measures how often a model picks the right BetterAzureMCP tool for realistic debugging
// prompts (eval/tool-selection.json). Tool definitions and server instructions are read from
// the built server over MCP, exactly as clients see them.
//
// Usage: npm run eval:tools
// Needs Anthropic API credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
// Each run costs real money: about 55 requests of ~7k input tokens each.
//
// Environment:
//   EVAL_MODEL          model to test (default claude-opus-5)
//   EVAL_MIN_ACCURACY   fail below this share of correct first calls (default 0.95)
//   EVAL_CONCURRENCY    parallel requests (default 4)
//   EVAL_DRY_RUN=1      check the dataset and tool definitions without calling the API

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const MODEL = process.env.EVAL_MODEL ?? 'claude-opus-5';
const MIN_ACCURACY = Number(process.env.EVAL_MIN_ACCURACY ?? '0.95');
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? '4');

const dataset = JSON.parse(
  await readFile(new URL('../eval/tool-selection.json', import.meta.url), 'utf8'),
);

// Read the tool list and instructions from the real server.
const mcp = new Client({ name: 'tool-selection-eval', version: '1.0.0' });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['dist/betterazuremcp.mjs'],
    env: {
      ...process.env,
      BETTERAZUREMCP_LOG_LEVEL: 'error',
      BETTERAZUREMCP_REMEMBER_CONTEXT: 'false',
    },
    stderr: 'ignore',
  }),
);
const { tools } = await mcp.listTools();
const instructions = mcp.getInstructions() ?? '';
await mcp.close();

/** @type {Anthropic.Beta.BetaTool[]} */
const apiTools = tools.map((tool) => ({
  name: tool.name,
  description: tool.description ?? '',
  input_schema: /** @type {Anthropic.Beta.BetaTool.InputSchema} */ (tool.inputSchema),
}));

if (process.env.EVAL_DRY_RUN === '1') {
  const names = new Set(apiTools.map((t) => t.name));
  const unknown = dataset.cases.flatMap((c) => c.expected).filter((n) => !names.has(n));
  console.log(
    `Dry run: ${apiTools.length} tools, ${dataset.cases.length} prompts, model ${MODEL}.`,
  );
  console.log(`Tool definitions: ${JSON.stringify(apiTools).length} characters.`);
  if (unknown.length > 0) {
    console.error(`Unknown expected tools: ${[...new Set(unknown)].join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

const client = new Anthropic();

async function firstToolCall(prompt) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Route a refused request to a fallback model instead of failing the case.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: instructions,
    tools: apiTools,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    return { tool: undefined, note: 'refused', usage: response.usage };
  }
  const call = response.content.find((block) => block.type === 'tool_use');
  return { tool: call?.name, input: call?.input, usage: response.usage };
}

const results = [];

async function runCase(item) {
  const outcome = await firstToolCall(item.prompt);
  results.push({ ...item, ...outcome, pass: item.expected.includes(outcome.tool) });
  process.stderr.write('.');
}

// The first case runs alone, so a credential or network problem stops the run right away
// instead of failing every case.
try {
  await runCase(dataset.cases[0]);
} catch (error) {
  console.error(`Cannot reach the Claude API: ${error.message}`);
  console.error('Set ANTHROPIC_API_KEY or run `ant auth login`, then retry.');
  process.exit(2);
}

let next = 1;
async function worker() {
  while (next < dataset.cases.length) {
    const item = dataset.cases[next++];
    try {
      await runCase(item);
    } catch (error) {
      results.push({ ...item, tool: undefined, note: `error: ${error.message}`, pass: false });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write('\n');

const passed = results.filter((r) => r.pass).length;
const accuracy = passed / results.length;
const inputTokens = results.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0);
const outputTokens = results.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0);

console.log(`Model: ${MODEL}`);
console.log(`Correct first tool: ${passed}/${results.length} (${(accuracy * 100).toFixed(1)}%)`);
console.log(`Tokens: ${inputTokens} input, ${outputTokens} output`);
for (const r of results.filter((x) => !x.pass)) {
  console.log(
    `\n  FAIL  expected ${r.expected.join(' or ')}, got ${r.tool ?? r.note ?? 'no tool call'}`,
  );
  console.log(`        ${r.prompt}`);
}

await mkdir('eval/results', { recursive: true });
const file = `eval/results/${new Date().toISOString().replace(/[:.]/g, '-')}-${MODEL}.json`;
await writeFile(file, JSON.stringify({ model: MODEL, accuracy, results }, null, 2));
console.log(`\nFull results: ${file}`);

process.exit(accuracy >= MIN_ACCURACY ? 0 : 1);
