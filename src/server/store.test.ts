import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from './store';
import { FakeRedis } from './testing/fake-redis';
import {
  emptyProfile,
  type HistoryEntry,
  type ImportedReward,
  type Profile,
  type Reward,
} from './types';

const T0 = 1_800_000_000_000;
const DAY = '2027-01-15';
const SECOND = 1000;
const HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR;

function setup() {
  const clock = { now: T0 };
  const redis = new FakeRedis(() => clock.now);
  const store = new Store(redis, () => clock.now);
  return { clock, redis, store };
}

function reward(overrides: Partial<Reward> = {}): Reward {
  return {
    commentId: 'c1',
    postId: 'p1',
    giver: 'Alice',
    receiver: 'Bob',
    sign: 1,
    atMs: T0,
    ...overrides,
  };
}

const enforce = { enforceLimits: true, dayKey: DAY, dailyCap: 10 };
const loose = { enforceLimits: false, dayKey: DAY, dailyCap: 10 };

const karmaOf = async (store: Store, name: string) =>
  (await store.loadProfile(name)).karma;

const commentIds = (entries: HistoryEntry[]) =>
  entries.map((entry) => ('commentId' in entry ? entry.commentId : '?'));

// ------------------------------------------------------------------ profiles

test('a profile saves and loads back, and an unknown user is empty', async () => {
  const { store } = setup();
  const profile: Profile = {
    redditUsername: 'Bob',
    karma: 12,
    m76Karma: 5,
    gamertags: [{ platform: 'PC', username: 'bobby', userId: '1' }],
  };
  await store.saveProfile(profile);
  assert.deepEqual(await store.loadProfile('bob'), profile);
  assert.deepEqual(await store.loadProfile('Nobody'), emptyProfile('Nobody'));
});

test('karma alone is enough to load a profile', async () => {
  const { store } = setup();
  await store.recordReward(reward(), enforce);
  assert.deepEqual(await store.loadProfile('Bob'), {
    ...emptyProfile('Bob'),
    karma: 1,
  });
});

test('saveDetails changes the gamertags and Market76 karma but not the karma', async () => {
  const { store } = setup();
  await store.saveProfile({ ...emptyProfile('Bob'), karma: 5 });
  await store.saveDetails({
    redditUsername: 'Bob',
    karma: 99,
    m76Karma: 3,
    gamertags: [{ platform: 'XBOX', username: 'b', userId: '2' }],
  });
  assert.deepEqual(await store.loadProfile('Bob'), {
    redditUsername: 'Bob',
    karma: 5,
    m76Karma: 3,
    gamertags: [{ platform: 'XBOX', username: 'b', userId: '2' }],
  });
});

test('addKarma adds to the current value and returns it', async () => {
  const { store } = setup();
  assert.equal(await store.addKarma('Bob', 3), 3);
  assert.equal(await store.addKarma('BOB', -1), 2);
  assert.equal(await karmaOf(store, 'Bob'), 2);
  await store.recordReward(reward(), enforce);
  assert.equal(await store.addKarma('Bob', 5), 8);
});

// ------------------------------------------------------------------ deleteProfile

test('deleting a profile removes it, its history and the pairs on both sides', async () => {
  const { store } = setup();
  await store.saveProfile({
    redditUsername: 'Bob',
    karma: 3,
    m76Karma: 40,
    gamertags: [{ platform: 'PC', username: 'bobby', userId: '1' }],
  });
  await store.recordReward(
    reward({ commentId: 'c1', giver: 'Alice', receiver: 'Bob' }),
    enforce
  );
  await store.recordReward(
    reward({ commentId: 'c2', postId: 'p2', giver: 'Bob', receiver: 'Carol' }),
    enforce
  );
  await store.recordReward(
    reward({ commentId: 'c3', giver: 'Alice', receiver: 'Carol' }),
    enforce
  );

  await store.deleteProfile('BOB');

  assert.deepEqual(
    await store.loadProfile('Bob'),
    emptyProfile('Bob'),
    'karma, Market76 karma and gamertags are gone'
  );
  assert.deepEqual(await store.history('Bob', { limit: 10 }), []);
  assert.equal(await store.earlierReward('p1', 'Alice', 'Bob'), undefined);
  assert.equal(await store.earlierReward('p2', 'Bob', 'Carol'), undefined);
  assert.equal(await store.recordedReward('c1'), undefined);
  assert.equal(await store.recordedReward('c2'), undefined);
  assert.equal(
    await store.earlierReward('p1', 'Alice', 'Carol'),
    'c3',
    'unrelated pairs stay'
  );
  assert.equal((await store.recordedReward('c3'))?.receiver, 'Carol');
  assert.equal(await karmaOf(store, 'Carol'), 2, "others' karma stays");
  assert.equal((await store.history('Alice', { limit: 10 })).length, 2);
  assert.equal((await store.history('Carol', { limit: 10 })).length, 2);
});

test('deleting a profile removes imported pairs where the user gave or received', async () => {
  const { store } = setup();
  const imported = (
    commentId: string,
    giver: string,
    receiver: string
  ): ImportedReward => ({
    commentId,
    postId: 'p1',
    giver,
    receiver,
    sign: 0,
    atMs: T0,
  });
  await store.importBatch({
    profiles: [],
    rewards: [
      imported('i1', 'Bob', 'Carol'),
      imported('i2', 'Dana', 'Bob'),
      imported('i3', 'Dana', 'Carol'),
    ],
  });
  await store.deleteProfile('Bob');
  assert.equal(await store.earlierReward('p1', 'Bob', 'Carol'), undefined);
  assert.equal(await store.earlierReward('p1', 'Dana', 'Bob'), undefined);
  assert.equal(await store.earlierReward('p1', 'Dana', 'Carol'), 'i3');
});

const PLACEHOLDER = /^\[deleted-[0-9a-f]{8}\]$/;

/** The names in a user's reward history, as `giver>receiver`, oldest first. */
async function trades(store: Store, name: string): Promise<string[]> {
  const entries = await store.history(name, { limit: 1000 });
  return entries
    .filter((entry) => entry.kind === 'reward')
    .map((entry) => `${entry.giver}>${entry.receiver}`)
    .reverse();
}

test('deleting a profile puts a placeholder for the name in partners histories and the event log', async () => {
  const { store } = setup();
  await store.recordReward(
    reward({ commentId: 'c1', giver: 'Alice', receiver: 'Bob', atMs: T0 }),
    enforce
  );
  await store.recordReward(
    reward({
      commentId: 'c2',
      postId: 'p2',
      giver: 'Bob',
      receiver: 'Carol',
      atMs: T0 + 1,
    }),
    enforce
  );
  await store.recordReward(
    reward({
      commentId: 'c3',
      giver: 'Alice',
      receiver: 'Carol',
      atMs: T0 + 2,
    }),
    enforce
  );

  const placeholder = await store.deleteProfile('BOB');

  assert.match(placeholder, PLACEHOLDER);
  assert.deepEqual(await trades(store, 'Alice'), [
    `Alice>${placeholder}`,
    'Alice>Carol',
  ]);
  assert.deepEqual(await trades(store, 'Carol'), [
    `${placeholder}>Carol`,
    'Alice>Carol',
  ]);
  const events = await store.eventsSince(0, 100);
  assert.deepEqual(
    events.map((event) => [
      event.commentId,
      event.giver,
      event.receiver,
      event.atMs,
    ]),
    [
      ['c1', 'Alice', placeholder, T0],
      ['c2', placeholder, 'Carol', T0 + 1],
      ['c3', 'Alice', 'Carol', T0 + 2],
    ],
    'the same events at the same times, with the name replaced'
  );
  assert.deepEqual(await store.history('Bob', { limit: 10 }), []);
  assert.deepEqual(
    await store.history(placeholder, { limit: 10 }),
    [],
    'the placeholder gets no history of its own'
  );
});

test('deleting a profile renames imported rewards too', async () => {
  const { store } = setup();
  await store.importBatch({
    profiles: [],
    rewards: [
      {
        commentId: 'i1',
        postId: 'p1',
        giver: 'Bob',
        receiver: 'Carol',
        sign: 0,
        atMs: T0,
      },
    ],
  });
  const placeholder = await store.deleteProfile('bob');
  assert.deepEqual(await trades(store, 'Carol'), [`${placeholder}>Carol`]);
  const [event] = await store.eventsSince(0, 10);
  assert.equal(event?.giver, placeholder);
  assert.equal(event?.sign, 0);
});

test('a deletion that failed half way finishes with the same placeholder and no duplicates', async () => {
  const { store, redis } = setup();
  await store.recordReward(reward({ commentId: 'c1' }), enforce);
  await store.recordReward(
    reward({ commentId: 'c2', postId: 'p2', giver: 'Bob', receiver: 'Alice' }),
    enforce
  );

  // Fail when the user's own history is removed, after the partners were renamed.
  const del = redis.del.bind(redis);
  let failed = false;
  redis.del = async (...keys: string[]) => {
    if (!failed) {
      failed = true;
      throw new Error('Redis is away');
    }
    return del(...keys);
  };
  await assert.rejects(store.deleteProfile('Bob'), /Redis is away/);
  const afterFailure = await trades(store, 'Alice');

  const placeholder = await store.deleteProfile('Bob');

  assert.deepEqual(await trades(store, 'Alice'), [
    `Alice>${placeholder}`,
    `${placeholder}>Alice`,
  ]);
  assert.deepEqual(
    afterFailure,
    await trades(store, 'Alice'),
    'the second run changed nothing in the partner history'
  );
  assert.equal((await store.eventsSince(0, 100)).length, 2);
  assert.deepEqual(await store.history('Bob', { limit: 10 }), []);
});

test('deleting two users who traded with each other leaves two placeholders and no stray history', async () => {
  const { store } = setup();
  await store.recordReward(reward({ commentId: 'c1' }), enforce);
  await store.recordReward(
    reward({ commentId: 'c2', postId: 'p2', giver: 'Bob', receiver: 'Bob' }),
    loose
  );

  const bob = await store.deleteProfile('Bob');
  const alice = await store.deleteProfile('Alice');

  assert.notEqual(bob, alice);
  const events = await store.eventsSince(0, 100);
  assert.deepEqual(
    events.map((event) => `${event.giver}>${event.receiver}`).sort(),
    [`${alice}>${bob}`, `${bob}>${bob}`].sort()
  );
  assert.deepEqual(await store.history(bob, { limit: 10 }), []);
  assert.deepEqual(await store.history(alice, { limit: 10 }), []);
});

test('a user with more partners than one group of writes is renamed everywhere', async () => {
  const { store } = setup();
  for (let i = 0; i < 60; i++) {
    await store.recordReward(
      reward({
        commentId: `c${i}`,
        postId: `p${i}`,
        giver: `Partner${i}`,
        receiver: 'Bob',
        atMs: T0 + i,
      }),
      loose
    );
  }
  const placeholder = await store.deleteProfile('Bob');
  for (const i of [0, 24, 25, 59]) {
    assert.deepEqual(await trades(store, `Partner${i}`), [
      `Partner${i}>${placeholder}`,
    ]);
    assert.equal(
      await store.earlierReward(`p${i}`, `Partner${i}`, 'Bob'),
      undefined
    );
  }
  assert.equal((await store.eventsSince(0, 100)).length, 60);
});

// ------------------------------------------------------------------ claim

test('claim: the first caller claims, the second is busy and finishing makes it done', async () => {
  const { store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  assert.equal(await store.claim('c9'), 'busy');
  await store.finish('c9');
  assert.equal(await store.claim('c9'), 'done');
});

test('claim: a pending attempt is busy for 45 seconds, then resumed once', async () => {
  const { clock, store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  clock.now += 44 * SECOND;
  assert.equal(await store.claim('c9'), 'busy');
  clock.now += 2 * SECOND;
  assert.equal(await store.claim('c9'), 'resumed');
  assert.equal(
    await store.claim('c9'),
    'busy',
    'the takeover started a new attempt'
  );
  clock.now += 46 * SECOND;
  assert.equal(await store.claim('c9'), 'resumed');
});

test('claim: takeOver resumes a fresh pending attempt', async () => {
  const { store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  assert.equal(await store.claim('c9', { takeOver: true }), 'resumed');
  assert.equal(await store.claim('c9'), 'busy');
  assert.equal(await store.claim('fresh', { takeOver: true }), 'claimed');
});

test('claim: a finished comment is done, with or without takeOver, and stays done', async () => {
  const { store } = setup();
  await store.claim('c9');
  await store.finish('c9');
  assert.equal(await store.claim('c9'), 'done');
  assert.equal(await store.claim('c9', { takeOver: true }), 'done');
  assert.equal(await store.claim('c9'), 'done');
});

test('claim: a finished comment is done even if finish comes without a claim', async () => {
  const { store } = setup();
  await store.finish('c9');
  assert.equal(await store.claim('c9'), 'done');
});

test('claim: expires after a year', async () => {
  const { clock, store } = setup();
  await store.claim('c9');
  await store.finish('c9');
  clock.now += 364 * DAY_MS;
  assert.equal(await store.claim('c9'), 'done');
  clock.now += 2 * DAY_MS;
  assert.equal(await store.claim('c9'), 'claimed');
});

test('claim: a pending claim also expires after a year', async () => {
  const { clock, store } = setup();
  await store.claim('c9');
  clock.now += 366 * DAY_MS;
  assert.equal(await store.claim('c9'), 'claimed');
});

// ------------------------------------------------------------------ recordReward

test('recording a reward changes karma, the day count, events and both histories', async () => {
  const { store } = setup();
  assert.equal(await store.givenToday('Alice', DAY), 0);
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });

  assert.equal(await karmaOf(store, 'bob'), 1);
  assert.equal(await store.givenToday('alice', DAY), 1);
  assert.equal(await store.earlierReward('p1', 'ALICE', 'bob'), 'c1');
  assert.deepEqual(await store.recordedReward('c1'), reward());
  assert.deepEqual(await store.eventsSince(0, 1000), [reward()]);
  const entry = {
    kind: 'reward',
    atMs: T0,
    commentId: 'c1',
    postId: 'p1',
    giver: 'Alice',
    receiver: 'Bob',
    sign: 1,
  };
  assert.deepEqual(await store.history('Alice', { limit: 5 }), [entry]);
  assert.deepEqual(await store.history('Bob', { limit: 5 }), [entry]);
});

test('a take lowers karma', async () => {
  const { store } = setup();
  await store.recordReward(reward({ sign: -1 }), enforce);
  assert.equal(await karmaOf(store, 'Bob'), -1);
});

test('the day count expires after two days', async () => {
  const { clock, store } = setup();
  await store.recordReward(reward(), enforce);
  clock.now += 47 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 1);
  clock.now += 2 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 0);
});

test('setGivenToday sets the count and it expires after two days', async () => {
  const { clock, store } = setup();
  await store.setGivenToday('Alice', DAY, 7);
  assert.equal(await store.givenToday('alice', DAY), 7);
  clock.now += 47 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 7);
  clock.now += 2 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 0);
});

test('a second reward for the same pair is refused with the first comment id', async () => {
  const { store } = setup();
  await store.recordReward(reward({ commentId: 'c1' }), enforce);
  const second = await store.recordReward(
    reward({ commentId: 'c2', atMs: T0 + 1 }),
    enforce
  );
  assert.deepEqual(second, {
    kind: 'already-rewarded',
    earlierCommentId: 'c1',
  });
  assert.equal(await karmaOf(store, 'Bob'), 1);
  assert.equal(await store.givenToday('Alice', DAY), 1);
  assert.equal((await store.eventsSince(0, 1000)).length, 1);
  assert.equal(await store.recordedReward('c2'), undefined);
});

test('a moderator repeat with a new comment records again and overwrites the pair', async () => {
  const { store } = setup();
  await store.recordReward(reward({ commentId: 'c1' }), loose);
  assert.deepEqual(
    await store.recordReward(reward({ commentId: 'c2', atMs: T0 + 1 }), loose),
    { kind: 'recorded' }
  );
  assert.equal(await karmaOf(store, 'Bob'), 2);
  assert.equal(await store.earlierReward('p1', 'Alice', 'Bob'), 'c2');
});

test('giving karma to oneself writes a single history entry', async () => {
  const { store } = setup();
  await store.recordReward(reward({ giver: 'Mod', receiver: 'mod' }), loose);
  assert.equal((await store.history('Mod', { limit: 10 })).length, 1);
});

for (const [name, options] of [
  ['without limits (a moderator)', loose],
  ['with limits', enforce],
] as const) {
  test(`a comment records once: the same comment again is already-recorded ${name}`, async () => {
    const { store } = setup();
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'recorded',
    });
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'already-recorded',
    });
    assert.equal(await karmaOf(store, 'Bob'), 1);
    assert.equal(await store.givenToday('Alice', DAY), 1);
    assert.equal((await store.eventsSince(0, 1000)).length, 1);
    assert.equal((await store.history('Bob', { limit: 10 })).length, 1);
  });
}

test('a moderator rewarding the same pair with two comments records both, and neither twice', async () => {
  const { store } = setup();
  const first = reward({ commentId: 'c1' });
  const second = reward({ commentId: 'c2', atMs: T0 + 1 });
  assert.equal((await store.recordReward(first, loose)).kind, 'recorded');
  assert.equal((await store.recordReward(second, loose)).kind, 'recorded');
  assert.equal(await karmaOf(store, 'Bob'), 2);

  // c1 is no longer the comment in the pair index; it is still on record.
  assert.deepEqual(await store.recordReward(first, loose), {
    kind: 'already-recorded',
  });
  assert.deepEqual(await store.recordReward(second, loose), {
    kind: 'already-recorded',
  });
  assert.equal(await karmaOf(store, 'Bob'), 2);
  assert.equal((await store.eventsSince(0, 1000)).length, 2);
});

for (const [name, options] of [
  ['without limits', loose],
  ['with limits', enforce],
] as const) {
  test(`an imported reward is already-recorded ${name}`, async () => {
    const { store } = setup();
    await store.importBatch({
      profiles: [],
      rewards: [
        {
          commentId: 'c1',
          postId: 'p1',
          giver: 'Alice',
          receiver: 'Bob',
          sign: 0,
          atMs: T0 - 5000,
        },
      ],
    });
    assert.equal(await store.recordedReward('c1'), undefined);
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'already-recorded',
    });
    assert.equal(await karmaOf(store, 'Bob'), 0);
    assert.equal(await store.givenToday('Alice', DAY), 0);
    assert.equal((await store.eventsSince(0, 1000)).length, 1);
  });
}

test('at the daily cap nothing is written; without limits it records', async () => {
  const { store } = setup();
  await store.setGivenToday('Alice', DAY, 10);

  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'cap',
  });
  assert.equal(await karmaOf(store, 'Bob'), 0);
  assert.equal(await store.givenToday('Alice', DAY), 10);
  assert.equal(await store.earlierReward('p1', 'Alice', 'Bob'), undefined);
  assert.equal(await store.recordedReward('c1'), undefined);
  assert.deepEqual(await store.eventsSince(0, 1000), []);
  assert.deepEqual(await store.history('Alice', { limit: 10 }), []);

  assert.deepEqual(await store.recordReward(reward(), loose), {
    kind: 'recorded',
  });
  assert.equal(await karmaOf(store, 'Bob'), 1);
  assert.equal(await store.givenToday('Alice', DAY), 11);
});

test('one below the cap records and reaches it', async () => {
  const { store } = setup();
  await store.setGivenToday('Alice', DAY, 9);
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });
  assert.equal(await store.givenToday('Alice', DAY), 10);
});

test('two concurrent rewards from a giver one below the cap give one reward and one cap', async () => {
  const { store } = setup();
  await store.setGivenToday('Alice', DAY, 9);

  const results = await Promise.all([
    store.recordReward(reward({ commentId: 'c1', receiver: 'Bob' }), enforce),
    store.recordReward(reward({ commentId: 'c2', receiver: 'Carol' }), enforce),
  ]);

  assert.deepEqual(results.map((result) => result.kind).sort(), [
    'cap',
    'recorded',
  ]);
  assert.equal(await store.givenToday('Alice', DAY), 10);
  assert.equal(
    (await karmaOf(store, 'Bob')) + (await karmaOf(store, 'Carol')),
    1
  );
  assert.equal((await store.eventsSince(0, 1000)).length, 1);
});

test('two concurrent rewards for the same pair with different comments give one reward', async () => {
  const { store } = setup();
  const results = await Promise.all([
    store.recordReward(reward({ commentId: 'c1' }), enforce),
    store.recordReward(reward({ commentId: 'c2' }), enforce),
  ]);

  assert.deepEqual(results.map((result) => result.kind).sort(), [
    'already-rewarded',
    'recorded',
  ]);
  const refused = results.find((result) => result.kind === 'already-rewarded');
  const winner = await store.earlierReward('p1', 'Alice', 'Bob');
  assert.ok(winner === 'c1' || winner === 'c2');
  assert.deepEqual(refused, {
    kind: 'already-rewarded',
    earlierCommentId: winner,
  });
  assert.equal(await karmaOf(store, 'Bob'), 1);
  assert.equal(await store.givenToday('Alice', DAY), 1);
});

test('two concurrent deliveries of the same comment give one reward', async () => {
  const { store } = setup();
  const results = await Promise.all([
    store.recordReward(reward(), loose),
    store.recordReward(reward(), loose),
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), [
    'already-recorded',
    'recorded',
  ]);
  assert.equal(await karmaOf(store, 'Bob'), 1);
});

for (const shape of ['empty', 'null'] as const) {
  test(`a race on the pair gives one point (discarded as ${shape})`, async () => {
    const { redis, store } = setup();
    redis.discardedShape = shape;
    redis.beforeExec = async () => {
      const other = await store.recordReward(
        reward({ commentId: 'other', atMs: T0 + 1 }),
        enforce
      );
      assert.deepEqual(other, { kind: 'recorded' });
    };
    const result = await store.recordReward(
      reward({ commentId: 'mine' }),
      enforce
    );
    assert.deepEqual(result, {
      kind: 'already-rewarded',
      earlierCommentId: 'other',
    });
    assert.equal(await karmaOf(store, 'Bob'), 1);
    assert.equal(await store.givenToday('Alice', DAY), 1);
  });
}

test('a discard caused by an unrelated write is retried and records once', async () => {
  const { redis, store } = setup();
  let hookRuns = 0;
  redis.beforeExec = async () => {
    hookRuns++;
    await redis.hSet('rewards', { 'p9|x|y': 'cx' });
  };
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });
  assert.equal(hookRuns, 1, 'the first attempt was discarded');
  assert.equal(await karmaOf(store, 'Bob'), 1);
  assert.equal((await store.eventsSince(0, 1000)).length, 1);
  assert.equal(await store.givenToday('Alice', DAY), 1);
});

test('a reward still records when three attempts are lost', async () => {
  const { redis, store } = setup();
  let hookRuns = 0;
  const lose = async () => {
    hookRuns++;
    await redis.hSet('rewards', { [`p9|x|${hookRuns}`]: 'cx' });
    if (hookRuns < 3) redis.beforeExec = lose;
  };
  redis.beforeExec = lose;
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });
  assert.equal(hookRuns, 3);
  assert.equal(await karmaOf(store, 'Bob'), 1);
});

test('a race lost four times throws and writes nothing', async () => {
  const { redis, store } = setup();
  let hookRuns = 0;
  const lose = async () => {
    hookRuns++;
    await redis.hSet('rewards', { [`p9|x|${hookRuns}`]: 'cx' });
    redis.beforeExec = lose;
  };
  redis.beforeExec = lose;

  await assert.rejects(store.recordReward(reward(), enforce), /discarded/);

  assert.equal(hookRuns, 4);
  assert.equal(await karmaOf(store, 'Bob'), 0);
  assert.equal(await store.givenToday('Alice', DAY), 0);
  assert.equal(await store.recordedReward('c1'), undefined);
  assert.deepEqual(await store.eventsSince(0, 1000), []);
});

// ------------------------------------------------------------------ history and events

test('history is newest first, limited, and pages by offset', async () => {
  const { store } = setup();
  for (let i = 1; i <= 5; i++) {
    await store.recordReward(
      reward({ commentId: `c${i}`, postId: `p${i}`, atMs: T0 + i * 1000 }),
      enforce
    );
  }

  assert.deepEqual(commentIds(await store.history('Bob', { limit: 3 })), [
    'c5',
    'c4',
    'c3',
  ]);
  assert.deepEqual(
    commentIds(await store.history('Bob', { offset: 3, limit: 10 })),
    ['c2', 'c1']
  );
  assert.deepEqual(
    commentIds(await store.history('Bob', { offset: 2, limit: 1 })),
    ['c3']
  );
  assert.deepEqual(
    await store.history('Bob', { offset: 5, limit: 10 }),
    [],
    'past the end'
  );
  assert.deepEqual(await store.history('Bob', { limit: 0 }), []);
});

test('entries that share a millisecond page with none skipped or repeated', async () => {
  const { store } = setup();
  for (let i = 0; i < 7; i++) {
    await store.appendHistory('Bob', {
      kind: 'reward',
      atMs: i < 5 ? T0 : T0 + 10,
      commentId: `c${i}`,
      postId: 'p1',
      giver: `g${i}`,
      receiver: 'Bob',
      sign: 1,
    });
  }
  const seen: string[] = [];
  for (let offset = 0; offset < 8; offset += 2) {
    seen.push(...commentIds(await store.history('Bob', { offset, limit: 2 })));
  }
  assert.equal(seen.length, 7);
  assert.deepEqual(
    [...seen].sort(),
    ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    'every entry once'
  );
  assert.deepEqual(
    new Set(seen.slice(0, 2)),
    new Set(['c5', 'c6']),
    'the newest come first'
  );
  assert.deepEqual(
    commentIds(await store.history('Bob', { limit: 10 })),
    seen,
    'paging agrees with one big read'
  );
});

test('two rewards at the same millisecond both stay in the history', async () => {
  const { store } = setup();
  await store.recordReward(reward({ commentId: 'c1', postId: 'p1' }), enforce);
  await store.recordReward(reward({ commentId: 'c2', postId: 'p2' }), enforce);
  assert.equal((await store.history('Bob', { limit: 10 })).length, 2);
});

test('an edit entry round trips with and without an after profile', async () => {
  const { store } = setup();
  const before = { ...emptyProfile('Bob'), karma: 4 };
  await store.appendHistory('Bob', {
    kind: 'edit',
    atMs: T0,
    moderator: 'M',
    before,
    after: undefined,
  });
  await store.appendHistory('Bob', {
    kind: 'edit',
    atMs: T0 + 1,
    moderator: 'M',
    before,
    after: emptyProfile('Bob'),
  });
  const [newer, older] = await store.history('Bob', { limit: 5 });
  assert.deepEqual(newer, {
    kind: 'edit',
    atMs: T0 + 1,
    moderator: 'M',
    before,
    after: emptyProfile('Bob'),
  });
  assert.deepEqual(older, {
    kind: 'edit',
    atMs: T0,
    moderator: 'M',
    before,
    after: undefined,
  });
});

test('eventsSince returns rewards from the given time, oldest first', async () => {
  const { store } = setup();
  await store.recordReward(
    reward({ commentId: 'c2', postId: 'p2', atMs: T0 + 2000 }),
    enforce
  );
  await store.recordReward(
    reward({ commentId: 'c1', postId: 'p1', atMs: T0 + 1000 }),
    enforce
  );
  await store.recordReward(
    reward({ commentId: 'c3', postId: 'p3', atMs: T0 + 3000 }),
    enforce
  );
  const since = await store.eventsSince(T0 + 2000, 1000);
  assert.deepEqual(
    since.map((r) => r.commentId),
    ['c2', 'c3']
  );
  assert.equal((await store.eventsSince(0, 1000)).length, 3);
});

test('eventsSince reads past one page of 1000, oldest first, and respects the limit', async () => {
  const { store } = setup();
  const rewards: ImportedReward[] = [];
  for (let i = 0; i < 1200; i++) {
    rewards.push({
      commentId: `c${i}`,
      postId: `p${i}`,
      giver: `giver${i % 50}`,
      receiver: `receiver${i}`,
      sign: 1,
      atMs: T0 + i,
    });
  }
  await store.importBatch({ profiles: [], rewards });

  const all = await store.eventsSince(0, 5000);
  assert.equal(all.length, 1200);
  assert.deepEqual(
    all.map((event) => event.atMs),
    rewards.map((event) => event.atMs),
    'oldest first, none missing'
  );

  const some = await store.eventsSince(0, 1100);
  assert.equal(some.length, 1100);
  assert.equal(some[1099]?.commentId, 'c1099');

  assert.equal((await store.eventsSince(0, 50)).length, 50);
  assert.equal((await store.eventsSince(T0 + 1150, 5000)).length, 50);
  assert.deepEqual(await store.eventsSince(0, 0), []);
});

// ------------------------------------------------------------------ import

test('import progress starts empty and is stored', async () => {
  const { store } = setup();
  assert.deepEqual(await store.importProgress(), { rows: 0, done: false });
  await store.setImportProgress({ rows: 1000, done: true });
  assert.deepEqual(await store.importProgress(), { rows: 1000, done: true });
});

test('importing a batch twice leaves the same state, with every history entry once', async () => {
  const { redis, store } = setup();
  const profiles: Profile[] = [
    { redditUsername: 'Alice', karma: 7, m76Karma: 2, gamertags: [] },
    {
      redditUsername: 'Bob',
      karma: -2,
      m76Karma: 0,
      gamertags: [{ platform: 'XBOX', username: 'b', userId: '9' }],
    },
  ];
  const rewards: ImportedReward[] = [
    {
      commentId: 'c1',
      postId: 'p1',
      giver: 'Alice',
      receiver: 'Bob',
      sign: 0,
      atMs: T0 + 1,
    },
    {
      commentId: 'c2',
      postId: 'p1',
      giver: 'Alice',
      receiver: 'Bob',
      sign: 0,
      atMs: T0 + 2,
    },
    {
      commentId: 'c3',
      postId: 'p2',
      giver: 'Dana',
      receiver: 'Alice',
      sign: 1,
      atMs: T0 + 3,
    },
  ];
  await store.importBatch({ profiles, rewards });
  const snapshot = async () => ({
    alice: await store.loadProfile('Alice'),
    bob: await store.loadProfile('Bob'),
    pair: await store.earlierReward('p1', 'Alice', 'Bob'),
    events: await store.eventsSince(0, 1000),
    aliceHistory: await store.history('Alice', { limit: 10 }),
    bobHistory: await store.history('Bob', { limit: 10 }),
    danaHistory: await store.history('Dana', { limit: 10 }),
    given: await redis.get(`given:alice:${DAY}`),
  });
  const first = await snapshot();
  await store.importBatch({ profiles, rewards });
  assert.deepEqual(await snapshot(), first);

  assert.equal(
    first.pair,
    'c2',
    'the index keeps the last reward of a duplicate pair'
  );
  assert.equal(first.events.length, 3);
  assert.equal(first.aliceHistory.length, 3);
  assert.equal(first.bobHistory.length, 2);
  assert.equal(first.danaHistory.length, 1);
  assert.equal(first.alice.karma, 7);
  assert.equal(first.given, undefined, 'import does not touch the day counts');
});

test('an empty batch writes nothing', async () => {
  const { store } = setup();
  await store.importBatch({ profiles: [], rewards: [] });
  assert.deepEqual(await store.eventsSince(0, 1000), []);
});

test('a batch of rewards with more history sets than one parallel group imports them all', async () => {
  const { store } = setup();
  const rewards: ImportedReward[] = [];
  for (let i = 0; i < 60; i++) {
    rewards.push({
      commentId: `c${i}`,
      postId: 'p1',
      giver: `giver${i}`,
      receiver: `receiver${i}`,
      sign: 1,
      atMs: T0 + i,
    });
  }
  await store.importBatch({ profiles: [], rewards });
  for (const name of ['giver0', 'receiver0', 'giver59', 'receiver59'])
    assert.equal((await store.history(name, { limit: 10 })).length, 1, name);
});
