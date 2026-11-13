// Runs scripts/compact-export.mjs on a small export shaped like the real Mongo
// export, and reads the result with the app's own parser.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSnapshot, profileFromRow, rewardFromRow } from './import';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/compact-export.mjs', import.meta.url)
);
const root = mkdtempSync(join(tmpdir(), 'compact-export-'));
after(() => rmSync(root, { recursive: true, force: true }));

type UserDoc = {
  _id: { $oid: string };
  reddit_username: string;
  karma: number;
  m76_karma: number;
  gamertags: {
    gamertag: string;
    gamertag_id: string | number;
    platform: string;
  }[];
};

let counter = 0;
const oid = () => ({ $oid: String(++counter).padStart(24, '0') });

function user(
  name: string,
  karma: number,
  m76: number,
  gamertags: UserDoc['gamertags'] = []
): UserDoc {
  return {
    _id: oid(),
    reddit_username: name,
    karma,
    m76_karma: m76,
    gamertags,
  };
}

function log(
  from: string,
  to: string,
  post: string,
  comment: string,
  seconds: number
) {
  return {
    _id: oid(),
    from_user: from,
    to_user: to,
    submission_id: post,
    comment_permalink: `/r/Fallout76Marketplace/comments/${post.replace('t3_', '')}/some_title_slug/${comment}/`,
    utc_created: seconds,
  };
}

const USERS: UserDoc[] = [
  user('Alice', 5, 2, [
    { gamertag: 'AliceX', gamertag_id: '99', platform: 'XBOX' },
    { gamertag: 'ali_pc', gamertag_id: 0, platform: 'PC' },
  ]),
  user('Bob', 3, 0),
  user('Carol', 0, 4),
  user('Dan', 0, 0),
  user('Eve', -2, 0),
  user('Zero', 0, 0),
  user('Frank', 9, 0),
  user('IcarusLex', 0, 0),
  user('icaruslex', 7, 0),
  user('dup2', 0, 0),
  user('Dup2', 4, 0),
  user('Tagonly', 0, 0, [
    { gamertag: 'only_tag', gamertag_id: 0, platform: 'PlayStation' },
  ]),
];

const LOGS = [
  log('Alice', 'Bob', 'p1', 'cmtA', 1000),
  log('Bob', 'Carol', 'p2', 'cmtB', 500),
  log('Eve', 'Dan', 't3_p3', 'cmtC', 2000),
];

function writeExport(users: UserDoc[], logs: unknown[]): string {
  const dir = mkdtempSync(join(root, 'export-'));
  writeFileSync(
    join(dir, 'fallout76marketplace_karma_db.user_karma.json'),
    JSON.stringify(users)
  );
  writeFileSync(
    join(dir, 'fallout76marketplace_karma_db.karma_logs.json'),
    JSON.stringify(logs)
  );
  return dir;
}

function run(dir: string, args: string[] = []) {
  const out = join(mkdtempSync(join(root, 'out-')), 'snapshot.json');
  const stdout = execFileSync(process.execPath, [SCRIPT, dir, out, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const snapshot = parseSnapshot(readFileSync(out, 'utf8'));
  return { snapshot, out, stdout };
}

const names = (snapshot: ReturnType<typeof parseSnapshot>) =>
  snapshot.profiles.map((row) => row[0]).sort();

const dir = writeExport(USERS, LOGS);

test('a full snapshot parses with the app parser and maps with profileFromRow', () => {
  const { snapshot } = run(dir);
  const alice = snapshot.profiles.find((row) => row[0] === 'Alice');
  assert.ok(alice);
  assert.deepEqual(profileFromRow(alice), {
    redditUsername: 'Alice',
    karma: 5,
    m76Karma: 2,
    gamertags: [
      { platform: 'XBOX', username: 'AliceX', userId: '99' },
      { platform: 'PC', username: 'ali_pc', userId: '0' },
    ],
  });
  for (const row of snapshot.profiles) {
    for (const [platform, name, id] of row[3]) {
      assert.equal(typeof name, 'string', `${row[0]} ${platform}`);
      assert.equal(typeof id, 'string', `${row[0]} ${platform}`);
      assert.notEqual(name, 'null');
      assert.notEqual(id, 'undefined');
    }
  }
});

test('a full snapshot skips profiles that are all zero with no gamertags', () => {
  const { snapshot } = run(dir);
  const found = names(snapshot);
  assert.ok(!found.includes('Zero'));
  assert.ok(!found.includes('Dan'));
  assert.ok(found.includes('Carol'), 'Market76 karma alone is data');
  assert.ok(found.includes('Eve'), 'negative karma is data');
  assert.ok(found.includes('Tagonly'), 'a gamertag alone is data');
});

test('of two profiles that differ only in case, the one with data wins', () => {
  const { snapshot } = run(dir);
  const icarus = snapshot.profiles.filter(
    (row) => row[0].toLowerCase() === 'icaruslex'
  );
  assert.deepEqual(icarus, [['icaruslex', 7, 0, []]]);
  const dup = snapshot.profiles.filter(
    (row) => row[0].toLowerCase() === 'dup2'
  );
  assert.deepEqual(dup, [['Dup2', 4, 0, []]]);
});

test('rewards are sorted by time with bare ids and times in milliseconds', () => {
  const { snapshot } = run(dir);
  assert.deepEqual(snapshot.rewards, [
    ['cmtB', 'p2', 'Bob', 'Carol', 500_000],
    ['cmtA', 'p1', 'Alice', 'Bob', 1_000_000],
    ['cmtC', 'p3', 'Eve', 'Dan', 2_000_000],
  ]);
  assert.equal(snapshot.newestMs, 2_000_000);
  const reward = rewardFromRow(snapshot.rewards[1]!);
  assert.equal(reward.commentId, 't1_cmtA');
  assert.equal(reward.postId, 't3_p1');
});

test('an export with no rewards has newestMs 0', () => {
  const { snapshot, stdout } = run(writeExport(USERS, []));
  assert.equal(snapshot.newestMs, 0);
  assert.deepEqual(snapshot.rewards, []);
  assert.match(stdout, /rewards 0/);
});

test('the script prints the row total the import will report', () => {
  const { snapshot, stdout } = run(dir);
  assert.match(
    stdout,
    new RegExp(`rows ${snapshot.profiles.length + snapshot.rewards.length} `)
  );
});

test('--since keeps only later rewards and the profiles of the users in them, even an all-zero one', () => {
  const { snapshot } = run(dir, ['--since', '1000000']);
  assert.deepEqual(snapshot.rewards, [['cmtC', 'p3', 'Eve', 'Dan', 2_000_000]]);
  assert.equal(snapshot.newestMs, 2_000_000);
  assert.deepEqual(names(snapshot), ['Dan', 'Eve']);
  const dan = snapshot.profiles.find((row) => row[0] === 'Dan');
  assert.deepEqual(
    dan,
    ['Dan', 0, 0, []],
    'the zero profile may replace a non-zero one'
  );
});

test('--since takes an ISO time too, and a later time than every reward gives an empty delta', () => {
  const iso = run(dir, ['--since', '1970-01-01T00:16:40Z']);
  assert.deepEqual(
    iso.snapshot.rewards.map((row) => row[0]),
    ['cmtC']
  );
  const none = run(dir, ['--since', '3000000']);
  assert.deepEqual(none.snapshot.rewards, []);
  assert.deepEqual(none.snapshot.profiles, []);
  assert.equal(none.snapshot.newestMs, 0);
});

test('--since with --base also includes a profile that differs from the base, and not one that is unchanged', () => {
  const full = run(dir);

  // Since the base: Bob was edited by hand, Frank was zeroed, Newbie is new, and
  // Zero is still empty. Nobody else changed.
  const later = USERS.map((doc) => {
    if (doc.reddit_username === 'Bob') return { ...doc, karma: 4 };
    if (doc.reddit_username === 'Frank') return { ...doc, karma: 0 };
    return doc;
  });
  later.push(user('Newbie', 1, 0));
  const laterDir = writeExport(later, LOGS);

  const withoutBase = run(laterDir, ['--since', '1000000']);
  assert.deepEqual(names(withoutBase.snapshot), ['Dan', 'Eve']);

  const delta = run(laterDir, ['--since', '1000000', '--base', full.out]);
  assert.deepEqual(names(delta.snapshot), [
    'Bob',
    'Dan',
    'Eve',
    'Frank',
    'Newbie',
  ]);
  assert.deepEqual(
    delta.snapshot.profiles.find((row) => row[0] === 'Bob'),
    ['Bob', 4, 0, []]
  );
  assert.deepEqual(
    delta.snapshot.profiles.find((row) => row[0] === 'Frank'),
    ['Frank', 0, 0, []]
  );
  for (const unchanged of [
    'Alice',
    'Carol',
    'Zero',
    'Tagonly',
    'icaruslex',
    'Dup2',
  ]) {
    assert.ok(!names(delta.snapshot).includes(unchanged), unchanged);
  }
});

test('--base without --since exits with an error', () => {
  const base = run(dir).out;
  const out = join(root, 'never.json');
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, dir, out, '--base', base], {
        stdio: 'pipe',
      }),
    (error) => {
      const failure = error as { status?: number; stderr?: Buffer };
      assert.notEqual(failure.status, 0);
      assert.match(String(failure.stderr), /--base/);
      return true;
    }
  );
});

test('a gamertag with no name stops the script instead of writing nulls', () => {
  const broken = writeExport(
    [
      user('Alice', 1, 0, [
        {
          gamertag: undefined as unknown as string,
          gamertag_id: '1',
          platform: 'PC',
        },
      ]),
    ],
    []
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, broken, join(root, 'x.json')], {
        stdio: 'pipe',
      }),
    (error) => (error as { status?: number }).status !== 0
  );
});
