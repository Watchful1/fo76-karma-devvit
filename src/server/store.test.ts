import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DAY_MS } from './time';
import { IN_FLIGHT_MS, Store } from './store';
import { FakeRedis, historyOf } from './testing/fake-redis';
import {
  emptyProfile,
  type ImportedReward,
  type Profile,
  type Reward,
} from './types';

const T0 = 1_800_000_000_000;
const DAY = '2027-01-15';
const HOUR = 60 * 60 * 1000;
const CAP = 10;

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

function imported(
  commentId: string,
  giver: string,
  receiver: string
): ImportedReward {
  return { commentId, postId: 'p1', giver, receiver, sign: 0, atMs: T0 };
}

const enforce = { enforceLimits: true, dayKey: DAY, dailyCap: CAP };
const loose = { enforceLimits: false, dayKey: DAY, dailyCap: CAP };

const karmaOf = async (store: Store, name: string) =>
  (await store.loadProfile(name)).karma;

/** The names in a user's reward history, as `giver>receiver`, oldest first. */
async function trades(redis: FakeRedis, name: string): Promise<string[]> {
  return (await historyOf(redis, name)).map(
    (entry) => `${entry.giver}>${entry.receiver}`
  );
}

test('an imported profile loads back, and an unknown user is empty', async () => {
  const { store } = setup();
  const profile: Profile = {
    redditUsername: 'Bob',
    karma: 12,
    m76Karma: 5,
    gamertags: [{ platform: 'PC', username: 'bobby', userId: '1' }],
  };
  await store.importBatch({ profiles: [profile], rewards: [] });
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
  await store.importBatch({
    profiles: [{ ...emptyProfile('Bob'), karma: 5 }],
    rewards: [],
  });
  const details: Profile = {
    redditUsername: 'Bob',
    karma: 99,
    m76Karma: 3,
    gamertags: [{ platform: 'XBOX', username: 'b', userId: '2' }],
  };
  await store.saveDetails(details);
  assert.deepEqual(await store.loadProfile('Bob'), { ...details, karma: 5 });
});

test('addKarma adds to the current value and returns it', async () => {
  const { store } = setup();
  assert.equal(await store.addKarma('Bob', 3), 3);
  assert.equal(await store.addKarma('BOB', -1), 2);
  assert.equal(await karmaOf(store, 'Bob'), 2);
  await store.recordReward(reward(), enforce);
  assert.equal(await store.addKarma('Bob', 5), 8);
});

test('deleting a profile removes it, its history and the pairs on both sides', async () => {
  const { redis, store } = setup();
  await store.importBatch({
    profiles: [
      {
        redditUsername: 'Bob',
        karma: 3,
        m76Karma: 40,
        gamertags: [{ platform: 'PC', username: 'bobby', userId: '1' }],
      },
    ],
    rewards: [],
  });
  await store.recordReward(reward({ commentId: 'c1' }), enforce);
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
  assert.deepEqual(await historyOf(redis, 'Bob'), []);
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
  assert.equal((await historyOf(redis, 'Alice')).length, 2);
  assert.equal((await historyOf(redis, 'Carol')).length, 2);
});

const PLACEHOLDER = /^\[deleted-[0-9a-f]{8}\]$/;

test('deleting a profile puts a placeholder for the name in partners histories and the event log', async () => {
  const { redis, store } = setup();
  await store.recordReward(reward({ commentId: 'c1', atMs: T0 }), enforce);
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
    reward({ commentId: 'c3', receiver: 'Carol', atMs: T0 + 2 }),
    enforce
  );

  const placeholder = await store.deleteProfile('BOB');

  assert.match(placeholder, PLACEHOLDER);
  assert.deepEqual(await trades(redis, 'Alice'), [
    `Alice>${placeholder}`,
    'Alice>Carol',
  ]);
  assert.deepEqual(await trades(redis, 'Carol'), [
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
  assert.deepEqual(await historyOf(redis, 'Bob'), []);
  assert.deepEqual(
    await historyOf(redis, placeholder),
    [],
    'the placeholder gets no history of its own'
  );
});

test('deleting a profile renames and unpairs imported rewards too', async () => {
  const { redis, store } = setup();
  await store.importBatch({
    profiles: [],
    rewards: [
      imported('i1', 'Bob', 'Carol'),
      imported('i2', 'Dana', 'Bob'),
      imported('i3', 'Dana', 'Carol'),
    ],
  });

  const placeholder = await store.deleteProfile('bob');

  assert.equal(await store.earlierReward('p1', 'Bob', 'Carol'), undefined);
  assert.equal(await store.earlierReward('p1', 'Dana', 'Bob'), undefined);
  assert.equal(await store.earlierReward('p1', 'Dana', 'Carol'), 'i3');
  assert.deepEqual(
    (await trades(redis, 'Carol')).sort(),
    [`${placeholder}>Carol`, 'Dana>Carol'].sort()
  );
  const events = await store.eventsSince(0, 10);
  const i1 = events.find((event) => event.commentId === 'i1');
  assert.equal(i1?.giver, placeholder);
  assert.equal(i1?.sign, 0);
});

test('deleting a profile skips history entries that are not rewards', async () => {
  const { redis, store } = setup();
  await store.recordReward(reward(), enforce);
  await redis.zAdd('history:bob', {
    member: JSON.stringify({ kind: 'edit', atMs: T0 + 1, moderator: 'M' }),
    score: T0 + 1,
  });

  const placeholder = await store.deleteProfile('Bob');

  assert.deepEqual(await trades(redis, 'Alice'), [`Alice>${placeholder}`]);
  assert.equal((await store.eventsSince(0, 10)).length, 1);
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
  const afterFailure = await trades(redis, 'Alice');

  const placeholder = await store.deleteProfile('Bob');

  assert.deepEqual(await trades(redis, 'Alice'), [
    `Alice>${placeholder}`,
    `${placeholder}>Alice`,
  ]);
  assert.deepEqual(
    afterFailure,
    await trades(redis, 'Alice'),
    'the second run changed nothing in the partner history'
  );
  assert.equal((await store.eventsSince(0, 100)).length, 2);
  assert.deepEqual(await historyOf(redis, 'Bob'), []);
});

test('deleting two users who traded with each other leaves two placeholders and no stray history', async () => {
  const { redis, store } = setup();
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
  assert.deepEqual(await historyOf(redis, bob), []);
  assert.deepEqual(await historyOf(redis, alice), []);
});

test('a user with more partners than one group of writes is renamed everywhere', async () => {
  const { redis, store } = setup();
  for (let i = 0; i < 60; i++) {
    await store.recordReward(
      reward({
        commentId: `c${i}`,
        postId: `p${i}`,
        giver: `Partner${i}`,
        atMs: T0 + i,
      }),
      loose
    );
  }
  const placeholder = await store.deleteProfile('Bob');
  for (const i of [0, 24, 25, 59]) {
    assert.deepEqual(await trades(redis, `Partner${i}`), [
      `Partner${i}>${placeholder}`,
    ]);
    assert.equal(
      await store.earlierReward(`p${i}`, `Partner${i}`, 'Bob'),
      undefined
    );
  }
  assert.equal((await store.eventsSince(0, 100)).length, 60);
});

test('claim: the first caller claims, the second is busy and finishing makes it done', async () => {
  const { store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  assert.equal(await store.claim('c9'), 'busy');
  await store.finish('c9');
  assert.equal(await store.claim('c9'), 'done');
});

test('claim: a pending attempt is busy while in flight, then resumed once', async () => {
  const { clock, store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  clock.now += IN_FLIGHT_MS - 1;
  assert.equal(await store.claim('c9'), 'busy');
  clock.now += 2;
  assert.equal(await store.claim('c9'), 'resumed');
  assert.equal(
    await store.claim('c9'),
    'busy',
    'the takeover started a new attempt'
  );
  clock.now += IN_FLIGHT_MS + 1;
  assert.equal(await store.claim('c9'), 'resumed');
});

test('claim: takeOver resumes a fresh pending attempt', async () => {
  const { store } = setup();
  assert.equal(await store.claim('c9'), 'claimed');
  assert.equal(await store.claim('c9', { takeOver: true }), 'resumed');
  assert.equal(await store.claim('c9'), 'busy');
  assert.equal(await store.claim('fresh', { takeOver: true }), 'claimed');
});

test('claim: a finished comment is done, with or without takeOver or an earlier claim', async () => {
  const { store } = setup();
  await store.claim('c9');
  await store.finish('c9');
  assert.equal(await store.claim('c9'), 'done');
  assert.equal(await store.claim('c9', { takeOver: true }), 'done');
  assert.equal(await store.claim('c9'), 'done');

  await store.finish('unclaimed');
  assert.equal(await store.claim('unclaimed'), 'done');
});

test('claim: a finished or pending claim expires after a year', async () => {
  const { clock, store } = setup();
  await store.claim('finished');
  await store.finish('finished');
  await store.claim('pending');
  clock.now += 364 * DAY_MS;
  assert.equal(await store.claim('finished'), 'done');
  clock.now += 2 * DAY_MS;
  assert.equal(await store.claim('finished'), 'claimed');
  assert.equal(await store.claim('pending'), 'claimed');
});

test('recording a reward changes karma, the day count, events and both histories', async () => {
  const { redis, store } = setup();
  assert.equal(await store.givenToday('Alice', DAY), 0);
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });

  assert.equal(await karmaOf(store, 'bob'), 1);
  assert.equal(await store.givenToday('alice', DAY), 1);
  assert.equal(await store.earlierReward('p1', 'ALICE', 'bob'), 'c1');
  assert.deepEqual(await store.recordedReward('c1'), reward());
  assert.deepEqual(await store.eventsSince(0, 1000), [reward()]);
  const entry = { kind: 'reward', ...reward() };
  assert.deepEqual(await historyOf(redis, 'Alice'), [entry]);
  assert.deepEqual(await historyOf(redis, 'Bob'), [entry]);
});

test('a take lowers karma', async () => {
  const { store } = setup();
  await store.recordReward(reward({ sign: -1 }), enforce);
  assert.equal(await karmaOf(store, 'Bob'), -1);
});

test('the day count, recorded or set, expires after two days', async () => {
  const { clock, store } = setup();
  await store.recordReward(reward(), enforce);
  await store.setGivenToday('Carol', DAY, 7);
  assert.equal(await store.givenToday('carol', DAY), 7);
  clock.now += 47 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 1);
  assert.equal(await store.givenToday('Carol', DAY), 7);
  clock.now += 2 * HOUR;
  assert.equal(await store.givenToday('Alice', DAY), 0);
  assert.equal(await store.givenToday('Carol', DAY), 0);
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

test('without limits the same pair records with each new comment, and no comment twice', async () => {
  const { store } = setup();
  const first = reward({ commentId: 'c1' });
  const second = reward({ commentId: 'c2', atMs: T0 + 1 });
  assert.equal((await store.recordReward(first, loose)).kind, 'recorded');
  assert.equal((await store.recordReward(second, loose)).kind, 'recorded');
  assert.equal(await karmaOf(store, 'Bob'), 2);
  assert.equal(await store.earlierReward('p1', 'Alice', 'Bob'), 'c2');

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

test('giving karma to oneself writes a single history entry', async () => {
  const { redis, store } = setup();
  await store.recordReward(reward({ giver: 'Mod', receiver: 'mod' }), loose);
  assert.equal((await historyOf(redis, 'Mod')).length, 1);
});

test('a comment records once, with or without limits', async () => {
  for (const options of [loose, enforce]) {
    const { redis, store } = setup();
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'recorded',
    });
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'already-recorded',
    });
    assert.equal(await karmaOf(store, 'Bob'), 1);
    assert.equal(await store.givenToday('Alice', DAY), 1);
    assert.equal((await store.eventsSince(0, 1000)).length, 1);
    assert.equal((await historyOf(redis, 'Bob')).length, 1);
  }
});

test('an imported reward is already recorded, with or without limits', async () => {
  for (const options of [loose, enforce]) {
    const { store } = setup();
    await store.importBatch({
      profiles: [],
      rewards: [{ ...imported('c1', 'Alice', 'Bob'), atMs: T0 - 5000 }],
    });
    assert.equal(await store.recordedReward('c1'), undefined);
    assert.deepEqual(await store.recordReward(reward(), options), {
      kind: 'already-recorded',
    });
    assert.equal(await karmaOf(store, 'Bob'), 0);
    assert.equal(await store.givenToday('Alice', DAY), 0);
    assert.equal((await store.eventsSince(0, 1000)).length, 1);
  }
});

test('at the daily cap nothing is written; without limits it records', async () => {
  const { redis, store } = setup();
  await store.setGivenToday('Alice', DAY, CAP);

  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'cap',
  });
  assert.equal(await karmaOf(store, 'Bob'), 0);
  assert.equal(await store.givenToday('Alice', DAY), CAP);
  assert.equal(await store.earlierReward('p1', 'Alice', 'Bob'), undefined);
  assert.equal(await store.recordedReward('c1'), undefined);
  assert.deepEqual(await store.eventsSince(0, 1000), []);
  assert.deepEqual(await historyOf(redis, 'Alice'), []);

  assert.deepEqual(await store.recordReward(reward(), loose), {
    kind: 'recorded',
  });
  assert.equal(await karmaOf(store, 'Bob'), 1);
  assert.equal(await store.givenToday('Alice', DAY), CAP + 1);
});

test('one below the cap records and reaches it', async () => {
  const { store } = setup();
  await store.setGivenToday('Alice', DAY, CAP - 1);
  assert.deepEqual(await store.recordReward(reward(), enforce), {
    kind: 'recorded',
  });
  assert.equal(await store.givenToday('Alice', DAY), CAP);
});

test('two concurrent rewards from a giver one below the cap give one reward and one cap', async () => {
  const { store } = setup();
  await store.setGivenToday('Alice', DAY, CAP - 1);

  const results = await Promise.all([
    store.recordReward(reward({ commentId: 'c1', receiver: 'Bob' }), enforce),
    store.recordReward(reward({ commentId: 'c2', receiver: 'Carol' }), enforce),
  ]);

  assert.deepEqual(results.map((result) => result.kind).sort(), [
    'cap',
    'recorded',
  ]);
  assert.equal(await store.givenToday('Alice', DAY), CAP);
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

for (const discardedAs of [[], null] satisfies ([] | null)[]) {
  test(`a race on the pair, lost inside the transaction, gives one point (discarded as ${JSON.stringify(discardedAs)})`, async () => {
    const { redis, store } = setup();
    redis.discardedAs = discardedAs;
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

test('two rewards at the same millisecond both stay in the history', async () => {
  const { redis, store } = setup();
  await store.recordReward(reward({ commentId: 'c1', postId: 'p1' }), enforce);
  await store.recordReward(reward({ commentId: 'c2', postId: 'p2' }), enforce);
  assert.equal((await historyOf(redis, 'Bob')).length, 2);
});

test('eventsSince returns rewards from the given time, oldest first', async () => {
  const { store } = setup();
  for (const i of [2, 1, 3]) {
    await store.recordReward(
      reward({ commentId: `c${i}`, postId: `p${i}`, atMs: T0 + i * 1000 }),
      enforce
    );
  }
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

test('import progress starts empty and is stored', async () => {
  const { store } = setup();
  assert.deepEqual(await store.importProgress(), { rows: 0, done: false });
  await store.setImportProgress({ rows: 1000, done: true });
  assert.deepEqual(await store.importProgress(), { rows: 1000, done: true });
});

test('importing a batch', async (t) => {
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
    { ...imported('c1', 'Alice', 'Bob'), atMs: T0 + 1 },
    { ...imported('c2', 'Alice', 'Bob'), atMs: T0 + 2 },
    { ...imported('c3', 'Dana', 'Alice'), postId: 'p2', sign: 1, atMs: T0 + 3 },
  ];
  await store.importBatch({ profiles, rewards });
  const state = async () => ({
    alice: await store.loadProfile('Alice'),
    bob: await store.loadProfile('Bob'),
    pair: await store.earlierReward('p1', 'Alice', 'Bob'),
    events: await store.eventsSince(0, 1000),
    aliceHistory: await historyOf(redis, 'Alice'),
    bobHistory: await historyOf(redis, 'Bob'),
    danaHistory: await historyOf(redis, 'Dana'),
  });
  const first = await state();

  await t.test('writes the profiles with their karma', () => {
    assert.deepEqual([first.alice, first.bob], profiles);
  });

  await t.test('keeps the last reward of a duplicate pair in the index', () => {
    assert.equal(first.pair, 'c2');
  });

  await t.test('puts every reward in the events and in both histories', () => {
    assert.equal(first.events.length, 3);
    assert.equal(first.aliceHistory.length, 3);
    assert.equal(first.bobHistory.length, 2);
    assert.equal(first.danaHistory.length, 1);
  });

  await t.test('leaves the day counts alone', async () => {
    assert.equal(await store.givenToday('Alice', DAY), 0);
  });

  await t.test('a second time changes nothing', async () => {
    await store.importBatch({ profiles, rewards });
    assert.deepEqual(await state(), first);
  });
});

test('an empty batch writes nothing', async () => {
  const { store } = setup();
  await store.importBatch({ profiles: [], rewards: [] });
  assert.deepEqual(await store.eventsSince(0, 1000), []);
});

test('a batch of rewards with more history sets than one parallel group imports them all', async () => {
  const { redis, store } = setup();
  const rewards: ImportedReward[] = [];
  for (let i = 0; i < 60; i++)
    rewards.push({
      ...imported(`c${i}`, `giver${i}`, `receiver${i}`),
      sign: 1,
    });
  await store.importBatch({ profiles: [], rewards });
  for (const name of ['giver0', 'receiver0', 'giver59', 'receiver59'])
    assert.equal((await historyOf(redis, name)).length, 1, name);
});
