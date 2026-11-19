// Wraps the menu and form endpoints. A handler that throws answers with a
// toast instead of a bare error.

import type { Context } from 'hono';
import type { UiResponse } from '@devvit/web/shared';

import { devvitReddit } from '../server/devvit/reddit';
import { moderatorOnly, toast } from '../server/ui';

export function forEveryone(
  handler: (c: Context) => Promise<UiResponse>
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return c.json(await handler(c), 200);
    } catch (error) {
      console.error(`${c.req.path} failed: ${String(error)}`);
      return c.json(toast(`That failed: ${String(error)}`), 200);
    }
  };
}

/** An endpoint only moderators of this subreddit may use. The handler gets the moderator's username. */
export function forModerators(
  handler: (c: Context, moderator: string) => Promise<UiResponse>
): (c: Context) => Promise<Response> {
  return forEveryone((c) =>
    moderatorOnly(devvitReddit, (moderator) => handler(c, moderator))
  );
}
