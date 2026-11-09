// The question line for a relay client, pared from renderer/src/ask-line.ts.

const ASK_BUDGET = 130;

interface AskFields { result?: string; note?: string; body?: string; title?: string }

function isFurniture(line: string): boolean {
  return /^\s*\d+[.)]\s/.test(line)
    || /^\s*[-*+]\s/.test(line)
    || /^!\[[^\]]*\]\([^)]*\)$/.test(line)
    || /^>/.test(line)
    || /^([-*_]\s*){3,}$/.test(line);
}

function words(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const RECAP_HEAD = /where we were|^\s*gist\s*$/i;

export function askFromField(text: string, title?: string): string {
  const label = (title ?? '').replace(/…$/, '').trim();
  let under = '';
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,4}\s/.test(line)) { under = line.replace(/^#{1,4}\s*/, ''); continue; }
    if (isFurniture(line) || RECAP_HEAD.test(under)) continue;
    if (label && line.startsWith(label)) line = line.slice(label.length).trim();
    const bold = line.match(/^\*\*(.+?)\*\*/);
    const said = words(bold ? bold[1] : line);
    if (!said) continue;
    return said.length > ASK_BUDGET ? `${said.slice(0, ASK_BUDGET)}…` : said;
  }
  return '';
}

export function relayQuestion(item: AskFields, optionsField: 'result' | 'note' | 'body'): string {
  const text = item[optionsField] ?? '';
  const q = askFromField(text, item.title);
  if (q) return q;
  const t = (item.title ?? '').trim();
  return t.length > ASK_BUDGET ? `${t.slice(0, ASK_BUDGET)}…` : t;
}
