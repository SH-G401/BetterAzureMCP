import { z } from 'zod';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const subscriptionIdsSchema = z
  .array(z.string().regex(GUID, 'Expected a subscription ID (GUID).'))
  .max(100)
  .optional()
  .describe('Subscription IDs to search. Omit to search every subscription you have access to.');

export function resourceIdSchema(description: string) {
  return z.string().trim().min(1).max(1024).describe(description);
}

export function hoursSchema(defaultHours: number, maxHours: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(maxHours)
    .default(defaultHours)
    .describe(`How many hours to look back (default ${defaultHours}, max ${maxHours}).`);
}

export function limitSchema(defaultLimit: number, maxLimit: number, what = 'results') {
  return z
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(defaultLimit)
    .describe(`Maximum ${what} (default ${defaultLimit}).`);
}

/** A single line of free text that is embedded in a query as a string literal. */
export function searchTextSchema(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((v) => !/[\r\n]/.test(v), 'Must be a single line.')
    .describe(description);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Removes undefined, null and empty-array properties so results stay compact. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = v;
  }
  return out as Partial<T>;
}

export function isoHoursAgo(hours: number, now = Date.now()): string {
  return new Date(now - hours * 3_600_000).toISOString();
}

/** Parent resource ID of a child resource ID. */
export function lastSegment(resourceId: string): string {
  return resourceId.split('/').filter(Boolean).at(-1) ?? resourceId;
}
