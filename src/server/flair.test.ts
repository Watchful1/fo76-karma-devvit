import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flairFor } from './flair';
import type { FlairTemplates, Platform, Profile } from './types';

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
  platforms: Platform[] = []
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

test('the text lists each platform once in a fixed order, then the total', () => {
  const text = (p: Profile) => flairFor(p, user, templates).text;
  assert.equal(text(profile(10, 2, ['PC', 'XBOX'])), ':xbox: :pc: Karma: 12');
  assert.equal(
    text(profile(1, 0, ['PC', 'PlayStation', 'XBOX'])),
    ':xbox: :playstation: :pc: Karma: 1'
  );
  assert.equal(text(profile(0, 0, ['PC', 'PC'])), ':pc: Karma: 0');
  assert.equal(text(profile(12)), 'Karma: 12', 'no leading space');
});

test('the tier follows local karma only, with exact boundaries', () => {
  const id = (karma: number, m76 = 0) =>
    flairFor(profile(karma, m76), user, templates).templateId;
  assert.equal(id(-3), 't0');
  assert.equal(id(49), 't0');
  assert.equal(id(50), 't50');
  assert.equal(id(99), 't50');
  assert.equal(id(100), 't100');
  assert.equal(id(49, 1000), 't0', 'Market76 karma does not raise the tier');
  assert.equal(id(0, 100), 't0');
  assert.equal(id(99, 1000), 't50');
});

test('couriers get the courier label; moderators keep Karma; both get the mods template', () => {
  const flair = (isMod: boolean, isCourier: boolean) =>
    flairFor(profile(5, 5, ['PC']), { isMod, isCourier }, templates);
  assert.deepEqual(flair(false, true), {
    text: ':pc: Verified Courier: 10',
    templateId: 'mods',
  });
  assert.deepEqual(flair(true, false), {
    text: ':pc: Karma: 10',
    templateId: 'mods',
  });
  assert.deepEqual(flair(true, true), {
    text: ':pc: Verified Courier: 10',
    templateId: 'mods',
  });
  assert.equal(
    flairFor(profile(500), { isMod: true, isCourier: false }, templates)
      .templateId,
    'mods',
    'not the karma tier'
  );
});

test('negative karma uses the lowest tier and shows in the total', () => {
  const out = flairFor(profile(-3, 1), user, templates);
  assert.equal(out.templateId, 't0');
  assert.equal(out.text, 'Karma: -2');
  assert.equal(flairFor(profile(-3, -4), user, templates).text, 'Karma: -7');
});
