import type { CallToolResult } from '@modelcontextprotocol/server';
import { redactSecrets } from './redact.js';

export interface ToolOutput {
  /** One or two sentences a model (or human) can act on without reading the data. */
  summary: string;
  data: unknown;
  /**
   * Name of the top-level array in `data` that may be shortened to fit the response budget.
   * Without it, oversized output is cut off as text.
   */
  listKey?: string;
}

export interface RenderOptions {
  maxBytes: number;
  showSecrets: boolean;
}

/** Renders a tool result as a summary line followed by compact JSON, within a size budget. */
export function renderToolOutput(output: ToolOutput, options: RenderOptions): CallToolResult {
  const data = options.showSecrets ? output.data : redactSecrets(output.data);
  return {
    content: [
      { type: 'text', text: fitToBudget(output.summary, data, output.listKey, options.maxBytes) },
    ],
  };
}

export function renderError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function fitToBudget(
  summary: string,
  data: unknown,
  listKey: string | undefined,
  maxBytes: number,
): string {
  const compose = (payload: unknown, note?: string): string =>
    [summary, note, JSON.stringify(payload)].filter((part) => part !== undefined).join('\n\n');

  const full = compose(data);
  if (byteLength(full) <= maxBytes) return full;

  const list = listKey !== undefined ? getList(data, listKey) : undefined;
  if (list !== undefined) {
    // Keep as many whole items as fit. Binary search over the item count.
    let low = 0;
    let high = list.length;
    let best = compose(
      { ...(data as object), [listKey as string]: [] },
      truncationNote(0, list.length),
    );
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = compose(
        { ...(data as object), [listKey as string]: list.slice(0, mid) },
        truncationNote(mid, list.length),
      );
      if (byteLength(candidate) <= maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (byteLength(best) <= maxBytes) return best;
  }

  const note = `[Output cut off at ${Math.round(maxBytes / 1024)} KB. Ask for less data, for example with a narrower query or fewer columns.]`;
  return truncateBytes(compose(data), maxBytes - byteLength(note) - 2) + '\n\n' + note;
}

function truncationNote(shown: number, total: number): string {
  return `[Showing ${shown} of ${total} items to stay within the response size limit. Narrow the query (filters, fewer columns, or a smaller limit) to see the rest.]`;
}

function getList(data: unknown, key: string): unknown[] | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : undefined;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  // Decoding a cut buffer may end in a partial character; drop the replacement char.
  return buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/�$/, '');
}
