import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closeRefusalText,
  closeSuccessText,
  karmaRefusalText,
  karmaSuccessText,
  permalinkFor,
  withFooter,
} from './replies';
import type { KarmaRefusal } from './types';

test('success texts name the users', () => {
  const give = karmaSuccessText('alice', 'bob', 1);
  assert.match(give, /u\/alice/);
  assert.match(give, /u\/bob/);
  assert.match(give, /successfully rewarded/);
  const take = karmaSuccessText('mod', 'bob', -1);
  assert.match(take, /^bob's karma has been decremented by one/);
});

test('every refusal but unauthorized names the giver', () => {
  const reasons: KarmaRefusal[] = [
    'wrong-post-type',
    'self',
    'top-level',
    'removed',
    'too-many-users',
    'already-rewarded',
    'cap',
  ];
  for (const reason of reasons) {
    const text = karmaRefusalText(reason, {
      giver: 'alice',
      receiver: 'bob',
      earlierLink: 'https://x/y',
    });
    assert.ok(text.includes('u/alice'), reason);
  }
  assert.match(
    karmaRefusalText('unauthorized', { giver: 'alice' }),
    /only be subtracted by moderators/
  );
});

test('already-rewarded names the receiver and links the earlier command', () => {
  const text = karmaRefusalText('already-rewarded', {
    giver: 'alice',
    receiver: 'bob',
    earlierLink: 'https://x/y',
  });
  assert.ok(text.includes('rewarded bob'));
  assert.ok(text.includes('[here](https://x/y)'));
});

test('removed thanks the giver without blaming AutoModerator, and cap says UTC', () => {
  const removed = karmaRefusalText('removed', { giver: 'alice' });
  assert.ok(!removed.includes('AutoModerator'));
  assert.ok(removed.includes('Thank you for your understanding.'));
  assert.ok(
    karmaRefusalText('cap', { giver: 'alice' }).includes(
      'until the next midnight UTC'
    )
  );
});

test('close texts', () => {
  assert.match(closeSuccessText(), /has been closed/);
  assert.match(
    closeRefusalText('not-op'),
    /only be closed by the OP or the mods/
  );
  assert.match(closeRefusalText('not-trading'), /cannot be closed/);
});

test('withFooter appends the disclaimer', () => {
  const out = withFooter('Hello', 'https://example.com/d');
  assert.ok(out.startsWith('Hello\n\n^(This action was performed by a bot.'));
  assert.ok(out.endsWith('[See disclaimer](https://example.com/d))'));
});

test('permalinkFor strips the prefixes', () => {
  assert.equal(
    permalinkFor('Fallout76Marketplace', 't3_abc', 't1_def'),
    'https://www.reddit.com/r/Fallout76Marketplace/comments/abc/_/def/'
  );
  assert.equal(
    permalinkFor('s', 'abc', 'def'),
    'https://www.reddit.com/r/s/comments/abc/_/def/'
  );
});
