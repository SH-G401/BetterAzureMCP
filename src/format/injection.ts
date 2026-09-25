/**
 * Heuristics for text that addresses an AI assistant rather than a human reader: the
 * signature of indirect prompt injection planted in logs, resource tags, commit messages or
 * database rows. A match is not proof of an attack, only a reason to warn the model.
 */
const PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the rules above"
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,40}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  // "you are now ...", "new instructions:", "system prompt"
  /\b(you are now|new instructions\s*:|system prompt|developer mode|jailbreak)/i,
  // Fake chat or tool markup
  /<\/?\s*(system|assistant|instructions?|tool_call|function_calls?|antml:[a-z_]+)\s*>/i,
  // "AI assistant, please ...", "Note to the AI:"
  /\b(to|attention|dear|hey)\s+(the\s+)?(ai|llm|assistant|agent|copilot|claude|chatgpt)(\s+(assistant|agent|model))?\s*[:,]/i,
  // "call/use the azure_... tool"
  /\b(call|use|invoke|run|execute)\s+(the\s+)?(tool\s+)?`?azure_[a-z_]+/i,
  // "send the secrets/token to https://..."
  /\b(send|post|upload|forward|exfiltrate|leak)\b[^\n]{0,80}\b(secrets?|passwords?|credentials?|tokens?|api[ _-]?keys?)\b[^\n]{0,80}(https?:\/\/|\bto\s+the\s+following\b)/i,
];

const MAX_STRINGS = 20_000;

export interface InjectionFinding {
  count: number;
  /** JSON path of the first suspicious value, e.g. `rows[3].Message`. */
  firstPath?: string;
}

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

/** Scans every string in `data` (keys included). Bounded, so huge results stay cheap. */
export function findInjection(data: unknown): InjectionFinding {
  let count = 0;
  let firstPath: string | undefined;
  let scanned = 0;

  const visit = (value: unknown, path: string): void => {
    if (scanned >= MAX_STRINGS) return;
    if (typeof value === 'string') {
      scanned++;
      if (looksLikeInjection(value)) {
        count++;
        firstPath ??= path || '(root)';
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        visit(item, `${path}[${i}]`);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        visit(key, childPath);
        visit(item, childPath);
      }
    }
  };

  visit(data, '');
  return firstPath === undefined ? { count } : { count, firstPath };
}
