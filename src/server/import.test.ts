import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  currentImportSource,
  IMPORT_STALLED_MS,
  importNextBatch,
  importStatus,
  importStatusText,
  loadSnapshot,
  parsePastedSnapshot,
  parseSnapshot,
  profileFromRow,
  rewardFromRow,
  setTodaysCounts,
  startImport,
  type ImportStatus,
  type ProfileRow,
  type RewardRow,
  type Snapshot,
} from './import';
import { Store } from './store';
import { FakeReddit } from './testing/fake-reddit';
import { FakeRedis, historyOf } from './testing/fake-redis';
import type { ImportedReward, Profile } from './types';

type Batch = { profiles: Profile[]; rewards: ImportedReward[] };

/** A stand-in for the store's import methods that records each batch, and can fail the first. */
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

  const small = {
    newestMs: 5000,
    profiles: [['Alice', 3, 1, [['PC', 'alice_pc', '123']]]],
    rewards: [['kx88385', '1bqgyt1', 'Alice', 'Bob', 5000]],
  };
  assert.deepEqual(parseSnapshot(JSON.stringify(small)), small);
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

const withProfiles = (profiles: unknown[]) =>
  JSON.stringify({ newestMs: 0, profiles, rewards: [] });

test('parseSnapshot rejects a bad gamertag row, naming the profile row', () => {
  assert.throws(
    () =>
      parseSnapshot(
        withProfiles([
          ['A', 0, 0, []],
          ['B', 0, 0, []],
          ['C', 1, 0, [['Switch', 'c', '1']]],
        ])
      ),
    /profile row 2 /,
    'an unknown platform'
  );
  // The shape the broken export script produced: the name and id were read from the wrong fields.
  assert.throws(
    () => parseSnapshot(withProfiles([['B', 1, 0, [['PC', null, 'x']]]])),
    /profile row 0 /
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

test('parsePastedSnapshot drops the markdown escapes of the reddit.com wiki editor', () => {
  const json = JSON.stringify(PASTED);
  const escaped = json.replace(/[[\]_]/g, (char) => `\\${char}`);
  assert.match(escaped, /^\{"newestMs":5000,"profiles":\\\[\\\["Alice"/);
  assert.deepEqual(parsePastedSnapshot(escaped), PASTED);
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

test('parsePastedSnapshot decodes &amp; in a gamertag, fenced or not', () => {
  const json = JSON.stringify(PASTED).replace('alice_pc', 'a&amp;b');
  for (const text of [json, '```\n' + json + '\n```']) {
    const snapshot = parsePastedSnapshot(text);
    assert.equal(snapshot.profiles[0]?.[3][0]?.[1], 'a&b', text);
  }
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

test('loadSnapshot reads the bundled file or a wiki page, and names a missing page', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set(
    'karma-delta',
    '```json\n' + JSON.stringify(PASTED) + '\n```'
  );
  assert.deepEqual(await loadSnapshot(reddit, 'bundled'), {
    newestMs: 0,
    profiles: [],
    rewards: [],
  });
  assert.deepEqual(await loadSnapshot(reddit, 'wiki:karma-delta'), PASTED);
  await assert.rejects(
    loadSnapshot(reddit, 'wiki:nothing'),
    /Wiki page nothing does not exist/
  );
});

test('profileFromRow converts gamertags', () => {
  assert.deepEqual(
    profileFromRow(['Alice', -3, 69420, [['XBOX', 'ax', '42']]]),
    {
      redditUsername: 'Alice',
      karma: -3,
      m76Karma: 69420,
      gamertags: [{ platform: 'XBOX', username: 'ax', userId: '42' }],
    }
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

test('importNextBatch loads 2,500 rows in batches of 1000, 1000 and 500, profiles first', async () => {
  const snapshot = snapshotOf(1200, 1300);
  const store = fakeStore();
  const next = () => importNextBatch(snapshot, store, 1000);

  assert.deepEqual(await next(), { rows: 1000, total: 2500, done: false });
  assert.deepEqual(await next(), { rows: 2000, total: 2500, done: false });
  assert.deepEqual(await next(), { rows: 2500, total: 2500, done: true });

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

  assert.deepEqual(await next(), { rows: 2500, total: 2500, done: true });
  assert.equal(store.batches.length, 3, 'a finished import sends nothing');
});

test('a batch that failed leaves the progress, and the same batch is sent again', async () => {
  const snapshot = snapshotOf(10, 20);
  const store = fakeStore(true);

  await assert.rejects(importNextBatch(snapshot, store), /store down/);
  assert.deepEqual(store.progress, { rows: 0, done: false });

  assert.deepEqual(await importNextBatch(snapshot, store), {
    rows: 30,
    total: 30,
    done: true,
  });
  assert.equal(store.batches.length, 1);
  assert.equal(store.batches[0]?.profiles.length, 10);

  // A repeat of a batch whose progress was not saved sends identical rows.
  const again = fakeStore();
  await importNextBatch(snapshot, again);
  assert.deepEqual(again.batches[0], store.batches[0]);
});

test('an empty snapshot is done after one batch', async () => {
  assert.deepEqual(await importNextBatch(snapshotOf(0, 0), fakeStore()), {
    rows: 0,
    total: 0,
    done: true,
  });
});

const T0 = Date.UTC(2026, 5, 1);
const PROFILE_COUNT = 700;
const REWARD_COUNT = 900;
const BATCH = 300;

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
  // The same pair on the same post, twice: inside a batch, and across batch boundaries.
  set(10, 'User20', 'User21', 'pdup0');
  set(20, 'User20', 'User21', 'pdup0');
  set(150, 'User30', 'User31', 'pdup1');
  set(250, 'user30', 'USER31', 'pdup1'); // the other side of the batch at row 900
  set(480, 'User40', 'User41', 'pdup2');
  set(520, 'User40', 'User41', 'pdup2'); // the other side of the batch at row 1200
  // A giver with no profile, and a self-reward.
  set(40, 'Ghost', 'User1', 'pghost');
  set(300, 'User5', 'User5', 'pself');
  return { newestMs: T0 + (REWARD_COUNT - 1) * 1000, profiles, rewards };
}

/** Runs the whole import, batch after batch, and returns the number of batches. */
async function runImport(snapshot: Snapshot, store: Store, batchRows = BATCH) {
  let batches = 0;
  for (;;) {
    const result = await importNextBatch(snapshot, store, batchRows);
    batches++;
    if (result.done) return batches;
  }
}

/** Everything the import wrote, in a comparable form. */
async function dump(redis: FakeRedis, snapshot: Snapshot) {
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
    karma: await redis.hGetAll('karma'),
    profiles: await redis.hGetAll('profiles'),
    rewards: await redis.hGetAll('rewards'),
    events: await zset('events'),
    histories,
  };
}

test('a generated snapshot imported in batches of 300 into the real store', async (t) => {
  const snapshot = bigSnapshot();
  // The generated data passes the same check the real file does.
  parseSnapshot(JSON.stringify(snapshot));

  const redis = new FakeRedis(() => T0);
  const store = new Store(redis, () => T0);
  const batches = await runImport(snapshot, store);
  const commentsOf = async (user: string) =>
    (await historyOf(redis, user)).map((entry) => entry.commentId);

  await t.test('finishes with every row loaded', async () => {
    assert.equal(batches, Math.ceil((PROFILE_COUNT + REWARD_COUNT) / BATCH));
    assert.deepEqual(await store.importProgress(), {
      rows: PROFILE_COUNT + REWARD_COUNT,
      done: true,
    });
  });

  await t.test('loads every profile, negative karma included', async () => {
    for (const row of snapshot.profiles) {
      assert.deepEqual(
        await store.loadProfile(row[0]),
        profileFromRow(row),
        row[0]
      );
    }
    assert.equal((await store.loadProfile('User13')).karma, -13);
    assert.equal((await store.loadProfile('user4')).gamertags[0]?.userId, '4');
  });

  await t.test('puts every reward in the events, oldest first', async () => {
    const events = await store.eventsSince(0, 10_000);
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
  });

  await t.test(
    'keeps the last comment of a duplicate pair in the index, however the batches fell',
    async () => {
      const pair = (post: string, giver: string, receiver: string) =>
        store.earlierReward(post, giver, receiver);
      assert.equal(await pair('t3_pdup0', 'User20', 'User21'), 't1_c20');
      assert.equal(await pair('t3_pdup1', 'User30', 'User31'), 't1_c250');
      assert.equal(await pair('t3_pdup2', 'user40', 'user41'), 't1_c520');
      assert.equal(await pair('t3_pself', 'User5', 'User5'), 't1_c300');
      assert.equal(await pair('t3_pghost', 'Ghost', 'User1'), 't1_c40');
    }
  );

  await t.test(
    'keeps both comments of a duplicate pair in the history',
    async () => {
      const user21 = await commentsOf('User21');
      assert.ok(user21.includes('t1_c10') && user21.includes('t1_c20'));
      const user31 = await commentsOf('User31');
      assert.ok(user31.includes('t1_c150') && user31.includes('t1_c250'));
    }
  );

  await t.test(
    'gives a giver with no profile a history and no karma, and a self-reward one entry',
    async () => {
      assert.deepEqual(await commentsOf('Ghost'), ['t1_c40']);
      assert.equal((await store.loadProfile('Ghost')).karma, 0);
      const self = (await commentsOf('User5')).filter((id) => id === 't1_c300');
      assert.equal(self.length, 1);
    }
  );

  await t.test('writes one history entry per reward a user is in', async () => {
    const expected = new Map<string, number>();
    for (const [, , giver, receiver] of snapshot.rewards) {
      const g = giver.toLowerCase();
      const r = receiver.toLowerCase();
      expected.set(g, (expected.get(g) ?? 0) + 1);
      if (r !== g) expected.set(r, (expected.get(r) ?? 0) + 1);
    }
    for (const [user, count] of expected)
      assert.equal((await historyOf(redis, user)).length, count, user);
  });
});

test('running the whole import a second time changes nothing', async () => {
  const snapshot = bigSnapshot();
  const redis = new FakeRedis(() => T0);
  const store = new Store(redis, () => T0);
  await runImport(snapshot, store);
  const first = await dump(redis, snapshot);
  assert.equal(first.events.length, REWARD_COUNT);

  // A second run starts again from the top, here with a different batch size.
  await store.setImportProgress({ rows: 0, done: false });
  await runImport(snapshot, store, 450);
  assert.deepEqual(await dump(redis, snapshot), first);

  // And a finished import sends nothing at all.
  await importNextBatch(snapshot, store);
  assert.deepEqual(await dump(redis, snapshot), first);
});

test("setTodaysCounts sets each giver's count from today's rewards only", async () => {
  const now = Date.UTC(2026, 9, 5, 12);
  const store = new Store(new FakeRedis(() => now), () => now);
  const reward = (commentId: string, giver: string, atMs: number) => ({
    commentId,
    postId: 't3_p',
    giver,
    receiver: 'Z',
    sign: 0 as const,
    atMs,
  });
  await store.importBatch({
    profiles: [],
    rewards: [
      reward('c1', 'Alice', Date.UTC(2026, 9, 4, 23, 59, 59)),
      reward('c2', 'Alice', Date.UTC(2026, 9, 5, 0, 0, 0)),
      reward('c3', 'ALICE', Date.UTC(2026, 9, 5, 11)),
      reward('c4', 'Bob', Date.UTC(2026, 9, 5, 1)),
    ],
  });

  await setTodaysCounts(store, now);

  assert.equal(await store.givenToday('alice', '2026-10-05'), 2);
  assert.equal(await store.givenToday('Bob', '2026-10-05'), 1);
  assert.equal(await store.givenToday('Alice', '2026-10-04'), 0);
});

test('startImport resumes the same unfinished source and restarts a new or finished one', async () => {
  const store = new Store(new FakeRedis());
  const first = await startImport(store, 'bundled', 100, false);
  assert.ok(first);
  assert.equal(await currentImportSource(store, first), 'bundled');
  await store.setImportProgress({ rows: 40, done: false });

  const resumed = await startImport(store, 'bundled', 100, false);
  assert.equal(
    await currentImportSource(store, first),
    undefined,
    'the older chain stops'
  );
  assert.equal(await currentImportSource(store, resumed), 'bundled');
  assert.deepEqual(await store.importProgress(), { rows: 40, done: false });
  assert.equal((await importStatus(store))?.rows, 40);

  await startImport(store, 'wiki:delta', 10, false);
  assert.deepEqual(await store.importProgress(), { rows: 0, done: false });

  await store.setImportProgress({ rows: 10, done: true });
  assert.equal(
    await startImport(store, 'wiki:delta', 10, false),
    undefined,
    'a finished source runs again only when asked'
  );
  assert.deepEqual(await store.importProgress(), { rows: 10, done: true });
  assert.ok(await startImport(store, 'wiki:delta', 10, true));
  assert.deepEqual(await store.importProgress(), { rows: 0, done: false });
});

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

test('importStatusText for no import and a running one, STALLED once it stops advancing', () => {
  assert.equal(
    importStatusText(undefined, NOW),
    'No import has run on this install.'
  );
  const running = importStatusText(status(), NOW);
  assert.match(running, /An import is running/);
  assert.match(running, /1000 of 5000 rows from bundled/);
  assert.doesNotMatch(running, /STALLED/);

  assert.doesNotMatch(
    importStatusText(status({ atMs: NOW - IMPORT_STALLED_MS }), NOW),
    /STALLED/
  );
  const stalled = importStatusText(
    status({ atMs: NOW - IMPORT_STALLED_MS - 1 }),
    NOW
  );
  assert.match(stalled, /STALLED at 1000 of 5000 rows/);
});

test('importStatusText for done, failed and stopped', () => {
  const old = NOW - 10 * IMPORT_STALLED_MS;
  const text = (overrides: Partial<ImportStatus>) =>
    importStatusText(status({ atMs: old, ...overrides }), NOW);
  assert.match(text({ state: 'done', rows: 5000 }), /finished, 5000 of 5000/);
  assert.match(
    text({ state: 'failed', error: 'store down' }),
    /FAILED .*: store down/
  );
  assert.match(text({ state: 'stopped' }), /stopped .*because Enabled/);
});
