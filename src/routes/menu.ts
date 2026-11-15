import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';

import { config, ports, store } from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import { flairFor } from '../server/flair';
import { isCommentId } from '../server/ids';
import { handleCommand, type Outcome } from '../server/karma';
import { Roles } from '../server/roles';
import { dayMs } from '../server/time';
import {
  exportForm,
  importForm,
  importStatusText,
  lookupForm,
  profileForm,
} from '../server/ui';
import { forEveryone, forModerators, toast } from './guard';
import { importStatus } from './scheduler';

export const menu = new Hono();


async function authorOf(targetId: string): Promise<string | undefined> {
  return isCommentId(targetId)
    ? (await devvitReddit.getComment(targetId)).authorName
    : (await devvitReddit.getPost(targetId)).authorName;
}

// The three views, shared with the lookup form.

export async function profileView(
  username: string,
  editable: boolean
): Promise<UiResponse> {
  const profile = await store().loadProfile(username);
  return {
    showForm: {
      name: editable ? 'profileEdit' : 'profileView',
      form: profileForm(profile, editable),
    },
  };
}

/** Rebuilds a user's flair from their profile, after an edit. */
export async function refreshFlair(username: string): Promise<void> {
  const current = await config();
  const profile = await store().loadProfile(username);
  const roles = new Roles(devvitReddit, current.courierPage);
  const flair = flairFor(
    profile,
    await roles.party(username),
    current.templates
  );
  await devvitReddit.setUserFlair(username, flair.text, flair.templateId);
}

/** The same, as a sentence for a toast: empty when it worked, the problem when it did not. */
export async function flairNote(username: string): Promise<string> {
  try {
    await refreshFlair(username);
    return '';
  } catch (error) {
    console.error(`Flair of u/${username} not set: ${String(error)}`);
    return ` The flair could not be set: ${String(error)}`;
  }
}

async function withAuthor(
  targetId: string,
  view: (username: string) => Promise<UiResponse>
): Promise<UiResponse> {
  const username = await authorOf(targetId);
  return username
    ? view(username)
    : toast(
        'The author of this item is deleted. Use Karma lookup with their old name.'
      );
}

async function targetOf(c: Context): Promise<string> {
  return (await c.req.json<MenuItemRequest>()).targetId;
}

menu.post(
  '/profile',
  forEveryone(async (c) =>
    withAuthor(await targetOf(c), (username) => profileView(username, false))
  )
);

menu.post(
  '/profile-edit',
  forModerators(async (c) =>
    withAuthor(await targetOf(c), (username) => profileView(username, true))
  )
);

/** What a re-run did, in words a moderator can act on. `lines` are what the handler logged. */
export function rerunToast(outcome: Outcome, lines: string[]): string {
  const last = lines.at(-1) ?? '';
  switch (outcome) {
    case 'not-a-command':
      return 'Re-run: this comment is not a karma or close command.';
    case 'skipped':
      return 'Re-run: skipped. The author is deleted, or the comment is by a bot.';
    case 'ignored':
      return 'Re-run: the comment is removed. Approve it and the command runs.';
    case 'already-handled':
      return 'Re-run: another run of this command is in progress.';
    case 'refused':
      return `Re-run: refused (${last.split('refused: ')[1] ?? 'see the reply'}). The bot replied.`;
    case 'rewarded':
      return 'Re-run: the reward is on record and the flair is rebuilt.';
    case 'closed':
      return 'Re-run: the post is closed.';
    case 'failed':
      return `Re-run failed: ${last}`;
    case 'disabled':
      return 'Re-run: the bot is disabled.';
  }
}

menu.post(
  '/rerun',
  forModerators(async (c) => {
    const base = await ports();
    const lines: string[] = [];
    const outcome = await handleCommand(
      { commentId: await targetOf(c), source: 'rerun' },
      {
        ...base,
        log: (message) => {
          lines.push(message);
          base.log(message);
        },
      }
    );
    return toast(rerunToast(outcome, lines));
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
    const since = new Date(Date.now() - 30 * dayMs())
      .toISOString()
      .slice(0, 10);
    return { showForm: { name: 'exportSince', form: exportForm(since) } };
  })
);

menu.post(
  '/import',
  forModerators(async () => {
    if ((await config()).enabled)
      return toast('Turn Enabled off in the app settings before importing.');
    const status = importStatusText(await importStatus(store()), Date.now());
    const page = `karma-delta-${new Date().toISOString().slice(0, 10)}`;
    return {
      showForm: { name: 'importData', form: importForm(page, status) },
    };
  })
);
