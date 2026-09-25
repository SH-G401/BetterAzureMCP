import { describe, expect, it } from 'vitest';
import { renderError, renderToolOutput } from '../../src/format/result.js';

const textOf = (result: ReturnType<typeof renderToolOutput>): string => {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
};

describe('renderToolOutput', () => {
  it('renders the summary followed by compact JSON', () => {
    const result = renderToolOutput(
      { summary: 'Found 1 resource.', data: { resources: [{ name: 'a' }] } },
      { maxBytes: 10_000, showSecrets: false },
    );
    expect(textOf(result)).toBe('Found 1 resource.\n\n{"resources":[{"name":"a"}]}');
    expect(result.isError).toBeUndefined();
  });

  it('masks secrets unless showSecrets is set', () => {
    const output = { summary: 's', data: { password: 'x' } };
    expect(textOf(renderToolOutput(output, { maxBytes: 1000, showSecrets: false }))).not.toContain(
      '"x"',
    );
    expect(textOf(renderToolOutput(output, { maxBytes: 1000, showSecrets: true }))).toContain(
      '"x"',
    );
  });

  it('drops whole list items to fit the budget and says so', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `/subscriptions/s/resource-${i}` }));
    const text = textOf(
      renderToolOutput(
        { summary: 's', data: { rows }, listKey: 'rows' },
        { maxBytes: 2_000, showSecrets: false },
      ),
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2_000);
    expect(text).toMatch(/Showing \d+ of 200 items/);
    const json = JSON.parse(text.split('\n\n')[2] ?? '') as { rows: unknown[] };
    expect(json.rows.length).toBeGreaterThan(0);
  });

  it('cuts off oversized output without a list', () => {
    const text = textOf(
      renderToolOutput(
        { summary: 's', data: { blob: 'x'.repeat(10_000) } },
        { maxBytes: 1_000, showSecrets: false },
      ),
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_000);
    expect(text).toContain('Output cut off');
  });
});

describe('renderError', () => {
  it('marks the result as an error', () => {
    expect(renderError('nope')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    });
  });
});
