import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';

interface Case {
  prompt: string;
  expected: string[];
}

const dataset = JSON.parse(
  readFileSync(new URL('../../eval/tool-selection.json', import.meta.url), 'utf8'),
) as { cases: Case[] };
const toolNames = TOOLS.map((t) => t.name);

const STOP_WORDS = new Set(
  'the and for with from that this your you are can use when which what into over only also like each their them then than such have has does azure resource resources tool tools call returns shows show'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

/** Highest share of distinctive words any two tool descriptions have in common. */
function maxDescriptionOverlap(): { pair: string; score: number } {
  let best = { pair: '', score: 0 };
  for (const [i, a] of TOOLS.entries()) {
    for (const b of TOOLS.slice(i + 1)) {
      const score = jaccard(words(a.description), words(b.description));
      if (score > best.score) best = { pair: `${a.name} / ${b.name}`, score };
    }
  }
  return best;
}

describe('tool-selection dataset', () => {
  it('only expects tools that exist', () => {
    for (const c of dataset.cases) {
      for (const name of c.expected) expect(toolNames, c.prompt).toContain(name);
    }
  });

  it('covers every tool with at least two prompts', () => {
    for (const name of toolNames) {
      const covered = dataset.cases.filter((c) => c.expected.includes(name)).length;
      expect(covered, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('has no duplicate prompts', () => {
    const prompts = dataset.cases.map((c) => c.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe('tool descriptions', () => {
  it('stay distinct from each other, so models can tell the tools apart', () => {
    const { pair, score } = maxDescriptionOverlap();
    // Overlapping tools are the main cause of wrong tool choices. If this fails, sharpen the
    // descriptions (or merge the tools) instead of raising the limit.
    expect(score, pair).toBeLessThan(0.25);
  });

  it('say what the tool is for in the first sentence', () => {
    for (const tool of TOOLS) {
      const first = tool.description.split(/(?<=\.)\s/)[0] ?? '';
      expect(first.length, tool.name).toBeGreaterThan(30);
      expect(first.length, tool.name).toBeLessThan(400);
    }
  });
});
