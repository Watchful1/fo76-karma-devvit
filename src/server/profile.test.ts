import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editProfile, profileView } from './profile';
import { DAY, T0, testPorts } from './testing/ports';
import { seedProfile } from './testing/seed';
import type { Profile } from './types';

const BOB: Profile = {
  redditUsername: 'Bob',
  karma: 5,
  m76Karma: 2,
  gamertags: [{ platform: 'PC', username: 'bobby', userId: '1' }],
};

/** Bob's profile, and the values of his edit form as it was opened. */
async function setup() {
  const t = testPorts();
  await seedProfile(t.redis, BOB);
  const view = await profileView(t.store, 'bob', true);
  assert.ok(view.showForm);
  const values: Record<string, unknown> = Object.fromEntries(
    (
      view.showForm.form.fields as { name: string; defaultValue?: unknown }[]
    ).map((field) => [field.name, field.defaultValue])
  );
  return {
    ...t,
    values,
    edit: (changes: Record<string, unknown>) =>
      editProfile(t.ports, 'Mod', { ...values, ...changes }),
  };
}

test('a moderator edit saves the profile, rebuilds the flair and logs who changed what', async () => {
  const s = await setup();

  const text = await s.edit({ karma: 50, m76Karma: 3, XBOX: 'bx' });

  assert.equal(text, 'Saved u/Bob: karma 50, Market76 3.');
  assert.deepEqual(await s.store.loadProfile('Bob'), {
    ...BOB,
    karma: 50,
    m76Karma: 3,
    gamertags: [
      { platform: 'XBOX', username: 'bx', userId: '0' },
      { platform: 'PC', username: 'bobby', userId: '1' },
    ],
  });
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Bob', text: ':xbox: :pc: Karma: 53', templateId: 't50' },
  ]);
  assert.deepEqual(s.log, [
    'u/Mod edited u/Bob: karma 5 to 50, Market76 2 to 3',
  ]);
});

test('a reward that lands while the edit form is open survives the save', async () => {
  const s = await setup();
  await s.store.recordReward(
    {
      commentId: 't1_c1',
      postId: 't3_p1',
      giver: 'Alice',
      receiver: 'Bob',
      sign: 1,
      atMs: T0,
    },
    { enforceLimits: true, dayKey: DAY, dailyCap: s.config.dailyCap }
  );

  // The form still says 5; the moderator adds 10 to that.
  const text = await s.edit({ karma: 15 });

  assert.equal((await s.store.loadProfile('Bob')).karma, 16);
  assert.match(text, /karma 16/);
});

test('an edit form with a bad value saves nothing', async () => {
  const s = await setup();
  assert.match(await s.edit({ karma: 'lots' }), /whole number/);
  assert.match(
    await s.edit({ username: 'not a name' }),
    /not a Reddit username/
  );
  assert.deepEqual(await s.store.loadProfile('Bob'), BOB);
  assert.equal(s.reddit.flairs.length, 0);
});

test('deleting a profile removes it, clears the flair and names the placeholder', async () => {
  const s = await setup();

  const text = await s.edit({ deleteProfile: true });

  assert.match(
    text,
    /^Deleted the karma profile and history of u\/Bob\. Other users' histories now show \[deleted-[0-9a-f]{8}\]\.$/
  );
  assert.equal((await s.store.loadProfile('Bob')).gamertags.length, 0);
  assert.deepEqual(s.reddit.clearedFlairs, ['Bob']);
  assert.match(
    s.log[0] ?? '',
    /^u\/Mod deleted a karma profile; its name is now \[deleted-/
  );
  assert.doesNotMatch(s.log[0] ?? '', /Bob/, 'the log does not keep the name');
});

test('a flair that cannot be cleared or set is reported in the toast', async () => {
  const s = await setup();
  s.reddit.failNext('setUserFlair', new Error('flair down'));
  assert.match(
    await s.edit({ karma: 6 }),
    /The flair could not be set: Error: flair down$/
  );

  s.reddit.failNext('clearUserFlair', new Error('flair down'));
  assert.match(
    await s.edit({ deleteProfile: true }),
    /The flair could not be cleared: Error: flair down$/
  );
});
