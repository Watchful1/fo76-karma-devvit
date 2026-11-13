import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleCommand, type CommandSource, type Outcome } from './karma';
import { Store } from './store';
import { FakeRedis } from './testing/fake-redis';
import { FakeReddit } from './testing/fake-reddit';
import type { AlertPort, CommentInfo, Config, Ports, PostInfo } from './types';

const T0 = 1_800_000_000_000;
const DAY = '2027-01-15';
const DISCLAIMER = 'https://example.test/disclaimer';
const COURIER_PAGE = 'custom_bot_config/courier_list';

const CONFIG: Config = {
  enabled: true,
  dailyCap: 10,
  tradingFlairs: ['XBOX', 'PlayStation', 'PC'],
  templates: {
    modsAndCouriers: 'mods',
    tier0: 't0',
    tier50: 't50',
    tier100: 't100',
    tradeClosed: 'closed',
  },
  courierPage: COURIER_PAGE,
  webhookUrl: '',
  disclaimerUrl: DISCLAIMER,
};

function post(id: string, overrides: Partial<PostInfo> = {}): PostInfo {
  return {
    id,
    authorName: 'OP',
    flairText: 'PC',
    removed: false,
    locked: false,
    permalink: `/r/fo76/comments/${id.replace('t3_', '')}/`,
    ...overrides,
  };
}

function setup(configOverrides: Partial<Config> = {}) {
  const clock = { now: T0 };
  const reddit = new FakeReddit();
  const store = new Store(new FakeRedis(() => clock.now), () => clock.now);
  const alertMessages: string[] = [];
  const alerts: AlertPort = {
    async send(message) {
      alertMessages.push(message);
    },
  };
  const log: string[] = [];
  const config: Config = { ...CONFIG, ...configOverrides };
  const ports: Ports = {
    reddit,
    store,
    alerts,
    config,
    subredditName: 'fo76',
    now: () => clock.now,
    log: (message) => log.push(message),
  };

  reddit.addPost(post('t3_p1'));
  reddit.addComment(comment('t1_c1', 'Trader', 'I have it'));

  /** Adds a command comment and returns its id. */
  function command(
    id: string,
    author: string | undefined,
    body: string,
    overrides: Partial<CommentInfo> = {}
  ): string {
    reddit.addComment(comment(id, author, body, overrides));
    return id;
  }

  function run(
    commentId: string,
    source: CommandSource = 'create'
  ): Promise<Outcome> {
    return handleCommand({ commentId, source }, ports);
  }

  return {
    clock,
    reddit,
    store,
    alertMessages,
    log,
    config,
    ports,
    command,
    run,
  };
}

function comment(
  id: string,
  authorName: string | undefined,
  body: string,
  overrides: Partial<CommentInfo> = {}
): CommentInfo {
  return {
    id,
    authorName,
    body,
    parentId: 't3_p1',
    postId: 't3_p1',
    removed: false,
    permalink: `/r/fo76/comments/p1/_/${id.replace('t1_', '')}/`,
    ...overrides,
  };
}

function assertFooter(text: string): void {
  assert.ok(text.includes('performed by a bot'), text);
  assert.ok(text.endsWith(`[See disclaimer](${DISCLAIMER}))`), text);
}

/** OP replies "+karma" to Trader's comment. */
function opRewards(
  s: ReturnType<typeof setup>,
  id = 't1_cmd',
  parentId = 't1_c1'
): string {
  return s.command(id, 'OP', '+karma', { parentId });
}

test('OP rewarding Trader gives a point, a flair, a reply and records it', async () => {
  const s = setup();
  const id = opRewards(s);

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 't0' },
  ]);
  assert.equal(s.reddit.replies.length, 1);
  const [sent] = s.reddit.replies;
  assert.deepEqual(sent?.target, { kind: 'comment', id });
  assert.ok(sent?.text.includes('u/OP'));
  assert.ok(sent?.text.includes('u/Trader'));
  assertFooter(sent?.text ?? '');
  assert.equal(await s.store.earlierReward('t3_p1', 'OP', 'Trader'), id);
  assert.equal(await s.store.givenToday('OP', DAY), 1);
  const given = await s.store.history('OP', { limit: 10 });
  const received = await s.store.history('Trader', { limit: 10 });
  assert.equal(given.length, 1);
  assert.equal(received.length, 1);
  assert.equal(given[0]?.kind, 'reward');
  assert.equal(await s.store.claim(id), 'done');
});

test('a body from the payload that is not a command makes no Reddit calls', async () => {
  const s = setup();
  const outcome = await handleCommand(
    { commentId: 't1_c1', source: 'create', body: 'hello' },
    s.ports
  );
  assert.equal(outcome, 'not-a-command');
  assert.equal(s.reddit.calls, 0);
});

test('a fetched body that is not a command is not a command', async () => {
  const s = setup();
  assert.equal(await s.run('t1_c1'), 'not-a-command');
  assert.equal(s.reddit.replies.length, 0);
});

test('a command is disabled for a create event but a rerun still runs', async () => {
  const s = setup({ enabled: false });
  const id = opRewards(s);
  assert.equal(await s.run(id, 'create'), 'disabled');
  assert.equal(await s.run(id, 'approve'), 'disabled');
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

for (const author of ['fo76-karma-dev', 'AutoModerator']) {
  test(`a command by ${author} is skipped`, async () => {
    const s = setup();
    const id = s.command('t1_bot', author, '+karma', { parentId: 't1_c1' });
    assert.equal(await s.run(id), 'skipped');
    assert.equal(s.reddit.replies.length, 0);
    assert.equal((await s.store.loadProfile('Trader')).karma, 0);
  });
}

test('a comment whose author is deleted is skipped', async () => {
  const s = setup();
  const id = s.command('t1_gone', undefined, '+karma', { parentId: 't1_c1' });
  assert.equal(await s.run(id), 'skipped');
});

test('a second run of the same command gives no second point or reply', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.run(id), 'already-handled');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('rewarding the same person again in the same post is refused with a link to the first', async () => {
  const s = setup();
  const first = opRewards(s, 't1_cmd1');
  const second = opRewards(s, 't1_cmd2');
  assert.equal(await s.run(first), 'rewarded');

  assert.equal(await s.run(second), 'refused');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 2);
  const refusal = s.reddit.replies[1];
  assert.deepEqual(refusal?.target, { kind: 'comment', id: second });
  assert.ok(refusal?.text.includes('already rewarded Trader'));
  assert.ok(
    refusal?.text.includes('https://www.reddit.com/r/fo76/comments/p1/_/cmd1/')
  );
  assertFooter(refusal?.text ?? '');
  assert.equal(await s.store.earlierReward('t3_p1', 'OP', 'Trader'), first);
});

type RefusalCase = {
  reason: string;
  expectText: string;
  seed?: (s: ReturnType<typeof setup>) => Promise<void>;
  arrange: (s: ReturnType<typeof setup>) => string;
};

const refusals: RefusalCase[] = [
  {
    reason: 'unauthorized (-karma by a non-moderator)',
    expectText: 'only be subtracted by moderators',
    arrange: (s) => s.command('t1_cmd', 'OP', '-karma', { parentId: 't1_c1' }),
  },
  {
    reason: 'wrong post type',
    expectText: 'under a trading post',
    arrange: (s) => {
      s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
      s.command('t1_d1', 'Trader', 'hi', {
        parentId: 't3_p2',
        postId: 't3_p2',
      });
      return s.command('t1_cmd', 'OP', '+karma', {
        parentId: 't1_d1',
        postId: 't3_p2',
      });
    },
  },
  {
    reason: 'self',
    expectText: 'cannot reward yourself',
    arrange: (s) => {
      s.command('t1_own', 'OP', 'mine');
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_own' });
    },
  },
  {
    reason: 'top-level',
    expectText: 'you need to reply to a comment',
    arrange: (s) =>
      s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' }),
  },
  {
    reason: 'parent comment removed',
    expectText: 'is gone',
    arrange: (s) => {
      s.command('t1_rm', 'Trader', 'gone', { removed: true });
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_rm' });
    },
  },
  {
    reason: 'parent author deleted',
    expectText: 'is gone',
    arrange: (s) => {
      s.command('t1_del', undefined, 'gone');
      return s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_del' });
    },
  },
  {
    reason: 'post removed',
    expectText: 'deleted their submission',
    arrange: (s) => {
      s.reddit.addPost(post('t3_p3', { removed: true }));
      s.command('t1_r1', 'Trader', 'hi', {
        parentId: 't3_p3',
        postId: 't3_p3',
      });
      return s.command('t1_cmd', 'OP', '+karma', {
        parentId: 't1_r1',
        postId: 't3_p3',
      });
    },
  },
  {
    reason: 'too many users',
    expectText: "someone else's submission",
    arrange: (s) =>
      s.command('t1_cmd', 'Other', '+karma', { parentId: 't1_c1' }),
  },
  {
    reason: 'daily cap reached',
    expectText: 'karma reward limit',
    seed: (s) => s.store.setGivenToday('OP', DAY, 10),
    arrange: (s) => s.command('t1_cmd', 'OP', '+karma', { parentId: 't1_c1' }),
  },
];

for (const { reason, expectText, seed, arrange } of refusals) {
  test(`refusal: ${reason}`, async () => {
    const s = setup();
    await seed?.(s);
    const id = arrange(s);

    assert.equal(await s.run(id), 'refused');

    assert.equal(s.reddit.replies.length, 1);
    const [sent] = s.reddit.replies;
    assert.deepEqual(sent?.target, { kind: 'comment', id });
    assert.ok(sent?.text.includes(expectText), sent?.text);
    assertFooter(sent?.text ?? '');
    assert.equal(s.reddit.flairs.length, 0);
    assert.equal((await s.store.loadProfile('Trader')).karma, 0);
    assert.equal(await s.store.claim(id), 'done');
  });
}

test('a refusal that greets the giver names the giver', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' });
  await s.run(id);
  assert.ok(s.reddit.replies[0]?.text.startsWith('Hi u/Trader!'));
});

test('a removed command comment is ignored without a reply and can run once approved', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '+karma', {
    parentId: 't1_c1',
    removed: true,
  });

  assert.equal(await s.run(id), 'ignored');
  assert.equal(s.reddit.replies.length, 0);
  assert.equal((await s.store.loadProfile('Trader')).karma, 0);

  s.reddit.addComment(
    comment(id, 'OP', '+karma', { parentId: 't1_c1', removed: false })
  );
  assert.equal(await s.run(id, 'approve'), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('a moderator skips the checks: a top-level +karma goes to the post author', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't3_p1' });

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('OP')).karma, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'comment', id });
  assert.equal(s.reddit.flairs[0]?.username, 'OP');
});

test('a moderator may give karma under a post with a non-trading flair', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
  s.command('t1_d1', 'Trader', 'hi', { parentId: 't3_p2', postId: 't3_p2' });
  const id = s.command('t1_cmd', 'Mod', '+karma', {
    parentId: 't1_d1',
    postId: 't3_p2',
  });
  assert.equal(await s.run(id), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

test('-karma by a moderator takes a point', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '-karma', { parentId: 't1_c1' });

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, -1);
  assert.equal(s.reddit.flairs[0]?.text, 'Karma: -1');
  assert.equal(s.reddit.flairs[0]?.templateId, 't0');
  assert.ok(s.reddit.replies[0]?.text.includes('decremented'));
  assertFooter(s.reddit.replies[0]?.text ?? '');
});

test('a moderator repeating the same pair records again', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const first = s.command('t1_cmd1', 'Mod', '+karma', { parentId: 't1_c1' });
  const second = s.command('t1_cmd2', 'Mod', '+karma', { parentId: 't1_c1' });
  assert.equal(await s.run(first), 'rewarded');
  assert.equal(await s.run(second), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 2);
  assert.equal(s.reddit.replies.length, 2);
});

test('a moderator +karma on a deleted user comment is refused as removed, with a reply', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  s.command('t1_del', undefined, 'gone');
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_del' });

  assert.equal(await s.run(id), 'refused');

  assert.equal(s.reddit.replies.length, 1);
  assert.ok(s.reddit.replies[0]?.text.includes('is gone'));
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'comment', id });
  assert.equal(s.reddit.flairs.length, 0);
  assert.equal(await s.store.claim(id), 'done');
});

test('a courier as a third party passes the two-party check', async () => {
  const s = setup();
  s.reddit.wiki.set(COURIER_PAGE, 'couriers:\n  - Courier\n');
  const id = s.command('t1_cmd', 'Courier', '+karma', { parentId: 't1_c1' });

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.flairs[0]?.templateId, 't0');
});

test('a reply that fails on the comment falls back to the post', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNextReplyTo(id);

  assert.equal(await s.run(id), 'rewarded');

  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'post', id: 't3_p1' });
  assertFooter(s.reddit.replies[0]?.text ?? '');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

/** Makes every reply fail until the returned function is called. */
function breakReplies(s: ReturnType<typeof setup>): () => void {
  const original = s.reddit.replyLocked.bind(s.reddit);
  s.reddit.replyLocked = async () => {
    throw new Error('reddit down');
  };
  return () => {
    s.reddit.replyLocked = original;
  };
}

const IN_FLIGHT_PASSED = 46 * 1000;

test('a command resumed after the transaction sends the reply and gives no second point', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.store.claim(id), 'claimed');
  await s.store.recordReward(
    {
      commentId: id,
      postId: 't3_p1',
      giver: 'OP',
      receiver: 'Trader',
      sign: 1,
      atMs: T0,
    },
    { enforceLimits: true, dayKey: DAY, dailyCap: 10 }
  );
  assert.equal(await s.run(id), 'already-handled', 'the attempt is in flight');

  s.clock.now += IN_FLIGHT_PASSED;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
  assert.equal(await s.store.claim(id), 'done');
  assert.equal(await s.run(id), 'already-handled');
});

test('a moderator command resumed after the transaction gives no second point', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_c1' });
  assert.equal(await s.store.claim(id), 'claimed');
  await s.store.recordReward(
    {
      commentId: id,
      postId: 't3_p1',
      giver: 'Mod',
      receiver: 'Trader',
      sign: 1,
      atMs: T0,
    },
    { enforceLimits: false, dayKey: DAY, dailyCap: 10 }
  );
  s.clock.now += IN_FLIGHT_PASSED;

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
  assert.equal(await s.store.claim(id), 'done');
});

test('a flair failure after the point is alerted and the reply and finish still happen', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('setUserFlair');

  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 0);
  assert.equal(s.alertMessages.length, 1);
  assert.ok(
    s.alertMessages[0]?.includes(
      'https://www.reddit.com/r/fo76/comments/p1/_/cmd/'
    )
  );
  assert.ok(s.alertMessages[0]?.includes('setUserFlair failed'));
  assert.equal(await s.run(id), 'already-handled');
});

test('a rerun after a flair failure repairs the flair without a second point or reply', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('setUserFlair');
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(s.reddit.flairs.length, 0);

  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 't0' },
  ]);
  assert.equal(s.reddit.replies.length, 1);
});

test('a failed reply leaves the claim pending, and the command resumes later with one point and a reply', async () => {
  const s = setup();
  const id = opRewards(s);
  const restore = breakReplies(s);

  assert.equal(await s.run(id), 'failed');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(s.alertMessages.length, 1);
  assert.ok(s.alertMessages[0]?.includes('reddit down'));
  assert.equal(await s.run(id), 'already-handled', 'still in flight');

  restore();
  s.clock.now += IN_FLIGHT_PASSED;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.ok(s.reddit.replies[0]?.text.includes('successfully rewarded'));
  assert.equal(await s.store.claim(id), 'done');
});

test('a moderator rerun picks up a failed command at once', async () => {
  const s = setup();
  const id = opRewards(s);
  const restore = breakReplies(s);
  assert.equal(await s.run(id), 'failed');
  restore();

  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('the resumed 10th reward replies with success, not the cap refusal', async () => {
  const s = setup();
  await s.store.setGivenToday('OP', DAY, 9);
  const id = opRewards(s);
  const restore = breakReplies(s);
  assert.equal(await s.run(id), 'failed');
  assert.equal(await s.store.givenToday('OP', DAY), 10);

  restore();
  s.clock.now += IN_FLIGHT_PASSED;
  assert.equal(await s.run(id), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.ok(s.reddit.replies[0]?.text.includes('successfully rewarded'));
  assert.ok(!s.reddit.replies[0]?.text.includes('limit'));
  assert.equal(s.alertMessages.length, 1, 'only the failed first attempt');
  assert.ok(s.alertMessages[0]?.includes('failed'));
});

test('two deliveries of one command at once give one point and one reply', async () => {
  const s = setup();
  const id = opRewards(s);

  const outcomes = await Promise.all([s.run(id), s.run(id)]);

  assert.deepEqual([...outcomes].sort(), ['already-handled', 'rewarded']);
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('two deliveries of a moderator command at once give one point and one reply', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_c1' });

  const outcomes = await Promise.all([s.run(id), s.run(id, 'approve')]);

  assert.deepEqual([...outcomes].sort(), ['already-handled', 'rewarded']);
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('two commands for the same pair at once give one point and one refusal', async () => {
  const s = setup();
  const first = opRewards(s, 't1_cmd1');
  const second = opRewards(s, 't1_cmd2');

  const outcomes = await Promise.all([s.run(first), s.run(second)]);

  assert.deepEqual([...outcomes].sort(), ['refused', 'rewarded']);
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 2);
  assert.equal(
    s.reddit.replies.filter((r) => r.text.includes('already rewarded')).length,
    1
  );
});

test('two commands at once from a giver one below the cap give one point and one cap refusal', async () => {
  const s = setup();
  s.reddit.addPost(post('t3_p2'));
  s.command('t1_c2', 'Trader', 'also here', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });
  await s.store.setGivenToday('OP', DAY, 9);
  const first = opRewards(s, 't1_cmd1');
  const second = s.command('t1_cmd2', 'OP', '+karma', {
    parentId: 't1_c2',
    postId: 't3_p2',
  });

  const outcomes = await Promise.all([s.run(first), s.run(second)]);

  assert.deepEqual([...outcomes].sort(), ['refused', 'rewarded']);
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(await s.store.givenToday('OP', DAY), 10);
  assert.equal(
    s.reddit.replies.filter((r) => r.text.includes('karma reward limit'))
      .length,
    1
  );
  assert.equal(s.alertMessages.length, 0);
});

test('a removed command is ignored without a claim, for a moderator too', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', {
    parentId: 't1_c1',
    removed: true,
  });
  assert.equal(await s.run(id), 'ignored');
  assert.equal(await s.run(id, 'rerun'), 'ignored');
  assert.equal(s.reddit.replies.length, 0);
  assert.equal((await s.store.loadProfile('Trader')).karma, 0);

  s.reddit.addComment(
    comment(id, 'Mod', '+karma', { parentId: 't1_c1', removed: false })
  );
  assert.equal(await s.run(id, 'approve'), 'rewarded', 'no claim was written');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

test('a removed !close is ignored without a claim and closes once approved', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close', { removed: true });

  assert.equal(await s.run(id), 'ignored');

  assert.equal(s.reddit.replies.length, 0);
  assert.equal(s.reddit.locked.length, 0);
  assert.equal(s.reddit.postFlairs.length, 0);

  s.reddit.addComment(comment(id, 'OP', '!close', { removed: false }));
  assert.equal(await s.run(id, 'approve'), 'closed');
  assert.deepEqual(s.reddit.locked, ['t3_p1']);
});

test('a rerun of a finished rewarded command sets the flair again and sends no second reply', async () => {
  const s = setup();
  const id = opRewards(s);
  assert.equal(await s.run(id), 'rewarded');

  assert.equal(await s.run(id, 'rerun'), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 2);
  assert.equal(s.alertMessages.length, 0);
});

test('a rerun of a finished rewarded command at the cap is still rewarded, not refused', async () => {
  const s = setup();
  await s.store.setGivenToday('OP', DAY, 9);
  const id = opRewards(s);
  assert.equal(await s.run(id), 'rewarded');
  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(s.reddit.replies.length, 1);
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

test('a rerun of a finished refusal is judged and replied to again', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' });
  assert.equal(await s.run(id), 'refused');
  assert.equal(s.reddit.replies.length, 1);

  assert.equal(await s.run(id, 'rerun'), 'refused');

  assert.equal(s.reddit.replies.length, 2);
  assert.equal((await s.store.loadProfile('OP')).karma, 0);
});

test('a refusal is logged with its reason', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '+karma', { parentId: 't3_p1' });
  await s.run(id);
  assert.ok(
    s.log.some((line) => line.includes('t1_cmd refused: top-level')),
    s.log.join('\n')
  );
});

test('a rerun of an older moderator command after a newer one for the same pair gives no extra point', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const older = s.command('t1_cmd1', 'Mod', '+karma', { parentId: 't1_c1' });
  const newer = s.command('t1_cmd2', 'Mod', '+karma', { parentId: 't1_c1' });
  assert.equal(await s.run(older), 'rewarded');
  assert.equal(await s.run(newer), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 2);

  assert.equal(await s.run(older, 'rerun'), 'rewarded');
  assert.equal(await s.run(newer, 'rerun'), 'rewarded');

  assert.equal((await s.store.loadProfile('Trader')).karma, 2);
  assert.equal(s.reddit.replies.length, 2);
});

test('two reruns of an unfinished moderator command give one point and one reply', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_c1' });
  const restore = breakReplies(s);
  assert.equal(await s.run(id), 'failed');
  restore();
  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
});

test('a rerun of a command the bot never saw while disabled runs it', async () => {
  const s = setup({ enabled: false });
  const id = opRewards(s);
  assert.equal(await s.run(id, 'rerun'), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.flairs.length, 1);
});

test('the reward that reaches the daily cap is given and sends no alert', async () => {
  const s = setup();
  await s.store.setGivenToday('OP', DAY, 9);

  assert.equal(await s.run(opRewards(s)), 'rewarded');

  assert.equal(await s.store.givenToday('OP', DAY), 10);
  assert.equal(s.alertMessages.length, 0);
});

test('OP closing a trading post flairs, locks and announces it', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');

  assert.equal(await s.run(id), 'closed');

  assert.deepEqual(s.reddit.postFlairs, [
    { postId: 't3_p1', templateId: 'closed' },
  ]);
  assert.deepEqual(s.reddit.locked, ['t3_p1']);
  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'post', id: 't3_p1' });
  assert.ok(s.reddit.replies[0]?.text.includes('has been closed'));
  assertFooter(s.reddit.replies[0]?.text ?? '');
  assert.equal(await s.store.claim(id), 'done');
});

test('someone other than OP cannot close the post', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'Trader', '!close');

  assert.equal(await s.run(id), 'refused');

  assert.equal(s.reddit.postFlairs.length, 0);
  assert.equal(s.reddit.locked.length, 0);
  assert.equal(s.reddit.replies.length, 1);
  assert.deepEqual(s.reddit.replies[0]?.target, { kind: 'comment', id });
  assert.ok(s.reddit.replies[0]?.text.includes('only be closed by the OP'));
  assertFooter(s.reddit.replies[0]?.text ?? '');
});

test('OP cannot close a post that is not a trading post', async () => {
  const s = setup();
  s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
  const id = s.command('t1_cmd', 'OP', '!close', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });

  assert.equal(await s.run(id), 'refused');

  assert.equal(s.reddit.locked.length, 0);
  assert.ok(s.reddit.replies[0]?.text.includes('cannot be closed'));
});

test('a moderator can close any post', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['mod']);
  s.reddit.addPost(post('t3_p2', { flairText: 'Discussion' }));
  const id = s.command('t1_cmd', 'Mod', '!close', {
    parentId: 't3_p2',
    postId: 't3_p2',
  });

  assert.equal(await s.run(id), 'closed');

  assert.deepEqual(s.reddit.locked, ['t3_p2']);
  assert.deepEqual(s.reddit.postFlairs, [
    { postId: 't3_p2', templateId: 'closed' },
  ]);
});

for (const count of [8, 9, 10, 15]) {
  test(`a moderator at ${count} rewards today is not capped`, async () => {
    const s = setup();
    s.reddit.moderators = new Set(['mod']);
    await s.store.setGivenToday('Mod', DAY, count);
    const id = s.command('t1_cmd', 'Mod', '+karma', { parentId: 't1_c1' });
    assert.equal(await s.run(id), 'rewarded');
    assert.equal(s.alertMessages.length, 0);
    assert.equal(await s.store.givenToday('Mod', DAY), count + 1);
  });
}

test('a moderator receiver gets the mods and couriers template', async () => {
  const s = setup();
  s.reddit.moderators = new Set(['trader']);
  assert.equal(await s.run(opRewards(s)), 'rewarded');
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Karma: 1', templateId: 'mods' },
  ]);
});

test('a courier receiver gets the mods and couriers template and the courier label', async () => {
  const s = setup();
  s.reddit.wiki.set(COURIER_PAGE, 'couriers:\n  - trader\n');
  assert.equal(await s.run(opRewards(s)), 'rewarded');
  assert.deepEqual(s.reddit.flairs, [
    { username: 'Trader', text: 'Verified Courier: 1', templateId: 'mods' },
  ]);
});

test('a failed fetch is alerted and the outcome is failed', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('getComment');

  assert.equal(await s.run(id), 'failed');

  assert.equal(s.alertMessages.length, 1);
  assert.ok(s.alertMessages[0]?.includes(id));
  assert.equal(s.reddit.replies.length, 0);
  assert.equal(await s.run(id), 'rewarded', 'nothing was claimed');
});

test('a failed post fetch is alerted and the command resumes later', async () => {
  const s = setup();
  const id = opRewards(s);
  s.reddit.failNext('getPost');
  assert.equal(await s.run(id), 'failed');
  assert.equal(s.alertMessages.length, 1);
  s.clock.now += IN_FLIGHT_PASSED;
  assert.equal(await s.run(id), 'rewarded');
  assert.equal((await s.store.loadProfile('Trader')).karma, 1);
});

for (const appName of ['Fo76-Karma-Dev', 'FO76-KARMA-DEV']) {
  test(`the app username is compared ignoring case (${appName})`, async () => {
    const s = setup();
    s.reddit.appName = appName;
    const id = s.command('t1_bot', 'fo76-karma-dev', '+karma', {
      parentId: 't1_c1',
    });
    assert.equal(await s.run(id), 'skipped');
    assert.equal(s.reddit.replies.length, 0);
    assert.equal((await s.store.loadProfile('Trader')).karma, 0);
  });
}

test('!close with a template sets the post flair and sends no alert', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');
  assert.equal(await s.run(id), 'closed');
  assert.deepEqual(s.reddit.postFlairs, [
    { postId: 't3_p1', templateId: 'closed' },
  ]);
  assert.equal(s.alertMessages.length, 0);
});

test('a rerun of a finished !close flairs and locks again without a second reply', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');
  assert.equal(await s.run(id), 'closed');

  assert.equal(await s.run(id, 'rerun'), 'closed');

  assert.equal(s.reddit.replies.length, 1);
  assert.equal(s.reddit.postFlairs.length, 2);
  assert.equal(s.reddit.locked.length, 2);
});

test('two deliveries of a !close at once reply once', async () => {
  const s = setup();
  const id = s.command('t1_cmd', 'OP', '!close');
  const outcomes = await Promise.all([s.run(id), s.run(id)]);
  assert.deepEqual([...outcomes].sort(), ['already-handled', 'closed']);
  assert.equal(s.reddit.replies.length, 1);
});

test('a rerun of a command the old bot already rewarded gives no point and no reply', async () => {
  const { reddit, store, command, run } = setup();
  const id = command('t1_old', 'OP', '+karma', { parentId: 't1_c1' });
  await store.importBatch({
    profiles: [
      { redditUsername: 'Trader', karma: 7, m76Karma: 0, gamertags: [] },
    ],
    rewards: [
      {
        commentId: id,
        postId: 't3_p1',
        giver: 'OP',
        receiver: 'Trader',
        sign: 0,
        atMs: T0 - 1000,
      },
    ],
  });

  assert.equal(await run(id, 'rerun'), 'rewarded');
  assert.equal((await store.loadProfile('Trader')).karma, 7);
  assert.equal(reddit.replies.length, 0);
  assert.deepEqual(
    reddit.flairs.map((flair) => flair.text),
    ['Karma: 7']
  );
});
