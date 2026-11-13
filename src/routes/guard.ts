// Wraps the menu and form endpoints. `forUserType` in devvit.json only hides a
// menu item, so every moderator endpoint checks the user here, on the server.
// A handler that throws answers with a toast instead of a bare error.

import type { Context } from 'hono';
import type { UiResponse } from '@devvit/web/shared';

import { currentModerator } from '../server/devvit/platform';

const TOAST_MAX = 250;

export function toast(text: string): UiResponse {
  return { showToast: text.slice(0, TOAST_MAX) };
}

function failure(c: Context, error: unknown): Response {
  console.error(`${c.req.path} failed: ${String(error)}`);
  return c.json(toast(`That failed: ${String(error)}`), 200);
}

/** An endpoint only moderators of this subreddit may use. The handler gets the moderator's username. */
export function forModerators(
  handler: (c: Context, moderator: string) => Promise<UiResponse>
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const moderator = await currentModerator();
      if (!moderator)
        return c.json(toast('Only moderators can use this.'), 200);
      return c.json(await handler(c, moderator), 200);
    } catch (error) {
      return failure(c, error);
    }
  };
}

/** An endpoint open to every user. */
export function forEveryone(
  handler: (c: Context) => Promise<UiResponse>
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return c.json(await handler(c), 200);
    } catch (error) {
      return failure(c, error);
    }
  };
}
