import { Hono } from 'hono';
import type { Context } from 'hono';

import { ports, store } from '../server/devvit/platform';
import { editProfile, profileView } from '../server/profile';
import {
  BAD_USERNAME,
  cleanUsername,
  selected,
  textField,
  toast,
} from '../server/ui';
import { forEveryone, forModerators } from './guard';

export const forms = new Hono();

type Values = Record<string, unknown>;

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
