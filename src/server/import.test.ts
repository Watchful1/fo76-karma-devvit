import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_ROWS,
  dailyCountsFrom,
  importedAtLeast,
  importHop,
  parsePastedSnapshot,
  parseSnapshot,
  profileFromRow,
  rewardFromRow,
  type ProfileRow,
  type RewardRow,
  type Snapshot,
} from './import';
import { Store } from './store';
import { FakeRedis } from './testing/fake-redis';
import type { ImportedReward, Profile } from './types';

type Batch = { profiles: Profile[]; rewards: ImportedReward[] };

function fakeStore(failNextBatch = false) {
  const batches: Batch[] = [];
  let progress = { rows: 0, done: false };
  let fail = failNextBatch;
  return {
    batches,
    get progress() {
      return progress;
    },
    importProgress: async () => progress,
    setImportProgress: async (next: { rows: number; done: boolean }) => {
      progress = next;
    },
    importBatch: async (batch: Batch) => {
      if (fail) {
        fail = false;
        throw new Error('store down');
      }
      batches.push(batch);
    },
  };
}

function snapshotOf(profileCount: number, rewardCount: number): Snapshot {
  const profiles: ProfileRow[] = Array.from(
    { length: profileCount },
    (_, i) => [`User${i}`, i, 0, []]
  );
  const rewards: RewardRow[] = Array.from({ length: rewardCount }, (_, i) => [
    `c${i}`,
    'p1',
    'Giver',
    'Receiver',
    1000 + i,
  ]);
  return { newestMs: 1000 + rewardCount, profiles, rewards };
}

test('parseSnapshot accepts the placeholder and a small snapshot', () => {
  const empty = parseSnapshot('{"newestMs":0,"profiles":[],"rewards":[]}');
  assert.deepEqual(empty, { newestMs: 0, profiles: [], rewards: [] });

  const small = parseSnapshot(
    JSON.stringify({
      newestMs: 5000,
      profiles: [['Alice', 3, 1, [['PC', 'alice_pc', '123']]]],
      rewards: [['kx88385', '1bqgyt1', 'Alice', 'Bob', 5000]],
    })
  );
  assert.equal(small.profiles.length, 1);
  assert.equal(importedAtLeast(small), 5000);
});

test('parseSnapshot rejects a wrong shape', () => {
  assert.throws(() => parseSnapshot('not json'), /not valid JSON/);
  assert.throws(() => parseSnapshot('[]'), /must be an object/);
  assert.throws(
    () => parseSnapshot('{"profiles":[],"rewards":[]}'),
    /newestMs/
  );
  assert.throws(
    () => parseSnapshot('{"newestMs":0,"profiles":{},"rewards":[]}'),
    /profiles must be an array/
  );
  assert.throws(
    () => parseSnapshot('{"newestMs":0,"profiles":[["a",1]],"rewards":[]}'),
    /profile row 0/
  );
  assert.throws(
    () =>
      parseSnapshot(
        '{"newestMs":0,"profiles":[],"rewards":[["a","b","c","d","e"]]}'
      ),
    /reward row 0/
  );
});

test('profileFromRow converts gamertags', () => {
  const profile = profileFromRow([
    'Alice',
    -3,
    69420,
    [['XBOX', 'alice_x', '42']],
  ]);
  assert.deepEqual(profile, {
    redditUsername: 'Alice',
    karma: -3,
    m76Karma: 69420,
    gamertags: [{ platform: 'XBOX', username: 'alice_x', userId: '42' }],
  });
  assert.throws(
    () => profileFromRow(['Bob', 0, 0, [['Switch', 'b', '1']]]),
    /Unknown platform/
  );
});

test('rewardFromRow has an unknown sign and adds the id prefixes once', () => {
  const expected = {
    commentId: 't1_kx88385',
    postId: 't3_1bqgyt1',
    giver: 'A',
    receiver: 'B',
    sign: 0,
    atMs: 7,
  };
  assert.deepEqual(
    rewardFromRow(['kx88385', '1bqgyt1', 'A', 'B', 7]),
    expected
  );
  assert.deepEqual(
    rewardFromRow(['t1_kx88385', 't3_1bqgyt1', 'A', 'B', 7]),
    expected
  );
});

test('importHop loads 2,500 rows in batches of 1000, 1000 and 500', async () => {
  const snapshot = snapshotOf(1200, 1300);
  const store = fakeStore();

  assert.deepEqual(await importHop(snapshot, store), {
    rows: 1000,
    total: 2500,
    done: false,
  });
  assert.deepEqual(await importHop(snapshot, store), {
    rows: 2000,
    total: 2500,
    done: false,
  });
  assert.deepEqual(await importHop(snapshot, store), {
    rows: 2500,
    total: 2500,
    done: true,
  });

  assert.deepEqual(
    store.batches.map((b) => [b.profiles.length, b.rewards.length]),
    [
      [1000, 0],
      [200, 800],
      [0, 500],
    ]
  );
  assert.equal(store.batches[1]?.rewards[0]?.commentId, 't1_c0');
  assert.equal(store.batches[2]?.rewards[0]?.commentId, 't1_c800');
  assert.deepEqual(store.progress, { rows: 2500, done: true });

  assert.deepEqual(await importHop(snapshot, store), {
    rows: 2500,
    total: 2500,
    done: true,
  });
  assert.equal(store.batches.length, 3, 'a finished import sends nothing');
  assert.equal(BATCH_ROWS, 1000);
});

test('a hop whose batch failed leaves the progress and sends the same batch again', async () => {
  const snapshot = snapshotOf(10, 20);
  const store = fakeStore(true);

  await assert.rejects(importHop(snapshot, store), /store down/);
  assert.deepEqual(store.progress, { rows: 0, done: false });

  assert.deepEqual(await importHop(snapshot, store), {
    rows: 30,
    total: 30,
    done: true,
  });
  assert.equal(store.batches.length, 1);
  assert.equal(store.batches[0]?.profiles.length, 10);

  // A repeat of a hop whose progress was not saved sends identical rows.
  const again = fakeStore();
  await importHop(snapshot, again);
  assert.deepEqual(again.batches[0], store.batches[0]);
});

test('an empty snapshot is done after one hop', async () => {
  const store = fakeStore();
  assert.deepEqual(await importHop(snapshotOf(0, 0), store), {
    rows: 0,
    total: 0,
    done: true,
  });
});

test('dailyCountsFrom counts rewards per lowercased giver and day', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const base = Date.UTC(2026, 9, 4, 12);
  const reward = (giver: string, atMs: number): ImportedReward => ({
    commentId: 't1_x',
    postId: 't3_y',
    giver,
    receiver: 'Z',
    sign: 0,
    atMs,
  });
  const counts = dailyCountsFrom(
    [
      reward('Alice', base),
      reward('alice', base + 1000),
      reward('Alice', base + 86_400_000),
      reward('Bob', base),
    ],
    day
  );
  assert.deepEqual(
    [...counts],
    [
      ['alice|2026-10-04', 2],
      ['alice|2026-10-05', 1],
      ['bob|2026-10-04', 1],
    ]
  );
});

// ------------------------------------------------------------ parseSnapshot, gamertag rows

const withProfiles = (profiles: unknown[]) =>
  JSON.stringify({ newestMs: 0, profiles, rewards: [] });

test('parseSnapshot rejects a gamertag row with an unknown platform, naming the profile row', () => {
  assert.throws(
    () =>
      parseSnapshot(
        withProfiles([
          ['A', 0, 0, []],
          ['B', 0, 0, []],
          ['C', 1, 0, [['Switch', 'c', '1']]],
        ])
      ),
    /profile row 2 /
  );
});

test('parseSnapshot rejects a gamertag row with a null name or id', () => {
  // The shape the broken export script produced: the name and id were read from the wrong fields.
  assert.throws(
    () =>
      parseSnapshot(
        withProfiles([
          ['A', 0, 0, []],
          ['B', 1, 0, [['PC', null, 'undefined']]],
        ])
      ),
    /profile row 1 /
  );
  assert.throws(
    () => parseSnapshot(withProfiles([['A', 1, 0, [['PC', 'a', null]]]])),
    /profile row 0 /
  );
  assert.throws(
    () => parseSnapshot(withProfiles([['A', 1, 0, [['PC', 'a', 0]]]])),
    /profile row 0 /,
    'a numeric id is not a string'
  );
});

test('parseSnapshot accepts all three platforms', () => {
  const snapshot = parseSnapshot(
    withProfiles([
      [
        'A',
        1,
        0,
        [
          ['XBOX', 'x', '1'],
          ['PlayStation', 'p', '2'],
          ['PC', 'c', '3'],
        ],
      ],
    ])
  );
  assert.equal(snapshot.profiles[0]?.[3].length, 3);
});

// ------------------------------------------------------------ parsePastedSnapshot

const PASTED = {
  newestMs: 5000,
  profiles: [['Alice', 3, 1, [['PC', 'alice_pc', '123']]]],
  rewards: [['kx88385', '1bqgyt1', 'Alice', 'Bob', 5000]],
};

test('parsePastedSnapshot reads plain JSON', () => {
  assert.deepEqual(parsePastedSnapshot(JSON.stringify(PASTED)), PASTED);
});

test('parsePastedSnapshot reads JSON inside a code fence, with or without a language tag', () => {
  const json = JSON.stringify(PASTED);
  assert.deepEqual(parsePastedSnapshot('```json\n' + json + '\n```'), PASTED);
  assert.deepEqual(parsePastedSnapshot('```\n' + json + '\n```'), PASTED);
  assert.deepEqual(
    parsePastedSnapshot('\n  ```JSON\r\n' + json + '\r\n```  \n'),
    PASTED
  );
});

test('parsePastedSnapshot decodes HTML entities, in quotes and inside a gamertag', () => {
  const json = JSON.stringify({
    ...PASTED,
    profiles: [['Alice', 3, 1, [['PC', 'Tom & <Jerry>', '1']]]],
  });
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const snapshot = parsePastedSnapshot(escaped);
  assert.equal(snapshot.profiles[0]?.[3][0]?.[1], 'Tom & <Jerry>');

  const fenced = parsePastedSnapshot('```json\n' + escaped + '\n```');
  assert.equal(fenced.profiles[0]?.[3][0]?.[1], 'Tom & <Jerry>');
});

test('parsePastedSnapshot decodes &amp; in a gamertag of a fenced snapshot', () => {
  const json = JSON.stringify(PASTED).replace('alice_pc', 'a&amp;b');
  const snapshot = parsePastedSnapshot('```\n' + json + '\n```');
  assert.equal(snapshot.profiles[0]?.[3][0]?.[1], 'a&b');
});

test('parsePastedSnapshot decodes &amp; in a gamertag of unfenced JSON whose quotes are real', () => {
  const json = JSON.stringify(PASTED).replace('alice_pc', 'a&amp;b');
  const snapshot = parsePastedSnapshot(json);
  assert.equal(snapshot.profiles[0]?.[3][0]?.[1], 'a&b');
});

test('parsePastedSnapshot rethrows the original error for garbage', () => {
  let original: unknown;
  try {
    parseSnapshot('garbage in');
  } catch (error) {
    original = error;
  }
  assert.throws(
    () => parsePastedSnapshot('garbage in'),
    (error) => {
      assert.match(String(error), /not valid JSON/);
      assert.equal((error as Error).message, (original as Error).message);
      return true;
    }
  );
  assert.throws(
    () => parsePastedSnapshot('```json\nstill garbage &amp; more\n```'),
    /not valid JSON/
  );
  assert.throws(() => parsePastedSnapshot(''), /not valid JSON/);
});

// ------------------------------------------------------------ end to end

const T0 = Date.UTC(2026, 5, 1);
const PROFILE_COUNT = 700;
const REWARD_COUNT = 900;
const HOP = 300;

function bigSnapshot(): Snapshot {
  const profiles: ProfileRow[] = [];
  for (let i = 0; i < PROFILE_COUNT; i++) {
    profiles.push([
      `User${i}`,
      i % 10 === 3 ? -i : i,
      i % 7 === 0 ? 100 + i : 0,
      i % 4 === 0 ? [['PC', `gt${i}`, String(i)]] : [],
    ]);
  }
  const rewards: RewardRow[] = [];
  for (let r = 0; r < REWARD_COUNT; r++) {
    rewards.push([
      `c${r}`,
      `p${r % 50}`,
      `User${(r * 7) % PROFILE_COUNT}`,
      `User${(r * 13 + 1) % PROFILE_COUNT}`,
      T0 + r * 1000,
    ]);
  }
  const set = (r: number, giver: string, receiver: string, post: string) => {
    rewards[r] = [`c${r}`, post, giver, receiver, T0 + r * 1000];
  };
  // The same pair on the same post, twice: inside a hop, and across hop boundaries.
  set(10, 'User20', 'User21', 'pdup0');
  set(20, 'User20', 'User21', 'pdup0');
  set(150, 'User30', 'User31', 'pdup1');
  set(250, 'user30', 'USER31', 'pdup1'); // the other side of the hop at row 900
  set(480, 'User40', 'User41', 'pdup2');
  set(520, 'User40', 'User41', 'pdup2'); // the other side of the hop at row 1200
  // A giver with no profile, and a self-reward.
  set(40, 'Ghost', 'User1', 'pghost');
  set(300, 'User5', 'User5', 'pself');
  return { newestMs: T0 + (REWARD_COUNT - 1) * 1000, profiles, rewards };
}

async function runImport(snapshot: Snapshot, store: Store, hop = HOP) {
  let hops = 0;
  for (;;) {
    const result = await importHop(snapshot, store, hop);
    hops++;
    if (result.done) return hops;
  }
}

/** Everything the import wrote, in a comparable form. */
async function dump(redis: FakeRedis, snapshot: Snapshot) {
  const hash = async (key: string) =>
    (await redis.hScan(key, 0)).fieldValues
      .map((row) => `${row.field}=${row.value}`)
      .sort();
  const zset = async (key: string) =>
    (await redis.zRange(key, 0, -1, { by: 'rank' })).map(
      (row) => `${row.score}:${row.member}`
    );
  const users = new Set(snapshot.rewards.flatMap((row) => [row[2], row[3]]));
  for (const row of snapshot.profiles) users.add(row[0]);
  const histories: Record<string, string[]> = {};
  for (const user of [...users].map((u) => u.toLowerCase()).sort())
    histories[user] = await zset(`history:${user}`);
  return {
    karma: await hash('karma'),
    profiles: await hash('profiles'),
    rewards: await hash('rewards'),
    events: await zset('events'),
    histories,
  };
}

test('a generated snapshot imports in hops of 300 into the real store', async () => {
  const snapshot = bigSnapshot();
  // The generated data passes the same check the real file does.
  parseSnapshot(JSON.stringify(snapshot));

  const redis = new FakeRedis(() => T0);
  const store = new Store(redis, () => T0);
  const hops = await runImport(snapshot, store);
  assert.equal(hops, Math.ceil((PROFILE_COUNT + REWARD_COUNT) / HOP));
  assert.deepEqual(await store.importProgress(), {
    rows: PROFILE_COUNT + REWARD_COUNT,
    done: true,
  });

  // Karma, Market76 karma and gamertags of every profile, negative ones included.
  for (const row of snapshot.profiles) {
    assert.deepEqual(
      await store.loadProfile(row[0]),
      profileFromRow(row),
      row[0]
    );
  }
  assert.equal((await store.loadProfile('User13')).karma, -13);
  assert.equal((await store.loadProfile('user4')).gamertags[0]?.userId, '4');

  // The events set holds every reward, duplicates included, oldest first.
  const events = await store.eventsSince(0, 10_000);
  assert.equal(events.length, REWARD_COUNT);
  assert.deepEqual(
    events.map((event) => event.commentId),
    snapshot.rewards.map((row) => `t1_${row[0]}`)
  );
  assert.ok(events.every((event) => event.sign === 0));
  assert.equal(
    (await store.eventsSince(T0 + 800 * 1000, 10_000)).length,
    100,
    'a delta since the 800th reward'
  );
  assert.equal((await store.eventsSince(T0, 10)).length, 10);

  // The pair index keeps the last comment of a duplicate pair, however the hops fell.
  const pair = (post: string, giver: string, receiver: string) =>
    store.earlierReward(post, giver, receiver);
  assert.equal(await pair('t3_pdup0', 'User20', 'User21'), 't1_c20');
  assert.equal(await pair('t3_pdup1', 'User30', 'User31'), 't1_c250');
  assert.equal(await pair('t3_pdup2', 'user40', 'user41'), 't1_c520');
  assert.equal(await pair('t3_pself', 'User5', 'User5'), 't1_c300');
  assert.equal(await pair('t3_pghost', 'Ghost', 'User1'), 't1_c40');

  // The history keeps both comments of a duplicate pair.
  const history = async (user: string) =>
    store.history(user, { limit: 10_000 });
  const comments = async (user: string) =>
    (await history(user)).map((entry) =>
      entry.kind === 'reward' ? entry.commentId : entry.kind
    );
  assert.deepEqual(
    (await comments('User21')).filter(
      (id) => id === 't1_c20' || id === 't1_c10'
    ),
    ['t1_c20', 't1_c10']
  );
  const user31 = await comments('User31');
  assert.ok(user31.includes('t1_c150'));
  assert.ok(user31.includes('t1_c250'));

  // A giver with no profile still has a history, and no karma.
  assert.deepEqual(await comments('Ghost'), ['t1_c40']);
  assert.equal((await store.loadProfile('Ghost')).karma, 0);

  // A self-reward is one history entry, not two.
  const self = (await comments('User5')).filter((id) => id === 't1_c300');
  assert.equal(self.length, 1);

  // Every history has one entry per reward the user is in, counted from the data.
  const expected = new Map<string, number>();
  for (const [, , giver, receiver] of snapshot.rewards) {
    const g = giver.toLowerCase();
    const rec = receiver.toLowerCase();
    expected.set(g, (expected.get(g) ?? 0) + 1);
    if (rec !== g) expected.set(rec, (expected.get(rec) ?? 0) + 1);
  }
  let total = 0;
  for (const [user, count] of expected) {
    assert.equal((await history(user)).length, count, user);
    total += count;
  }
  assert.ok(total > REWARD_COUNT, 'most rewards are in two histories');
});

test('running the whole import a second time changes nothing', async () => {
  const snapshot = bigSnapshot();
  const redis = new FakeRedis(() => T0);
  const store = new Store(redis, () => T0);
  await runImport(snapshot, store);
  const first = await dump(redis, snapshot);
  assert.equal(first.events.length, REWARD_COUNT);

  // A second run starts again from the top, here with a different hop size.
  await store.setImportProgress({ rows: 0, done: false });
  await runImport(snapshot, store, 450);
  assert.deepEqual(await dump(redis, snapshot), first);

  // And a finished import sends nothing at all.
  await importHop(snapshot, store, HOP);
  assert.deepEqual(await dump(redis, snapshot), first);
});

test('dailyCountsFrom groups by lowercased giver and UTC day, across midnight', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const reward = (giver: string, atMs: number): ImportedReward => ({
    commentId: 't1_x',
    postId: 't3_y',
    giver,
    receiver: 'Z',
    sign: 0,
    atMs,
  });
  const counts = dailyCountsFrom(
    [
      reward('Alice', Date.UTC(2026, 9, 4, 23, 59, 59)),
      reward('ALICE', Date.UTC(2026, 9, 4, 0, 0, 0)),
      reward('alice', Date.UTC(2026, 9, 5, 0, 0, 0)),
      reward('Bob', Date.UTC(2026, 9, 4, 12)),
    ],
    day
  );
  assert.deepEqual([...counts].sort(), [
    ['alice|2026-10-04', 2],
    ['alice|2026-10-05', 1],
    ['bob|2026-10-04', 1],
  ]);
  assert.equal(dailyCountsFrom([], day).size, 0);
});
