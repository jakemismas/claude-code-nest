// Pure helpers for the short text after an agent tag on a chat row. No vscode, no filesystem.

export const SUFFIX_MAX_LEN = 24;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

// Removes every whole-word, case-insensitive occurrence of each word.
function removeWords(text: string, toRemove: readonly string[]): string {
  let out = text;
  for (const word of toRemove) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return out;
}

// Collapses runs of whitespace and separators, then trims separators from both ends.
export function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*[-:|,;/]\s*){2,}/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

export function removeTicket(name: string, ticket: string | null): string {
  if (ticket === null || ticket.length === 0) {
    return tidy(name);
  }
  return tidy(name.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(ticket)}(?![\\p{L}\\p{N}])`, 'giu'), ' '));
}

// The chat name with the ticket id, the ticket title words and the agent word removed,
// cut to 24 characters. Empty when nothing is left.
export function chatSuffix(name: string, ticket: string | null, ticketTitle: string, agent: string): string {
  let text = removeTicket(name, ticket);
  const titleWords = words(ticketTitle).filter((w) => w.length > 1);
  text = removeWords(text, titleWords);
  const agentWords = words(agent);
  text = removeWords(text, agentWords);
  text = tidy(text);
  if (text.length > SUFFIX_MAX_LEN) {
    text = tidy(text.slice(0, SUFFIX_MAX_LEN));
  }
  return text;
}
