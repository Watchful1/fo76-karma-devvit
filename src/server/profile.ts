// The karma profile forms: showing a profile, and saving or deleting it from
// the moderators' edit form.

import type { UiResponse } from '@devvit/web/shared';

import { refreshFlair } from './flair';
import type { Store } from './store';
import type { Ports } from './types';
import {
  BAD_USERNAME,
  cleanUsername,
  profileForm,
  profileFromForm,
  textField,
} from './ui';

export async function profileView(
  store: Store,
  username: string,
  editable: boolean
): Promise<UiResponse> {
  const profile = await store.loadProfile(username);
  return {
    showForm: {
      name: editable ? 'profileEdit' : 'profileView',
      form: profileForm(profile, editable),
    },
  };
}

/** Rebuilds a user's flair after an edit, as a sentence for a toast: empty when it worked, the problem when it did not. */
async function flairNote(ports: Ports, username: string): Promise<string> {
  try {
    await refreshFlair(ports, username);
    return '';
  } catch (error) {
    console.error(`Flair of u/${username} not set: ${String(error)}`);
    return ` The flair could not be set: ${String(error)}`;
  }
}

/**
 * Saves or deletes a profile from the submitted edit form, and returns what
 * the toast says. The karma changes by what the moderator changed it by, so a
 * reward that lands while the form is open is kept.
 */
export async function editProfile(
  ports: Ports,
  moderator: string,
  values: Record<string, unknown>
): Promise<string> {
  const { reddit, store, log } = ports;
  const username = cleanUsername(textField(values, 'username'));
  if (!username) return BAD_USERNAME;

  const before = await store.loadProfile(username);
  const edit = profileFromForm(values, before.redditUsername);
  if (edit.kind === 'invalid') return edit.problem;

  if (edit.kind === 'delete') {
    const placeholder = await store.deleteProfile(username);
    log(
      `u/${moderator} deleted a karma profile; its name is now ${placeholder}`
    );
    const flair = await reddit.clearUserFlair(username).then(
      () => '',
      (error: unknown) => ` The flair could not be cleared: ${String(error)}`
    );
    return `Deleted the karma profile and history of u/${username}. Other users' histories now show ${placeholder}.${flair}`;
  }

  const delta = edit.profile.karma - (edit.openedKarma ?? before.karma);
  await store.saveDetails(edit.profile);
  const karma =
    delta === 0 ? before.karma : await store.addKarma(username, delta);
  const { m76Karma } = edit.profile;
  log(
    `u/${moderator} edited u/${username}: karma ${before.karma} to ${karma}, Market76 ${before.m76Karma} to ${m76Karma}`
  );
  const note = await flairNote(ports, username);
  return `Saved u/${username}: karma ${karma}, Market76 ${m76Karma}.${note}`;
}
