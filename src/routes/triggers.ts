import { Hono } from 'hono';
import type {
  OnCommentCreateRequest,
  OnModActionRequest,
  TriggerResponse,
} from '@devvit/web/shared';

import { parseCommand } from '../server/commands';
import { ports } from '../server/devvit/platform';
import { handleCommand, type CommandInput } from '../server/karma';

export const triggers = new Hono();

// Trigger handlers never report failure to the platform: a failure is logged and dropped.
const ok: TriggerResponse = {};

async function run(input: CommandInput): Promise<void> {
  try {
    const outcome = await handleCommand(input, await ports());
    if (outcome !== 'not-a-command')
      console.log(`${input.commentId} (${input.source}): ${outcome}`);
  } catch (error) {
    console.error(`Handling ${input.commentId} failed: ${String(error)}`);
  }
}

triggers.post('/on-comment-create', async (c) => {
  const { comment } = await c.req.json<OnCommentCreateRequest>();
  // Most comments are not commands: decide that from the payload, before any call.
  const body = comment?.body ?? '';
  if (comment && parseCommand(body) !== undefined) {
    await run({ commentId: comment.id, source: 'create', body });
  }
  return c.json(ok, 200);
});

// A command that a filter removed runs when a moderator approves it.
triggers.post('/on-mod-action', async (c) => {
  const { action, targetComment } = await c.req.json<OnModActionRequest>();
  if (
    action === 'approvecomment' &&
    targetComment &&
    parseCommand(targetComment.body ?? '') !== undefined
  ) {
    await run({ commentId: targetComment.id, source: 'approve' });
  }
  return c.json(ok, 200);
});
