import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImportedReward, Profile } from './types';
import {
  cleanUsername,
  exportForm,
  exportText,
  IMPORT_STALLED_MS,
  importForm,
  importStatusText,
  KARMA_LIMIT,
  lookupForm,
  profileForm,
  profileText,
  profileFromForm,
  selected,
  wikiPageUrl,
  type ImportStatus,
} from './ui';

const AT = Date.UTC(2027, 0, 15, 8, 30);

type Field = {
  name: string;
  type: string;
  disabled?: boolean;
  defaultValue?: unknown;
  helpText?: string;
  options?: { label: string; value: string }[];
};

function fieldsOf(form: { fields: unknown }): Field[] {
  return form.fields as Field[];
}

function fieldMap(form: { fields: unknown }): Map<string, Field> {
  return new Map(fieldsOf(form).map((field) => [field.name, field]));
}

const profile: Profile = {
  redditUsername: 'Bob',
  karma: 12,
  m76Karma: 5,
  gamertags: [{ platform: 'PC', username: 'bobby', userId: '77' }],
};

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

// ------------------------------------------------------------ cleanUsername

test('cleanUsername strips u/ and /u/ and surrounding spaces', () => {
  assert.equal(cleanUsername('Name'), 'Name');
  assert.equal(cleanUsername('u/Name'), 'Name');
  assert.equal(cleanUsername('/u/Name'), 'Name');
  assert.equal(cleanUsername('U/Name'), 'Name');
  assert.equal(cleanUsername('  Name  '), 'Name');
  assert.equal(cleanUsername('  /u/Name '), 'Name');
  assert.equal(cleanUsername('a_b-c'), 'a_b-c');
});

test('cleanUsername refuses what cannot be a username', () => {
  assert.equal(cleanUsername(''), undefined);
  assert.equal(cleanUsername('   '), undefined);
  assert.equal(cleanUsername('ab'), undefined);
  assert.equal(cleanUsername('u/ab'), undefined);
  assert.equal(cleanUsername('a'.repeat(21)), undefined);
  assert.equal(cleanUsername('a'.repeat(20)), 'a'.repeat(20));
  assert.equal(cleanUsername('abc'), 'abc');
  assert.equal(cleanUsername('two words'), undefined);
  assert.equal(cleanUsername('na.me'), undefined);
  assert.equal(cleanUsername('na/me'), undefined);
  assert.equal(cleanUsername('name!'), undefined);
  assert.equal(cleanUsername('u/'), undefined);
});

// ------------------------------------------------------------ profileForm

test('the editable form pre-fills every field through defaultValue', () => {
  const form = profileForm(fullProfile, true);
  const byName = fieldMap(form);
  assert.equal(byName.get('username')?.defaultValue, 'Bob');
  assert.equal(byName.get('karma')?.type, 'number');
  assert.equal(byName.get('karma')?.defaultValue, -7);
  assert.equal(byName.get('m76Karma')?.type, 'number');
  assert.equal(byName.get('m76Karma')?.defaultValue, 40);
  assert.equal(byName.get('XBOX')?.defaultValue, 'bob_x');
  assert.equal(byName.get('XBOXId')?.defaultValue, '11');
  assert.equal(byName.get('PlayStation')?.defaultValue, 'bob_ps');
  assert.equal(byName.get('PlayStationId')?.defaultValue, '22');
  assert.equal(byName.get('PC')?.defaultValue, 'bob_pc');
  assert.equal(byName.get('PCId')?.defaultValue, '33');
  assert.equal(byName.get('openedKarma')?.defaultValue, '-7');
  assert.equal(byName.get('openedKarma')?.type, 'string');
  assert.equal(byName.get('openedKarma')?.disabled, true);
  assert.equal(byName.get('deleteProfile')?.type, 'boolean');
  assert.equal(byName.get('deleteProfile')?.defaultValue, false);
});

test('the editable form shows empty strings for a platform with no gamertag', () => {
  const byName = fieldMap(profileForm(profile, true));
  assert.equal(byName.get('XBOX')?.defaultValue, '');
  assert.equal(byName.get('XBOXId')?.defaultValue, '');
  assert.equal(byName.get('PC')?.defaultValue, 'bobby');
  assert.equal(byName.get('PCId')?.defaultValue, '77');
});

test('the editable form leaves only the username and the karma-at-open disabled', () => {
  const disabled = fieldsOf(profileForm(profile, true))
    .filter((field) => field.disabled === true)
    .map((field) => field.name);
  assert.deepEqual(disabled, ['username', 'openedKarma']);
});

test('the read-only form shows the profile as text, with no fields', () => {
  const form = profileForm(fullProfile, false);
  assert.equal(form.title, 'Karma profile of u/Bob');
  assert.deepEqual(form.fields, []);
  assert.equal(
    form.description,
    [
      'r/Fallout76Marketplace karma: -7',
      'r/Market76 karma: 40',
      'XBOX gamertag: bob_x',
      'PlayStation gamertag: bob_ps',
      'PC gamertag: bob_pc',
    ].join('\n')
  );
});

test('the read-only text says none for a platform with no gamertag', () => {
  assert.match(profileText(profile), /XBOX gamertag: none/);
  assert.match(profileText(profile), /PC gamertag: bobby/);
});

test('the editable form has number fields for karma and enabled gamertags', () => {
  const byName = fieldMap(profileForm(profile, true));
  assert.equal(byName.get('karma')?.type, 'number');
  assert.equal(byName.get('m76Karma')?.type, 'number');
  assert.equal(byName.get('username')?.disabled, true);
  assert.equal(byName.get('PC')?.disabled, false);
  assert.ok(byName.has('PCId'));
});

test('the form title and button say whether it edits', () => {
  const editable = profileForm(profile, true);
  const readOnly = profileForm(profile, false);
  assert.match(editable.title ?? '', /Edit/);
  assert.equal(editable.acceptLabel, 'Save');
  assert.doesNotMatch(readOnly.title ?? '', /Edit/);
  assert.equal(readOnly.acceptLabel, 'Close');
});

// ------------------------------------------------------------ profileFromForm

function saved(result: ReturnType<typeof profileFromForm>) {
  assert.equal(result.kind, 'save', JSON.stringify(result));
  return result.kind === 'save' ? result : assert.fail('not a save');
}

test('deleteProfile: true deletes whatever else is in the form', () => {
  assert.deepEqual(profileFromForm({ deleteProfile: true }, 'Bob'), {
    kind: 'delete',
  });
  assert.deepEqual(
    profileFromForm(
      { deleteProfile: true, karma: 'abc', m76Karma: 5, PC: 'x' },
      'Bob'
    ),
    { kind: 'delete' }
  );
  assert.deepEqual(
    profileFromForm({ deleteProfile: true, karma: 50, m76Karma: 1 }, 'Bob'),
    { kind: 'delete' }
  );
});

test('only the boolean true deletes', () => {
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

test('karma-only, Market76-only and gamertag-only forms each save', () => {
  assert.equal(
    saved(profileFromForm({ karma: 3, m76Karma: 0 }, 'Bob')).profile.karma,
    3
  );
  assert.equal(
    saved(profileFromForm({ karma: 0, m76Karma: 4 }, 'Bob')).profile.m76Karma,
    4
  );
  assert.equal(
    saved(profileFromForm({ karma: 0, m76Karma: 0, PC: 'x' }, 'Bob')).profile
      .gamertags.length,
    1
  );
});

test('gamertags are built only for platforms with a name, trimmed, with a missing id as "0"', () => {
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
      },
      'Bob'
    )
  );
  assert.deepEqual(result.profile, {
    redditUsername: 'Bob',
    karma: 3,
    m76Karma: 0,
    gamertags: [
      { platform: 'XBOX', username: 'xb', userId: '9' },
      { platform: 'PC', username: 'pc1', userId: '0' },
    ],
  });
});

test('a gamertag with an empty or blank id gets "0"', () => {
  const result = saved(
    profileFromForm(
      { karma: 0, m76Karma: 0, PC: 'x', PCId: '  ', XBOX: 'y', XBOXId: '' },
      'Bob'
    )
  );
  assert.deepEqual(
    result.profile.gamertags.map((tag) => tag.userId),
    ['0', '0']
  );
});

test('karma and Market76 karma must be whole numbers', () => {
  for (const bad of [
    'abc',
    Infinity,
    -Infinity,
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
    assert.equal(
      profileFromForm({ karma: bad, m76Karma: 0 }, 'Bob').kind,
      'invalid',
      `karma ${String(bad)}`
    );
    assert.equal(
      profileFromForm({ karma: 0, m76Karma: bad }, 'Bob').kind,
      'invalid',
      `m76Karma ${String(bad)}`
    );
  }
});

test('a missing karma or Market76 karma is invalid', () => {
  assert.equal(profileFromForm({}, 'Bob').kind, 'invalid');
  assert.equal(profileFromForm({ karma: 1 }, 'Bob').kind, 'invalid');
  assert.equal(profileFromForm({ m76Karma: 1 }, 'Bob').kind, 'invalid');
});

test('karma is limited to plus or minus a million, the boundary included', () => {
  assert.equal(KARMA_LIMIT, 1_000_000);
  for (const field of ['karma', 'm76Karma']) {
    const other = field === 'karma' ? 'm76Karma' : 'karma';
    const form = (value: number) => ({ [field]: value, [other]: 0 });
    assert.equal(profileFromForm(form(1_000_000), 'Bob').kind, 'save', field);
    assert.equal(profileFromForm(form(-1_000_000), 'Bob').kind, 'save', field);
    assert.equal(
      profileFromForm(form(1_000_001), 'Bob').kind,
      'invalid',
      field
    );
    assert.equal(
      profileFromForm(form(-1_000_001), 'Bob').kind,
      'invalid',
      field
    );
  }
});

test('the invalid problem says what is wrong', () => {
  const result = profileFromForm({ karma: 'abc', m76Karma: 0 }, 'Bob');
  assert.equal(
    result.kind === 'invalid' && /whole number/.test(result.problem),
    true
  );
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
  assert.equal(
    profileFromForm({ karma: 0, m76Karma: 0, PC: long }, 'Bob').kind,
    'invalid'
  );
  assert.equal(
    profileFromForm({ karma: 0, m76Karma: 0, PC: 'a', PCId: long }, 'Bob').kind,
    'invalid'
  );
  assert.equal(
    profileFromForm({ karma: 0, m76Karma: 0, XBOX: long }, 'Bob').kind,
    'invalid'
  );
  assert.equal(
    profileFromForm({ karma: 0, m76Karma: 0, PlayStation: long }, 'Bob').kind,
    'invalid'
  );
  assert.equal(
    profileFromForm({ karma: 0, m76Karma: 0, PC: ok, PCId: ok }, 'Bob').kind,
    'save'
  );
});

test('openedKarma is read from its string, and is undefined when absent or junk', () => {
  const form = { karma: 5, m76Karma: 0 };
  assert.equal(
    saved(profileFromForm({ ...form, openedKarma: '5' }, 'Bob')).openedKarma,
    5
  );
  assert.equal(
    saved(profileFromForm({ ...form, openedKarma: '-12' }, 'Bob')).openedKarma,
    -12
  );
  assert.equal(saved(profileFromForm(form, 'Bob')).openedKarma, undefined);
  assert.equal(
    saved(profileFromForm({ ...form, openedKarma: 'junk' }, 'Bob')).openedKarma,
    undefined
  );
  assert.equal(
    saved(profileFromForm({ ...form, openedKarma: '' }, 'Bob')).openedKarma,
    undefined
  );
});

// ------------------------------------------------------------ exportText

const exported = (i: number, sign: 1 | -1 | 0 = 1): ImportedReward => ({
  commentId: `t1_c${i}`,
  postId: `t3_p${i}`,
  giver: `giver${i}`,
  receiver: `recv${i}`,
  sign,
  atMs: AT + i * 1000,
});

test('exportText for a complete export', () => {
  const rewards = [exported(1), exported(2), exported(3)];
  const out = exportText(rewards, AT, 10);
  assert.equal(out.shown, 3);
  assert.equal(out.truncated, false);
  const lines = out.text.split('\n');
  assert.equal(lines[0], `All 3 rewards since ${new Date(AT).toISOString()}.`);
  assert.equal(lines[1], '');
  assert.equal(lines[2], '    time | sign | giver | receiver | post | comment');
  assert.equal(lines.length, 3 + 3);
  assert.equal(
    lines[3],
    `    ${new Date(AT + 1000).toISOString()} | +1 | giver1 | recv1 | t3_p1 | t1_c1`
  );
});

test('exportText for a complete export exactly at the limit is not truncated', () => {
  const out = exportText([exported(1), exported(2)], AT, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.shown, 2);
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
  assert.ok(!out.text.includes('giver4'));
  assert.ok(!out.text.includes('giver5'));
  assert.ok(out.text.includes('giver3'));
});

test('exportText renders each sign, and ±1 for an imported reward', () => {
  const out = exportText(
    [exported(1, 1), exported(2, -1), exported(3, 0)],
    AT,
    10
  );
  const lines = out.text.split('\n').slice(3);
  assert.match(lines[0]!, / \| \+1 \| /);
  assert.match(lines[1]!, / \| -1 \| /);
  assert.match(lines[2]!, / \| ±1 \| /);
  assert.ok(!lines[2]!.includes(' | -1 | '));
});

test('every table line of an export is indented four spaces', () => {
  const out = exportText(
    [1, 2, 3].map((i) => exported(i)),
    AT,
    10
  );
  const table = out.text.split('\n').slice(2);
  assert.equal(table.length, 4);
  for (const line of table) assert.ok(line.startsWith('    '), line);
  assert.ok(!table.some((line) => line.startsWith('     ')));
});

test('exportText of nothing is a header and the column line', () => {
  const out = exportText([], AT, 10);
  assert.equal(out.shown, 0);
  assert.equal(out.truncated, false);
  assert.match(out.text, /^All 0 rewards since /);
});

// ------------------------------------------------------------ import status and forms

const NOW = Date.UTC(2027, 0, 15, 12, 0);

function status(overrides: Partial<ImportStatus> = {}): ImportStatus {
  return {
    source: 'bundled',
    state: 'running',
    rows: 1000,
    total: 5000,
    atMs: NOW - 60_000,
    ...overrides,
  };
}

test('importStatusText with no import', () => {
  assert.equal(
    importStatusText(undefined, NOW),
    'No import has run on this install.'
  );
});

test('importStatusText for a running import that is advancing', () => {
  const text = importStatusText(status(), NOW);
  assert.match(text, /An import is running/);
  assert.match(text, /1000 of 5000 rows from bundled/);
  assert.doesNotMatch(text, /STALLED/);
});

test('importStatusText says STALLED once a running import is older than three minutes', () => {
  assert.equal(IMPORT_STALLED_MS, 180_000);
  assert.doesNotMatch(
    importStatusText(status({ atMs: NOW - IMPORT_STALLED_MS }), NOW),
    /STALLED/
  );
  const stalled = importStatusText(
    status({ atMs: NOW - IMPORT_STALLED_MS - 1 }),
    NOW
  );
  assert.match(stalled, /STALLED/);
  assert.match(stalled, /1000 of 5000 rows/);
});

test('importStatusText for done, failed and stopped', () => {
  const old = NOW - 10 * IMPORT_STALLED_MS;
  const done = importStatusText(
    status({ state: 'done', rows: 5000, atMs: old }),
    NOW
  );
  assert.match(done, /finished/);
  assert.match(done, /5000 of 5000/);
  assert.doesNotMatch(done, /STALLED/);

  const failed = importStatusText(
    status({ state: 'failed', error: 'store down', atMs: old }),
    NOW
  );
  assert.match(failed, /FAILED/);
  assert.match(failed, /store down/);
  assert.doesNotMatch(failed, /STALLED/);

  const stopped = importStatusText(
    status({ state: 'stopped', atMs: old }),
    NOW
  );
  assert.match(stopped, /stopped/);
  assert.match(stopped, /Enabled/);
  assert.doesNotMatch(stopped, /STALLED/);
});

test('importForm puts the status in the description and has source, page and again', () => {
  const form = importForm('wiki/page', 'STATUS LINE.');
  assert.match(form.description ?? '', /^STATUS LINE\. /);
  const byName = fieldMap(form);
  assert.deepEqual([...byName.keys()], ['source', 'page', 'again']);
  assert.deepEqual(byName.get('source')?.defaultValue, ['bundled']);
  assert.deepEqual(
    byName.get('source')?.options?.map((option) => option.value),
    ['bundled', 'wiki']
  );
  assert.equal(byName.get('page')?.defaultValue, 'wiki/page');
  assert.equal(byName.get('again')?.type, 'boolean');
  assert.equal(byName.get('again')?.defaultValue, false);
});

// ------------------------------------------------------------ lookup and export forms

test('lookupForm asks for a username and opens the profile by default', () => {
  const byName = fieldMap(lookupForm());
  assert.deepEqual([...byName.keys()], ['username', 'action']);
  assert.equal(byName.get('username')?.defaultValue, undefined);
  assert.deepEqual(byName.get('action')?.defaultValue, ['profile']);
  assert.deepEqual(
    byName.get('action')?.options?.map((option) => option.value),
    ['profile', 'edit']
  );
});

test('wikiPageUrl keeps the slashes of a nested page', () => {
  assert.equal(
    wikiPageUrl('fo76_karma_dev_dev', 'karma-export/20261115-0341'),
    'https://old.reddit.com/r/fo76_karma_dev_dev/wiki/karma-export/20261115-0341'
  );
});

test('exportForm pre-fills the since field', () => {
  const form = exportForm('2027-01-01');
  const byName = fieldMap(form);
  assert.deepEqual([...byName.keys()], ['since']);
  assert.equal(byName.get('since')?.defaultValue, '2027-01-01');
  assert.equal(form.acceptLabel, 'Export');
});

// ------------------------------------------------------------ selected

test('selected reads a one-element array, a plain string and a missing value', () => {
  assert.equal(selected({ a: ['x'] }, 'a'), 'x');
  assert.equal(selected({ a: ['x', 'z'] }, 'a'), 'x');
  assert.equal(selected({ a: 'y' }, 'a'), 'y');
  assert.equal(selected({ a: [] }, 'a'), '');
  assert.equal(selected({ a: [5] }, 'a'), '');
  assert.equal(selected({ a: 5 }, 'a'), '');
  assert.equal(selected({}, 'a'), '');
});
