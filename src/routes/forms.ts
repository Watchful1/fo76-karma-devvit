import { Hono } from 'hono';
import type { Context } from 'hono';
import { context } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';

import { config, store } from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import {
  cleanUsername,
  exportText,
  profileFromForm,
  selected,
  wikiPageUrl,
} from '../server/ui';
import { forEveryone, forModerators, toast } from './guard';
import { flairNote, profileView } from './menu';
import { loadSnapshot, startImport } from './scheduler';

export const forms = new Hono();

type Values = Record<string, unknown>;

/**
 * The most rewards one export writes. A wiki write of 446 KB took 26.5 s of
 * the 30 a request gets; this many lines is about 200 KB.
 */
export const EXPORT_LIMIT = 2000;

function text(values: Values, name: string): string {
  const value = values[name];
  return typeof value === 'string' ? value.trim() : '';
}

async function valuesOf(c: Context): Promise<Values> {
  return c.req.json<Values>();
}

const BAD_USERNAME = 'That is not a Reddit username.';

// The read-only profile has nothing to save.
forms.post(
  '/profile-view',
  forEveryone(async () => ({}))
);

forms.post(
  '/profile-edit',
  forModerators(async (c, moderator) => {
    const values = await valuesOf(c);
    const username = cleanUsername(text(values, 'username'));
    if (!username) return toast(BAD_USERNAME);

    const db = store();
    const before = await db.loadProfile(username);
    const edit = profileFromForm(values, before.redditUsername);
    if (edit.kind === 'invalid') return toast(edit.problem);

    if (edit.kind === 'delete') {
      const placeholder = await db.deleteProfile(username);
      console.log(
        `u/${moderator} deleted a karma profile; its name is now ${placeholder}`
      );
      const flair = await devvitReddit
        .clearUserFlair(username)
        .then(() => '')
        .catch(
          (error: unknown) =>
            ` The flair could not be cleared: ${String(error)}`
        );
      return toast(
        `Deleted the karma profile and history of u/${username}. Other users' histories now show ${placeholder}.${flair}`
      );
    }

    // The karma changes by what the moderator changed it by, so a reward that
    // landed while the form was open is kept.
    const delta = edit.profile.karma - (edit.openedKarma ?? before.karma);
    await db.saveDetails(edit.profile);
    const karma =
      delta === 0 ? before.karma : await db.addKarma(username, delta);
    const after = { ...edit.profile, karma };
    await db.appendHistory(username, {
      kind: 'edit',
      atMs: Date.now(),
      moderator,
      before,
      after,
    });
    const note = await flairNote(username);
    return toast(
      `Saved u/${username}: karma ${after.karma}, Market76 ${after.m76Karma}.${note}`
    );
  })
);

forms.post(
  '/lookup',
  forModerators(async (c) => {
    const values = await valuesOf(c);
    const username = cleanUsername(text(values, 'username'));
    if (!username) return toast(BAD_USERNAME);
    switch (selected(values, 'action')) {
      case 'edit':
        return profileView(username, true);
      default:
        return profileView(username, false);
    }
  })
);

forms.post(
  '/export-since',
  forModerators(async (c) => {
    const values = await valuesOf(c);
    const sinceMs = Date.parse(text(values, 'since'));
    if (Number.isNaN(sinceMs))
      return toast('Enter the date as YYYY-MM-DD, or a full ISO time.');
    // One more than the limit, to know whether there are more.
    const rewards = await store().eventsSince(sinceMs, EXPORT_LIMIT + 1);
    const output = exportText(rewards, sinceMs, EXPORT_LIMIT);
    const page = `karma-export/${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;
    const restricted = await devvitReddit.writeModWikiPage(
      page,
      output.text,
      'Karma export'
    );
    return {
      ...toast(
        `Wrote ${output.shown} rewards to the wiki page ${page}.` +
          (output.truncated
            ? ' There are more: the page says where to continue.'
            : '') +
          (restricted
            ? ''
            : ' The page could NOT be limited to moderators: set its permissions by hand.')
      ),
      navigateTo: wikiPageUrl(context.subredditName, page),
    };
  })
);

forms.post(
  '/import-data',
  forModerators(async (c): Promise<UiResponse> => {
    const values = await valuesOf(c);
    if ((await config()).enabled)
      return toast('Turn Enabled off in the app settings before importing.');
    const page = text(values, 'page');
    const fromWiki = selected(values, 'source') === 'wiki';
    if (fromWiki && !/^[\w/-]+$/.test(page))
      return toast('Enter the wiki page name: letters, digits, _ - and /.');
    const source = fromWiki ? `wiki:${page}` : 'bundled';

    // Read the file now, so a missing page or bad JSON is reported here and not in a log.
    const snapshot = await loadSnapshot(source);
    const total = snapshot.profiles.length + snapshot.rewards.length;

    const db = store();
    const sameSource = (await db.meta('import:source')) === source;
    const progress = await db.importProgress();
    if (sameSource && progress.done && values.again !== true) {
      return toast(
        `The import from ${source} already finished. Tick "Run it again" to load it once more.`
      );
    }
    // A different source, or a finished one, starts over; the same unfinished source resumes.
    if (!sameSource || progress.done)
      await db.setImportProgress({ rows: 0, done: false });
    await startImport(db, source, total);
    return toast(
      `Import from ${source} started: ${total} rows (${snapshot.profiles.length} profiles, ${snapshot.rewards.length} rewards). Open "Import karma data" again to see its progress.`
    );
  })
);
