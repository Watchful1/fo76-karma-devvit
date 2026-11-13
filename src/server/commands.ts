import type { CommandKind } from './types';

const GIVE = /^(\++karma|karma\++)/i;
const TAKE = /^(-+karma|karma-+)/i;
const CLOSE = /^(!close|close!)/i;

/** Reads a command from the start of a comment body, or undefined when there is none. */
export function parseCommand(body: string): CommandKind | undefined {
  const text = body.trim().replaceAll('\\', '');
  if (GIVE.test(text)) return 'give';
  if (TAKE.test(text)) return 'take';
  if (CLOSE.test(text)) return 'close';
  return undefined;
}
