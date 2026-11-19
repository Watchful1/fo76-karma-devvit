import { Hono } from 'hono';
import type { Context } from 'hono';
import { context } from '@devvit/web/server';

import {
  config,
  ports,
  scheduleImportHop,
  store,
} from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import { loadSnapshot, startImport } from '../server/import';
import { editProfile, profileView } from '../server/profile';
import {
  BAD_USERNAME,
  cleanUsername,
  exportText,
  selected,
  textField,
  toast,
  wikiPageUrl,
} from '../server/ui';
import { forEveryone, forModerators } from './guard';

export const forms = new Hono();

type Values = Record<string, unknown>;

/**
 * The most rewards one export writes. A wiki write of 446 KB took 26.5 s of
 * the 30 a request gets; this many lines is about 200 KB.
 */
const EXPORT_LIMIT = 2000;

async function valuesOf(c: Context): Promise<Values> {
  return c.req.json<Values>();
}

// The read-only profile has nothing to save.
forms.post(
  '/profile-view',
  forEveryone(async () => ({}))
);

forms.post(
  '/profile-edit',
  forModerators(async (c, moderator) =>
    toast(await editProfile(await ports(), moderator, await valuesOf(c)))
  )
);

forms.post(
  '/lookup',
  forModerators(async (c) => {
    const values = await valuesOf(c);
    const username = cleanUsername(textField(values, 'username'));
    if (!username) return toast(BAD_USERNAME);
    return profileView(
      store(),
      username,
      selected(values, 'action') === 'edit'
    );
  })
);

forms.post(
  '/export-since',
  forModerators(async (c) => {
    const values = await valuesOf(c);
    const sinceMs = Date.parse(textField(values, 'since'));
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
  forModerators(async (c) => {
    const values = await valuesOf(c);
    if ((await config()).enabled)
      return toast('Turn Enabled off in the app settings before importing.');
    const page = textField(values, 'page');
    const fromWiki = selected(values, 'source') === 'wiki';
    if (fromWiki && !/^[\w/-]+$/.test(page))
      return toast('Enter the wiki page name: letters, digits, _ - and /.');
    const source = fromWiki ? `wiki:${page}` : 'bundled';

    // Read the file now, so a missing page or bad JSON is reported here and not in a log.
    const snapshot = await loadSnapshot(devvitReddit, source);
    const total = snapshot.profiles.length + snapshot.rewards.length;

    const run = await startImport(
      store(),
      source,
      total,
      values.again === true
    );
    if (run === undefined) {
      return toast(
        `The import from ${source} already finished. Tick "Run it again" to load it once more.`
      );
    }
    await scheduleImportHop(run);
    return toast(
      `Import from ${source} started: ${total} rows (${snapshot.profiles.length} profiles, ${snapshot.rewards.length} rewards). Open "Import karma data" again to see its progress.`
    );
  })
);
