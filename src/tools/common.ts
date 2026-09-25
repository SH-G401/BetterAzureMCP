import { z } from 'zod';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const subscriptionIdsSchema = z
  .array(z.string().regex(GUID, 'Expected a subscription ID (GUID).'))
  .max(100)
  .optional()
  .describe('Subscription IDs to search. Omit to search every subscription you have access to.');

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
