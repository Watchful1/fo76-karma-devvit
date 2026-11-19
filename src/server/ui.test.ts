import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeReddit } from './testing/fake-reddit';
import type { ImportedReward, Profile } from './types';
import {
  cleanUsername,
  exportForm,
  exportText,
  importForm,
  KARMA_LIMIT,
  lookupForm,
  moderatorOnly,
  profileForm,
  profileFromForm,
  selected,
  toast,
  wikiPageUrl,
} from './ui';

const AT = Date.UTC(2027, 0, 15, 8, 30);

type Field = {
  name: string;
  disabled?: boolean;
  defaultValue?: unknown;
  options?: { value: string }[];
};

function fieldMap(form: { fields: unknown }): Map<string, Field> {
  return new Map((form.fields as Field[]).map((field) => [field.name, field]));
}

const fullProfile: Profile = {
  redditUsername: 'Bob',
  karma: -7,
  m76Karma: 40,
  gamertags: [
    { platform: 'XBOX', username: 'bob_x', userId: '11' },
    { platform: 'PlayStation', username: 'bob_ps', userId: '22' },
    { platform: 'PC', username: 'bob_pc', userId: '33' },
  ],
};

test('moderatorOnly runs the action for a moderator and refuses anyone else', async () => {
  const reddit = new FakeReddit();
  reddit.moderators = new Set(['mod']);
  const ran: string[] = [];
  const action = async (moderator: string) => {
    ran.push(moderator);
    return toast('done');
  };

  reddit.currentUser = 'Mod';
  assert.deepEqual(await moderatorOnly(reddit, action), toast('done'));
  for (const user of ['Someone', undefined]) {
    reddit.currentUser = user;
    assert.deepEqual(
      await moderatorOnly(reddit, action),
      toast('Only moderators can use this.')
    );
  }
  assert.deepEqual(ran, ['Mod']);
});

test('toast cuts the text to 250 characters', () => {
  assert.equal(toast('x'.repeat(300)).showToast, 'x'.repeat(250));
});

test('cleanUsername strips u/, /u/ and surrounding spaces', () => {
  for (const raw of ['Name', 'u/Name', '/u/Name', 'U/Name', '  /u/Name '])
    assert.equal(cleanUsername(raw), 'Name', raw);
  assert.equal(cleanUsername('a_b-c'), 'a_b-c');
});

test('cleanUsername refuses what cannot be a username', () => {
  for (const raw of [
    '',
    '   ',
    'ab',
    'u/ab',
    'u/',
    'a'.repeat(21),
    'two words',
    'na.me',
    'na/me',
    'name!',
  ])
    assert.equal(cleanUsername(raw), undefined, raw);
  assert.equal(cleanUsername('abc'), 'abc');
  assert.equal(cleanUsername('a'.repeat(20)), 'a'.repeat(20));
});

test('the read-only profile shows the profile as text, with no fields', () => {
  const form = profileForm(
    { ...fullProfile, gamertags: fullProfile.gamertags.slice(2) },
    false
  );
  assert.equal(form.title, 'Karma profile of u/Bob');
  assert.deepEqual(form.fields, []);
  assert.equal(
    form.description,
    [
      'r/Fallout76Marketplace karma: -7',
      'r/Market76 karma: 40',
      'XBOX gamertag: none',
      'PlayStation gamertag: none',
      'PC gamertag: bob_pc',
    ].join('\n')
  );
});

test('the edit form, submitted unchanged, reads back as the same profile', () => {
  const form = profileForm(fullProfile, true);
  assert.equal(form.title, 'Edit karma profile of u/Bob');
  const fields = fieldMap(form);
  const values = Object.fromEntries(
    [...fields].map(([name, field]) => [name, field.defaultValue])
  );
  assert.deepEqual(profileFromForm(values, 'Bob'), {
    kind: 'save',
    profile: fullProfile,
    openedKarma: -7,
  });
  assert.equal(fields.get('deleteProfile')?.defaultValue, false);
  assert.deepEqual(
    [...fields.values()]
      .filter((field) => field.disabled === true)
      .map((field) => field.name),
    ['username', 'openedKarma']
  );
});

test('the edit form shows empty strings for a platform with no gamertag', () => {
  const fields = fieldMap(profileForm({ ...fullProfile, gamertags: [] }, true));
  assert.equal(fields.get('XBOX')?.defaultValue, '');
  assert.equal(fields.get('XBOXId')?.defaultValue, '');
});

function saved(result: ReturnType<typeof profileFromForm>) {
  assert.equal(result.kind, 'save', JSON.stringify(result));
  return result.kind === 'save' ? result : assert.fail('not a save');
}

test('only deleteProfile: true deletes, whatever else is in the form', () => {
  assert.deepEqual(
    profileFromForm(
      { deleteProfile: true, karma: 'abc', m76Karma: 5, PC: 'x' },
      'Bob'
    ),
    { kind: 'delete' }
  );
  for (const flag of [false, undefined, 'true', 1]) {
    const result = profileFromForm(
      { deleteProfile: flag, karma: 1, m76Karma: 0 },
      'Bob'
    );
    assert.equal(result.kind, 'save', String(flag));
  }
});

test('an all-zero form with no gamertags is a normal save, not a deletion', () => {
  const result = saved(
    profileFromForm(
      { karma: 0, m76Karma: 0, XBOX: '  ', PlayStation: '', PC: '' },
      'Bob'
    )
  );
  assert.deepEqual(result.profile, {
    redditUsername: 'Bob',
    karma: 0,
    m76Karma: 0,
    gamertags: [],
  });
});

test('gamertags are built only for platforms with a name, trimmed, with a missing or blank id as "0"', () => {
  const result = saved(
    profileFromForm(
      {
        karma: 3,
        m76Karma: 0,
        XBOX: ' xb ',
        XBOXId: ' 9 ',
        PlayStation: '   ',
        PlayStationId: '5',
        PC: 'pc1',
        PCId: '  ',
      },
      'Bob'
    )
  );
  assert.deepEqual(result.profile.gamertags, [
    { platform: 'XBOX', username: 'xb', userId: '9' },
    { platform: 'PC', username: 'pc1', userId: '0' },
  ]);
});

test('karma and Market76 karma must be present whole numbers', () => {
  for (const bad of [
    'abc',
    Infinity,
    NaN,
    1.5,
    '1.5',
    1e21,
    '',
    '  ',
    undefined,
    null,
    {},
    true,
  ]) {
    for (const values of [
      { karma: bad, m76Karma: 0 },
      { karma: 0, m76Karma: bad },
    ]) {
      const result = profileFromForm(values, 'Bob');
      assert.equal(result.kind, 'invalid', JSON.stringify(values));
      assert.match(
        result.kind === 'invalid' ? result.problem : '',
        /whole number/
      );
    }
  }
});

test('karma is limited to plus or minus a million, the boundary included', () => {
  for (const field of ['karma', 'm76Karma']) {
    const other = field === 'karma' ? 'm76Karma' : 'karma';
    const kind = (value: number) =>
      profileFromForm({ [field]: value, [other]: 0 }, 'Bob').kind;
    assert.equal(kind(KARMA_LIMIT), 'save', field);
    assert.equal(kind(-KARMA_LIMIT), 'save', field);
    assert.equal(kind(KARMA_LIMIT + 1), 'invalid', field);
    assert.equal(kind(-KARMA_LIMIT - 1), 'invalid', field);
  }
});

test('number-like strings are accepted and negative numbers kept', () => {
  const result = saved(
    profileFromForm({ karma: '12', m76Karma: ' -3 ' }, 'Bob')
  );
  assert.equal(result.profile.karma, 12);
  assert.equal(result.profile.m76Karma, -3);
});

test('a gamertag or id of 65 characters is invalid, 64 is fine', () => {
  const long = 'x'.repeat(65);
  const ok = 'x'.repeat(64);
  const kind = (tags: Record<string, string>) =>
    profileFromForm({ karma: 0, m76Karma: 0, ...tags }, 'Bob').kind;
  assert.equal(kind({ PC: long }), 'invalid');
  assert.equal(kind({ PC: 'a', PCId: long }), 'invalid');
  assert.equal(kind({ XBOX: long }), 'invalid');
  assert.equal(kind({ PlayStation: long }), 'invalid');
  assert.equal(kind({ PC: ok, PCId: ok }), 'save');
});

test('openedKarma is read from its string, and is undefined when absent or junk', () => {
  const opened = (openedKarma?: string) =>
    saved(
      profileFromForm(
        {
          karma: 5,
          m76Karma: 0,
          ...(openedKarma === undefined ? {} : { openedKarma }),
        },
        'Bob'
      )
    ).openedKarma;
  assert.equal(opened('5'), 5);
  assert.equal(opened('-12'), -12);
  assert.equal(opened(), undefined);
  assert.equal(opened('junk'), undefined);
  assert.equal(opened(''), undefined);
});

const exported = (i: number, sign: 1 | -1 | 0 = 1): ImportedReward => ({
  commentId: `t1_c${i}`,
  postId: `t3_p${i}`,
  giver: `giver${i}`,
  receiver: `recv${i}`,
  sign,
  atMs: AT + i * 1000,
});

test('exportText for a complete export is a header and a table indented four spaces', () => {
  const out = exportText([exported(1), exported(2)], AT, 2);
  assert.equal(out.shown, 2);
  assert.equal(out.truncated, false, 'exactly at the limit');
  assert.deepEqual(out.text.split('\n'), [
    `All 2 rewards since ${new Date(AT).toISOString()}.`,
    '',
    '    time | sign | giver | receiver | post | comment',
    `    ${new Date(AT + 1000).toISOString()} | +1 | giver1 | recv1 | t3_p1 | t1_c1`,
    `    ${new Date(AT + 2000).toISOString()} | +1 | giver2 | recv2 | t3_p2 | t1_c2`,
  ]);

  const none = exportText([], AT, 10);
  assert.equal(none.shown, 0);
  assert.match(none.text, /^All 0 rewards since /);
});

test('exportText for a truncated export names the first reward not shown', () => {
  const rewards = [1, 2, 3, 4, 5].map((i) => exported(i));
  const out = exportText(rewards, AT, 3);
  assert.equal(out.shown, 3);
  assert.equal(out.truncated, true);
  const lines = out.text.split('\n');
  assert.match(lines[0]!, /^The first 3 rewards since /);
  assert.ok(
    lines[0]!.includes(new Date(rewards[3]!.atMs).toISOString()),
    'names the time of the fourth reward'
  );
  assert.equal(lines.length, 3 + 3, 'exactly limit reward lines');
  assert.ok(out.text.includes('giver3'));
  assert.ok(!out.text.includes('giver4'));
});

test('exportText renders each sign, and ±1 for an imported reward', () => {
  const out = exportText(
    [exported(1, 1), exported(2, -1), exported(3, 0)],
    AT,
    10
  );
  const signs = out.text
    .split('\n')
    .slice(3)
    .map((line) => line.split(' | ')[1]);
  assert.deepEqual(signs, ['+1', '-1', '±1']);
});

test('the lookup, export and import forms have the fields their submit handlers read', () => {
  const lookup = fieldMap(lookupForm());
  assert.deepEqual([...lookup.keys()], ['username', 'action']);
  assert.deepEqual(lookup.get('action')?.defaultValue, ['profile']);
  assert.deepEqual(
    lookup.get('action')?.options?.map((option) => option.value),
    ['profile', 'edit']
  );

  const exporting = fieldMap(exportForm('2027-01-01'));
  assert.deepEqual([...exporting.keys()], ['since']);
  assert.equal(exporting.get('since')?.defaultValue, '2027-01-01');

  const form = importForm('wiki/page', 'STATUS LINE.');
  assert.match(form.description ?? '', /^STATUS LINE\. /);
  const importing = fieldMap(form);
  assert.deepEqual([...importing.keys()], ['source', 'page', 'again']);
  assert.deepEqual(
    importing.get('source')?.options?.map((option) => option.value),
    ['bundled', 'wiki']
  );
  assert.equal(importing.get('page')?.defaultValue, 'wiki/page');
});

test('wikiPageUrl keeps the slashes of a nested page', () => {
  assert.equal(
    wikiPageUrl('testsub', 'karma-export/20261115-0341'),
    'https://old.reddit.com/r/testsub/wiki/karma-export/20261115-0341'
  );
});

test('selected reads a one-element array, a plain string and a missing value', () => {
  assert.equal(selected({ a: ['x'] }, 'a'), 'x');
  assert.equal(selected({ a: ['x', 'z'] }, 'a'), 'x');
  assert.equal(selected({ a: 'y' }, 'a'), 'y');
  assert.equal(selected({ a: [] }, 'a'), '');
  assert.equal(selected({ a: [5] }, 'a'), '');
  assert.equal(selected({ a: 5 }, 'a'), '');
  assert.equal(selected({}, 'a'), '');
});
