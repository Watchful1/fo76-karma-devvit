import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';

import { config, ports, store } from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import { isCommentId } from '../server/ids';
import { importStatus, importStatusText } from '../server/import';
import { handleCommand, type CommandResult } from '../server/karma';
import { profileView } from '../server/profile';
import { DAY_MS, utcDayKey } from '../server/time';
import { exportForm, importForm, lookupForm, toast } from '../server/ui';
import { forEveryone, forModerators } from './guard';

export const menu = new Hono();

async function targetOf(c: Context): Promise<string> {
  return (await c.req.json<MenuItemRequest>()).targetId;
}

/** Opens the profile of the author of the post or comment the menu item was used on. */
async function authorProfile(
  c: Context,
  editable: boolean
): Promise<UiResponse> {
  const targetId = await targetOf(c);
  const username = isCommentId(targetId)
    ? (await devvitReddit.getComment(targetId)).authorName
    : (await devvitReddit.getPost(targetId)).authorName;
  return username
    ? profileView(store(), username, editable)
    : toast(
        'The author of this item is deleted. Use Karma lookup with their old name.'
      );
}

menu.post(
  '/profile',
  forEveryone((c) => authorProfile(c, false))
);

menu.post(
  '/profile-edit',
  forModerators((c) => authorProfile(c, true))
);

/** What a re-run did, in words a moderator can act on. */
function rerunToast(result: CommandResult): string {
  switch (result.outcome) {
    case 'not-a-command':
      return 'Re-run: this comment is not a karma or close command.';
    case 'skipped':
      return 'Re-run: skipped. The author is deleted, or the comment is by a bot.';
    case 'ignored':
      return 'Re-run: the comment is removed. Approve it and the command runs.';
    case 'already-handled':
      return 'Re-run: another run of this command is in progress.';
    case 'refused':
      return `Re-run: refused (${result.reason}). The bot replied.`;
    case 'rewarded':
      return 'Re-run: the reward is on record and the flair is rebuilt.';
    case 'closed':
      return 'Re-run: the post is closed.';
    case 'failed':
      return `Re-run failed: ${result.message}`;
    case 'disabled':
      return 'Re-run: the bot is disabled.';
  }
}

menu.post(
  '/rerun',
  forModerators(async (c) => {
    const result = await handleCommand(
      { commentId: await targetOf(c), source: 'rerun' },
      await ports()
    );
    return toast(rerunToast(result));
  })
);

menu.post(
  '/lookup',
  forModerators(async () => ({
    showForm: { name: 'lookup', form: lookupForm() },
  }))
);

menu.post(
  '/export',
  forModerators(async () => {
    const since = utcDayKey(Date.now() - 30 * DAY_MS);
    return { showForm: { name: 'exportSince', form: exportForm(since) } };
  })
);

menu.post(
  '/import',
  forModerators(async () => {
    if ((await config()).enabled)
      return toast('Turn Enabled off in the app settings before importing.');
    const status = importStatusText(await importStatus(store()), Date.now());
    const page = `karma-delta-${utcDayKey(Date.now())}`;
    return {
      showForm: { name: 'importData', form: importForm(page, status) },
    };
  })
);
