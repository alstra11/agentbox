// Numbered options in a thread field, for the relay client (from renderer/src/format.ts).

export interface ParsedOption {
  n: number;
  text: string;
  recommended: boolean;
}

export function parseOptions(body?: string): ParsedOption[] {
  if (!body) return [];
  const lines = body.split('\n');
  let inOptions = false;
  const options: ParsedOption[] = [];
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      inOptions = /option/i.test(line);
      continue;
    }
    if (!inOptions) continue;
    const m = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (m) {
      options.push({
        n: Number(m[1]),
        text: m[2].trim(),
        recommended: /\(recommended\)/i.test(m[2]),
      });
    }
  }
  return options;
}

export type OptionsField = 'result' | 'note' | 'body';

interface HasFields {
  result?: string;
  note?: string;
  body?: string;
  wrote?: Record<string, { ts: number } | undefined>;
}

const writtenAt = (item: HasFields, field: OptionsField) => item.wrote?.[field]?.ts ?? 0;

export function optionsFrom(item: HasFields): OptionsField {
  const inResult = parseOptions(item.result).length > 0;
  const inNote = parseOptions(item.note).length > 0;
  if (inResult && inNote) return writtenAt(item, 'note') > writtenAt(item, 'result') ? 'note' : 'result';
  if (inResult) return 'result';
  if (inNote) return 'note';
  return 'body';
}

export function itemOptions(item: HasFields): ParsedOption[] {
  const field = optionsFrom(item);
  return parseOptions(item[field] as string | undefined);
}
