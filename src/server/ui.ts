// The forms the menu items open, and the reading of what they submit. Pure:
// builders take data and return a Devvit form. Values are pre-filled through
// each field's defaultValue, since a form's `data` does not pre-fill on this
// platform version.

import type { Form, FormField } from '@devvit/shared-types/shared/form.js';

import { PLATFORMS, type ImportedReward, type Profile } from './types';

/** The largest karma a moderator can type, so a slip of the keyboard is refused. */
export const KARMA_LIMIT = 1_000_000;
const GAMERTAG_MAX = 64;

/** A Reddit username from what a moderator typed, without `u/`, or undefined when it cannot be one. */
export function cleanUsername(raw: string): string | undefined {
  const name = raw.trim().replace(/^\/?u\//i, '');
  return /^[A-Za-z0-9_-]{3,20}$/.test(name) ? name : undefined;
}

function gamertag(
  profile: Profile,
  platform: string
): { username: string; userId: string } {
  const found = profile.gamertags.find((tag) => tag.platform === platform);
  return { username: found?.username ?? '', userId: found?.userId ?? '' };
}

/** The read-only profile card everyone can open, or the moderators' editable version. */
/** The read-only profile as lines of text, for the form's description. */
export function profileText(profile: Profile): string {
  return [
    `r/Fallout76Marketplace karma: ${profile.karma}`,
    `r/Market76 karma: ${profile.m76Karma}`,
    ...PLATFORMS.map(
      (platform) =>
        `${platform} gamertag: ${gamertag(profile, platform).username || 'none'}`
    ),
  ].join('\n');
}

export function profileForm(profile: Profile, editable: boolean): Form {
  if (!editable) {
    return {
      title: `Karma profile of u/${profile.redditUsername}`,
      description: profileText(profile),
      acceptLabel: 'Close',
      fields: [],
    };
  }
  const fields: FormField[] = [
    {
      type: 'string',
      name: 'username',
      label: 'Username',
      defaultValue: profile.redditUsername,
      disabled: true,
    },
    {
      type: 'number',
      name: 'karma',
      label: 'r/Fallout76Marketplace karma',
      defaultValue: profile.karma,
      required: true,
    },
    {
      type: 'number',
      name: 'm76Karma',
      label: 'r/Market76 karma',
      defaultValue: profile.m76Karma,
      required: true,
    },
    ...PLATFORMS.flatMap((platform): FormField[] => {
      const tag = gamertag(profile, platform);
      return [
        {
          type: 'string',
          name: platform,
          label: `${platform} gamertag`,
          defaultValue: tag.username,
          disabled: false,
        },
        {
          type: 'string',
          name: `${platform}Id`,
          label: `${platform} gamertag id`,
          defaultValue: tag.userId,
        },
      ];
    }),
    {
      type: 'string',
      name: 'openedKarma',
      label: 'Karma when this form was opened',
      helpText:
        'A change to the karma above is applied as the difference from this, so a reward given in the meantime is kept.',
      defaultValue: String(profile.karma),
      disabled: true,
    },
    {
      type: 'boolean',
      name: 'deleteProfile',
      label:
        'Delete this profile, its history and its reward index entries (a data deletion request)',
      defaultValue: false,
    },
  ];
  return {
    title: `Edit karma profile of u/${profile.redditUsername}`,
    acceptLabel: 'Save',
    fields,
  };
}

export type ProfileEdit =
  /** `openedKarma` is what the form showed when it was opened, when it says. */
  | { kind: 'save'; profile: Profile; openedKarma: number | undefined }
  | { kind: 'delete' }
  | { kind: 'invalid'; problem: string };

function wholeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && Math.abs(number) <= KARMA_LIMIT
    ? number
    : undefined;
}

/** Reads the submitted edit form: a profile to save, a deletion, or what is wrong with it. */
export function profileFromForm(
  values: Record<string, unknown>,
  username: string
): ProfileEdit {
  if (values.deleteProfile === true) return { kind: 'delete' };

  const text = (name: string): string => {
    const value = values[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const karma = wholeNumber(values.karma);
  const m76Karma = wholeNumber(values.m76Karma);
  if (karma === undefined || m76Karma === undefined) {
    return {
      kind: 'invalid',
      problem: `Karma must be a whole number between -${KARMA_LIMIT} and ${KARMA_LIMIT}.`,
    };
  }
  const tooLong = PLATFORMS.find(
    (platform) =>
      text(platform).length > GAMERTAG_MAX ||
      text(`${platform}Id`).length > GAMERTAG_MAX
  );
  if (tooLong) {
    return {
      kind: 'invalid',
      problem: `The ${tooLong} gamertag or id is longer than ${GAMERTAG_MAX} characters.`,
    };
  }
  return {
    kind: 'save',
    profile: {
      redditUsername: username,
      karma,
      m76Karma,
      gamertags: PLATFORMS.filter((platform) => text(platform) !== '').map(
        (platform) => ({
          platform,
          username: text(platform),
          // A gamertag with no id is stored with "0", as the old profile app did.
          userId: text(`${platform}Id`) || '0',
        })
      ),
    },
    openedKarma: wholeNumber(values.openedKarma),
  };
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** `+1`, `-1`, or `±1` for a reward from the old log, which did not record the sign. */
export function signText(sign: 1 | -1 | 0): string {
  return sign === 0 ? '±1' : sign > 0 ? '+1' : '-1';
}

/** `u/name`, or the bare placeholder that stands for a deleted profile. */
export const LOOKUP_ACTIONS = ['profile', 'edit'] as const;
export type LookupAction = (typeof LOOKUP_ACTIONS)[number];

export function lookupForm(): Form {
  return {
    title: 'Karma lookup',
    acceptLabel: 'Open',
    fields: [
      { type: 'string', name: 'username', label: 'Username', required: true },
      {
        type: 'select',
        name: 'action',
        label: 'Open',
        defaultValue: ['profile'],
        options: [
          { label: 'Karma profile', value: 'profile' },
          { label: 'Edit karma profile', value: 'edit' },
        ],
      },
    ],
  };
}

/** The address of a page in the old wiki, where the app writes, on old Reddit: reddit.com shows only the new wiki. */
export function wikiPageUrl(subredditName: string, page: string): string {
  const path = page.split('/').map(encodeURIComponent).join('/');
  return `https://old.reddit.com/r/${encodeURIComponent(subredditName)}/wiki/${path}`;
}

export function exportForm(defaultSince: string): Form {
  return {
    title: 'Export karma rewards',
    description:
      'Writes the rewards since the time to a wiki page named karma-export/<time>, which only moderators can see, and opens it on old.reddit.com.',
    acceptLabel: 'Export',
    fields: [
      {
        type: 'string',
        name: 'since',
        label: 'Since (YYYY-MM-DD or a full ISO time, UTC)',
        defaultValue: defaultSince,
        required: true,
      },
    ],
  };
}

/**
 * The wiki text of an export: a header and one line per reward, as a code
 * block. At most `limit` rewards are written; when there are more, the header
 * gives the time to export from next.
 */
export function exportText(
  rewards: ImportedReward[],
  sinceMs: number,
  limit: number
): { text: string; shown: number; truncated: boolean } {
  const shown = rewards.slice(0, limit);
  const next = rewards[limit];
  const header = next
    ? `The first ${shown.length} rewards since ${new Date(sinceMs).toISOString()}. There are more: export again since ${new Date(next.atMs).toISOString()}.`
    : `All ${shown.length} rewards since ${new Date(sinceMs).toISOString()}.`;
  const lines = [
    header,
    '',
    '    time | sign | giver | receiver | post | comment',
    ...shown.map(
      (reward) =>
        `    ${new Date(reward.atMs).toISOString()} | ${signText(reward.sign)} | ${reward.giver} | ${reward.receiver} | ${reward.postId} | ${reward.commentId}`
    ),
  ];
  return {
    text: lines.join('\n'),
    shown: shown.length,
    truncated: next !== undefined,
  };
}

/** Where the last import stands, kept between the hops of the import job. */
export type ImportStatus = {
  source: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  rows: number;
  total: number;
  /** When the state last changed or a hop last finished. */
  atMs: number;
  error?: string;
};

/** A running import that has not advanced for this long has stopped without saying so. */
export const IMPORT_STALLED_MS = 3 * 60 * 1000;

export function importStatusText(
  status: ImportStatus | undefined,
  nowMs: number
): string {
  if (!status) return 'No import has run on this install.';
  const progress = `${status.rows} of ${status.total} rows from ${status.source}`;
  const at = `${day(status.atMs)} UTC`;
  switch (status.state) {
    case 'done':
      return `Last import: finished, ${progress}, at ${at}.`;
    case 'failed':
      return `Last import: FAILED at ${progress}, at ${at}: ${status.error ?? 'unknown error'}. Start it again with the same source to resume.`;
    case 'stopped':
      return `Last import: stopped at ${progress}, at ${at}, because Enabled was turned on. Turn it off and start again to resume.`;
    case 'running':
      return nowMs - status.atMs > IMPORT_STALLED_MS
        ? `Last import: STALLED at ${progress}; no progress since ${at}. Start it again with the same source to resume.`
        : `An import is running: ${progress}, last progress at ${at}. Starting again restarts the job from where it is.`;
  }
}

export function importForm(defaultPage: string, status: string): Form {
  return {
    title: 'Import karma data',
    description: `${status} An import loads the snapshot bundled in this version, or a delta from a wiki page, in the background. It overwrites the karma of every user in the file with the file's value.`,
    acceptLabel: 'Start import',
    fields: [
      {
        type: 'select',
        name: 'source',
        label: 'Source',
        defaultValue: ['bundled'],
        options: [
          { label: 'Bundled snapshot', value: 'bundled' },
          { label: 'Wiki page (delta)', value: 'wiki' },
        ],
      },
      {
        type: 'string',
        name: 'page',
        label: 'Wiki page name, for a delta',
        defaultValue: defaultPage,
      },
      {
        type: 'boolean',
        name: 'again',
        label:
          'Run it again even if this source already finished (overwrites karma given since)',
        defaultValue: false,
      },
    ],
  };
}

/** Reads a select value, which arrives as a one-element array. */
export function selected(
  values: Record<string, unknown>,
  name: string
): string {
  const value = values[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}
