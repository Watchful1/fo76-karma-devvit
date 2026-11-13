import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flairFor } from './flair';
import type { FlairTemplates, Profile } from './types';

const templates: FlairTemplates = {
  modsAndCouriers: 'mods',
  tier0: 't0',
  tier50: 't50',
  tier100: 't100',
  tradeClosed: 'closed',
};
const user = { isMod: false, isCourier: false };

function profile(
  karma: number,
  m76Karma = 0,
  platforms: ('XBOX' | 'PlayStation' | 'PC')[] = []
): Profile {
  return {
    redditUsername: 'Someone',
    karma,
    m76Karma,
    gamertags: platforms.map((platform) => ({
      platform,
      username: 'x',
      userId: '1',
    })),
  };
}

test('text lists platforms in a fixed order, then the total', () => {
  assert.equal(
    flairFor(profile(10, 2, ['PC', 'XBOX']), user, templates).text,
    ':xbox: :pc: Karma: 12'
  );
  assert.equal(
    flairFor(profile(1, 0, ['PC', 'PlayStation', 'XBOX']), user, templates)
      .text,
    ':xbox: :playstation: :pc: Karma: 1'
  );
  assert.equal(flairFor(profile(12), user, templates).text, 'Karma: 12');
});

test('platforms are deduplicated', () => {
  assert.equal(
    flairFor(profile(0, 0, ['PC', 'PC']), user, templates).text,
    ':pc: Karma: 0'
  );
});

test('couriers get the courier label', () => {
  const out = flairFor(
    profile(5, 5, ['PC']),
    { isMod: false, isCourier: true },
    templates
  );
  assert.equal(out.text, ':pc: Verified Courier: 10');
  assert.equal(out.templateId, 'mods');
});

test('mods get the mods template', () => {
  assert.equal(
    flairFor(profile(500), { isMod: true, isCourier: false }, templates)
      .templateId,
    'mods'
  );
});

test('tiers use local karma and have exact boundaries', () => {
  const id = (karma: number, m76 = 0) =>
    flairFor(profile(karma, m76), user, templates).templateId;
  assert.equal(id(49), 't0');
  assert.equal(id(50), 't50');
  assert.equal(id(99), 't50');
  assert.equal(id(100), 't100');
  assert.equal(id(-3), 't0');
  assert.equal(id(10, 500), 't0', 'Market76 karma does not raise the tier');
});

test('a moderator who is not a courier is labelled Karma, not Verified Courier', () => {
  const out = flairFor(
    profile(5, 0, ['PC']),
    { isMod: true, isCourier: false },
    templates
  );
  assert.equal(out.text, ':pc: Karma: 5');
  assert.equal(out.templateId, 'mods');
});

test('a courier who is also a moderator gets the courier label and the mods template', () => {
  const out = flairFor(
    profile(5, 5),
    { isMod: true, isCourier: true },
    templates
  );
  assert.equal(out.text, 'Verified Courier: 10');
  assert.equal(out.templateId, 'mods');
});

test('with no gamertags the text is exactly "Karma: 5", with no leading space', () => {
  assert.equal(flairFor(profile(5), user, templates).text, 'Karma: 5');
  assert.equal(
    flairFor(profile(5), { isMod: false, isCourier: true }, templates).text,
    'Verified Courier: 5'
  );
});

test('tier boundaries use local karma even when Market76 karma is present', () => {
  const id = (karma: number, m76: number) =>
    flairFor(profile(karma, m76), user, templates).templateId;
  assert.equal(id(49, 1000), 't0');
  assert.equal(id(50, 0), 't50');
  assert.equal(id(50, 1000), 't50');
  assert.equal(id(99, 1000), 't50');
  assert.equal(id(100, 0), 't100');
  assert.equal(id(0, 100), 't0');
  assert.equal(id(49, 51), 't0');
  assert.equal(id(99, 1), 't50');
});

test('negative karma uses the lowest tier and shows in the total', () => {
  const out = flairFor(profile(-3, 1), user, templates);
  assert.equal(out.templateId, 't0');
  assert.equal(out.text, 'Karma: -2');
  assert.equal(flairFor(profile(-3, -4), user, templates).text, 'Karma: -7');
});
