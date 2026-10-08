// Shared HTML parser — used by both the foreground monitor (index.tsx)
// and the background fetch task (tasks/backgroundMonitor.ts).

export interface QueueEntry {
  position: number;
  mobile: number;
}

export function parseQueueHTML(html: string): QueueEntry[] {
  const entries: QueueEntry[] = [];
  const divTagRe = /<\/?div\b[^>]*>/gi;
  let opening: RegExpExecArray | null;

  while ((opening = divTagRe.exec(html)) !== null) {
    if (opening[0].startsWith('</')) continue;

    const classMatch = opening[0].match(/\bclass\s*=\s*["']([^"']*)["']/i);
    if (!classMatch) continue;

    const classes = classMatch[1].split(/\s+/);
    const isQueueCard =
      classes.includes('card') &&
      (classes.includes('bg-warning') || classes.includes('bg-danger'));
    if (!isQueueCard) continue;

    // Find this card's closing tag while accounting for nested divs.
    let depth = 1;
    let closingIndex = -1;
    let tag: RegExpExecArray | null;
    while ((tag = divTagRe.exec(html)) !== null) {
      if (tag[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          closingIndex = tag.index;
          break;
        }
      } else if (!tag[0].endsWith('/>')) {
        depth += 1;
      }
    }
    if (closingIndex < 0) break;

    const cardHTML = html.slice(opening.index, divTagRe.lastIndex);
    if (!/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcard-body\b[^"']*["']/i.test(cardHTML)) {
      continue;
    }

    const values: string[] = [];
    const strongRe = /<strong[^>]*>([\s\S]*?)<\/strong>/gi;
    let m: RegExpExecArray | null;
    while ((m = strongRe.exec(cardHTML)) !== null) {
      values.push(m[1].trim());
    }
    if (values.length >= 2) {
      const mob = parseInt(values[1], 10);
      // The server's displayed position includes green (balneario) cards.
      // Re-number eligible cards in queue order so position reflects only
      // warning/danger mobiles.
      if (!isNaN(mob)) {
        entries.push({ position: entries.length + 1, mobile: mob });
      }
    }
  }
  return entries;
}
