import { Hono } from 'hono';
import type {
  OnCommentCreateRequest,
  OnModActionRequest,
  TriggerResponse,
} from '@devvit/web/shared';

import {
  commandOnCreate,
  commandOnModAction,
  type CommandInput,
} from '../server/commands';
import { ports } from '../server/devvit/platform';
import { handleCommand } from '../server/karma';

export const triggers = new Hono();

// Trigger handlers never report failure to the platform: a failure is logged and dropped.
const ok: TriggerResponse = {};

async function run(input: CommandInput | undefined): Promise<void> {
  if (!input) return;
  try {
    const { outcome } = await handleCommand(input, await ports());
    if (outcome !== 'not-a-command')
      console.log(`${input.commentId} (${input.source}): ${outcome}`);
  } catch (error) {
    console.error(`Handling ${input.commentId} failed: ${String(error)}`);
  }
}

triggers.post('/on-comment-create', async (c) => {
  const { comment } = await c.req.json<OnCommentCreateRequest>();
  await run(commandOnCreate(comment));
  return c.json(ok, 200);
});

triggers.post('/on-mod-action', async (c) => {
  const { action, targetComment } = await c.req.json<OnModActionRequest>();
  await run(commandOnModAction(action, targetComment));
  return c.json(ok, 200);
});
