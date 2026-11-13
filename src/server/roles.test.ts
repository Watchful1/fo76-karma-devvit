import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCourierList, Roles } from './roles';
import { FakeReddit } from './testing/fake-reddit';

test('a couriers list is read with quotes, u/ prefixes and comments', () => {
  const page = [
    '# who may carry',
    'couriers:',
    '  - Alice',
    '  # a comment inside the list',
    '  - "Bob_The_Courier"',
    "  - 'carol'",
    '  - u/Dave',
    '  - U/Eve',
    '',
    '  -   Frank  ',
  ].join('\n');
  assert.deepEqual(
    [...parseCourierList(page)].sort(),
    ['alice', 'bob_the_courier', 'carol', 'dave', 'eve', 'frank'].sort()
  );
});

test('a following top-level key ends the list', () => {
  const page = 'couriers:\n  - alice\nother_key:\n  - mallory\n';
  assert.deepEqual([...parseCourierList(page)], ['alice']);
});

test('items before the couriers key are ignored', () => {
  const page = '- mallory\ncouriers:\n- alice\n';
  assert.deepEqual([...parseCourierList(page)], ['alice']);
});

test('Windows line endings are handled', () => {
  assert.deepEqual(
    [...parseCourierList('couriers:\r\n  - Alice\r\n  - Bob\r\n')],
    ['alice', 'bob']
  );
});

test('an undefined or empty page gives no couriers', () => {
  assert.equal(parseCourierList(undefined).size, 0);
  assert.equal(parseCourierList('').size, 0);
});

test('the courier page is read once for several lookups, matched ignoring case', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set('page', 'couriers:\n  - Alice\n');
  const roles = new Roles(reddit, 'page');
  assert.equal(await roles.isCourier('ALICE'), true);
  assert.equal(await roles.isCourier('alice'), true);
  assert.equal(await roles.isCourier('bob'), false);
  assert.equal(reddit.callCount('readWikiPage'), 1);
});

test('a missing courier page means nobody is a courier', async () => {
  const reddit = new FakeReddit();
  const roles = new Roles(reddit, 'missing');
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

test('a trailing comment is stripped and a comment-only line is skipped', () => {
  const page =
    'couriers:\n  - Bob # note\n  # only a comment\n  #another\n  - Al#x\n';
  assert.deepEqual([...parseCourierList(page)].sort(), ['al#x', 'bob']);
});

test('the flow form couriers: [Bob, "Al", u/Cy] lists all three', () => {
  assert.deepEqual(
    [...parseCourierList('couriers: [Bob, "Al", u/Cy]')].sort(),
    ['al', 'bob', 'cy']
  );
  assert.deepEqual(
    [...parseCourierList("couriers: [ 'Bob' ,/u/Dee ]  # note")].sort(),
    ['bob', 'dee']
  );
});

test('/u/Name and u/Name are both stripped', () => {
  assert.deepEqual(
    [...parseCourierList('couriers:\n  - /u/Name\n  - u/Other\n')].sort(),
    ['name', 'other']
  );
});

test('a later top-level key ends the list, and its items are not couriers', () => {
  const page = 'couriers:\n  - alice\nnotes: x\n  - mallory\nmore:\n  - eve\n';
  assert.deepEqual([...parseCourierList(page)], ['alice']);
});

test('a --- line does not add a courier named --', () => {
  const page = 'couriers:\n  - alice\n---\n  - bob\n';
  const names = parseCourierList(page);
  assert.equal(names.has('--'), false);
  assert.equal(names.has('alice'), true);
});

test('quoted names lose their quotes', () => {
  assert.deepEqual(
    [...parseCourierList('couriers:\n  - "Quoted"\n  - \'Single\'\n')].sort(),
    ['quoted', 'single']
  );
});

test('Windows line endings work with comments and the flow form too', () => {
  assert.deepEqual(
    [
      ...parseCourierList(
        'couriers:\r\n  - Alice # a\r\n\r\n  - Bob\r\nx: 1\r\n'
      ),
    ],
    ['alice', 'bob']
  );
  assert.deepEqual(
    [...parseCourierList('couriers: [A1b, C2d]\r\n')],
    ['a1b', 'c2d']
  );
});

test('the wiki page is read once for several different users', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set('page', 'couriers:\n  - a1\n  - b2\n');
  const roles = new Roles(reddit, 'page');
  const parties = await Promise.all([
    roles.party('a1'),
    roles.party('b2'),
    roles.party('c3'),
  ]);
  assert.deepEqual(
    parties.map((party) => party.isCourier),
    [true, true, false]
  );
  assert.equal(reddit.callCount('readWikiPage'), 1);
});

test('a wiki read that throws makes isCourier reject, not answer "no couriers"', async () => {
  const reddit = new FakeReddit();
  reddit.wiki.set('page', 'couriers:\n  - alice\n');
  reddit.failNext('readWikiPage', new Error('wiki down'));
  const roles = new Roles(reddit, 'page');
  await assert.rejects(roles.isCourier('alice'), /wiki down/);
  await assert.rejects(roles.party('alice'), /wiki down/);
});
