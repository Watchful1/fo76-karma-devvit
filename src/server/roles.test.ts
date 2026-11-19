import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCourierList, Roles } from './roles';
import { FakeReddit } from './testing/fake-reddit';

const couriers = (page: string | undefined) => [...parseCourierList(page)];

test('a couriers list is read with quotes, u/ prefixes and comments', () => {
  const page = [
    '# who may carry',
    'couriers:',
    '  - Alice',
    '  # a comment inside the list',
    '  #another',
    '  - "Bob_The_Courier"',
    "  - 'carol'",
    '  - u/Dave',
    '  - U/Eve',
    '  - /u/Gus # a trailing comment',
    '  - Al#x',
    '',
    '  -   Frank  ',
  ].join('\n');
  assert.deepEqual(couriers(page).sort(), [
    'al#x',
    'alice',
    'bob_the_courier',
    'carol',
    'dave',
    'eve',
    'frank',
    'gus',
  ]);
});

test('the flow form couriers: [Bob, "Al", u/Cy] lists all three', () => {
  assert.deepEqual(couriers('couriers: [Bob, "Al", u/Cy]').sort(), [
    'al',
    'bob',
    'cy',
  ]);
  assert.deepEqual(couriers("couriers: [ 'Bob' ,/u/Dee ]  # note").sort(), [
    'bob',
    'dee',
  ]);
});

test('only items under the couriers key count, until the next top-level key', () => {
  assert.deepEqual(couriers('- mallory\ncouriers:\n- alice\n'), ['alice']);
  assert.deepEqual(
    couriers('couriers:\n  - alice\nnotes: x\n  - mallory\nmore:\n  - eve\n'),
    ['alice']
  );
});

test('a --- line does not add a courier named --', () => {
  const names = parseCourierList('couriers:\n  - alice\n---\n  - bob\n');
  assert.equal(names.has('--'), false);
  assert.equal(names.has('alice'), true);
});

test('Windows line endings work, with comments and the flow form too', () => {
  assert.deepEqual(
    couriers('couriers:\r\n  - Alice # a\r\n\r\n  - Bob\r\nx: 1\r\n'),
    ['alice', 'bob']
  );
  assert.deepEqual(couriers('couriers: [A1b, C2d]\r\n'), ['a1b', 'c2d']);
});

test('an undefined or empty page gives no couriers', () => {
  assert.equal(parseCourierList(undefined).size, 0);
  assert.equal(parseCourierList('').size, 0);
});

test('the courier page is read once for several users, matched ignoring case', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set('page', 'couriers:\n  - Alice\n  - b2\n');
  const roles = new Roles(reddit, 'page');
  const parties = await Promise.all([
    roles.party('ALICE'),
    roles.party('b2'),
    roles.party('c3'),
  ]);
  assert.deepEqual(
    parties.map((party) => party.isCourier),
    [true, true, false]
  );
  assert.equal(await roles.isCourier('alice'), true);
  assert.equal(reddit.callCount('readWikiPage'), 1);
});

test('a missing courier page means nobody is a courier', async () => {
  const roles = new Roles(new FakeReddit(), 'missing');
  assert.equal(await roles.isCourier('alice'), false);
});

test('moderator status is asked once per name, ignoring case', async () => {
  const reddit = new FakeReddit();
  reddit.moderators = new Set(['mod']);
  const roles = new Roles(reddit, 'page');
  assert.equal(await roles.isMod('Mod'), true);
  assert.equal(await roles.isMod('mod'), true);
  assert.equal(await roles.isMod('other'), false);
  assert.equal(reddit.callCount('isModerator'), 2);
});

test('party combines both roles', async () => {
  const reddit = new FakeReddit();
  reddit.moderators = new Set(['mod']);
  reddit.wiki.set('page', 'couriers:\n  - courier\n');
  const roles = new Roles(reddit, 'page');
  assert.deepEqual(await roles.party('Mod'), {
    name: 'Mod',
    isMod: true,
    isCourier: false,
  });
  assert.deepEqual(await roles.party('Courier'), {
    name: 'Courier',
    isMod: false,
    isCourier: true,
  });
});

test('a wiki read that throws makes isCourier reject, not answer "no couriers"', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set('page', 'couriers:\n  - alice\n');
  reddit.failNext('readWikiPage', new Error('wiki down'));
  const roles = new Roles(reddit, 'page');
  await assert.rejects(roles.isCourier('alice'), /wiki down/);
  await assert.rejects(roles.party('alice'), /wiki down/);
});
