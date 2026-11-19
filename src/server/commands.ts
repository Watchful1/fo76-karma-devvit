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

export type CommandSource = 'create' | 'approve' | 'rerun';

export type CommandInput = {
  commentId: string;
  source: CommandSource;
  /** The body from the trigger payload, when there is one: it saves a fetch for the comments that are not commands. */
  body?: string;
};

type PayloadComment = { id: string; body?: string } | undefined;

// Most comments are not commands. The triggers decide that from the payload,
// before any call to Reddit.

/** The command a new comment carries, if it is one. */
export function commandOnCreate(
  comment: PayloadComment
): CommandInput | undefined {
  const body = comment?.body ?? '';
  return comment && parseCommand(body) !== undefined
    ? { commentId: comment.id, source: 'create', body }
    : undefined;
}

/** The command a moderator brought back by approving its comment, after a filter removed it. */
export function commandOnModAction(
  action: string | undefined,
  comment: PayloadComment
): CommandInput | undefined {
  return action === 'approvecomment' &&
    comment &&
    parseCommand(comment.body ?? '') !== undefined
    ? { commentId: comment.id, source: 'approve' }
    : undefined;
}
