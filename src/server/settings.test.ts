import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { configFrom } from './settings';

const DISCLAIMER =
  'https://www.reddit.com/user/Vault-TecTradingCo/comments/lkllre/disclaimer_for_rfallout76marketplace/';

test('empty settings give these literal defaults', () => {
  assert.deepEqual(configFrom({}), {
    enabled: false,
    dailyCap: 10,
    tradingFlairs: ['XBOX', 'PlayStation', 'PC'],
    templates: {
      modsAndCouriers: '51524056-4a4d-11eb-814b-0e7b734c1fd5',
      tier0: '3c680234-4a4d-11eb-8124-0edd2b620987',
      tier50: '2624bc6a-4a4d-11eb-8b7c-0e6968d78889',
      tier100: '0467e0de-4a4d-11eb-9453-0e4e6fcf2865',
      tradeClosed: '1e0c3870-a456-11ea-aa7a-0ee73ab9d31f',
    },
    courierPage: 'custom_bot_config/courier_list',
    disclaimerUrl: DISCLAIMER,
  });
});

test('strings are trimmed and blank strings fall back', () => {
  const config = configFrom({
    courierPage: '  my/page  ',
    disclaimerUrl: '   ',
    templateTier0: ' abc ',
  });
  assert.equal(config.courierPage, 'my/page');
  assert.equal(config.disclaimerUrl, DISCLAIMER);
  assert.equal(config.templates.tier0, 'abc');
});

test('every template id is read from its own key', () => {
  const config = configFrom({
    templateModsAndCouriers: 'm',
    templateTier0: 'a',
    templateTier50: 'b',
    templateTier100: 'c',
    templateTradeClosed: 'd',
  });
  assert.deepEqual(config.templates, {
    modsAndCouriers: 'm',
    tier0: 'a',
    tier50: 'b',
    tier100: 'c',
    tradeClosed: 'd',
  });
});

test('trading flairs split on commas, trim and drop blanks', () => {
  assert.deepEqual(
    configFrom({ tradingFlairs: ' XBOX ,, PC ,  , Switch,' }).tradingFlairs,
    ['XBOX', 'PC', 'Switch']
  );
});

test('the daily cap is a whole number of at least 1, else 10', () => {
  const cap = (value: unknown) => configFrom({ dailyCap: value }).dailyCap;
  assert.equal(cap(0), 10, 'a cleared field can come back as 0');
  assert.equal(cap(-5), 10);
  assert.equal(cap(0.9), 10, 'truncates to 0, then falls back');
  assert.equal(cap('5'), 10);
  assert.equal(cap(Number.NaN), 10);
  assert.equal(cap(Infinity), 10);
  assert.equal(cap(undefined), 10);
  assert.equal(cap(null), 10);
  assert.equal(cap(3.7), 3);
  assert.equal(cap(1), 1);
  assert.equal(cap(3), 3);
  assert.equal(cap(25), 25);
});

test('booleans are honoured and other types fall back', () => {
  assert.equal(configFrom({ enabled: true }).enabled, true);
  assert.equal(configFrom({ enabled: false }).enabled, false);
  assert.equal(configFrom({ enabled: 'true' }).enabled, false);
  assert.equal(configFrom({ enabled: 1 }).enabled, false);
});

type SettingDef = { type: string; defaultValue?: unknown };
const manifest = JSON.parse(
  readFileSync(new URL('../../devvit.json', import.meta.url), 'utf8')
) as { settings: { subreddit: Record<string, SettingDef> } };
const declared = manifest.settings.subreddit;

/** A value of the right type that differs from any default. */
function probe(def: SettingDef): unknown {
  if (def.type === 'boolean') return def.defaultValue !== true;
  if (def.type === 'number') return 7;
  return 'probe-value';
}

test('every setting in devvit.json is read by configFrom', () => {
  const base = JSON.stringify(configFrom({}));
  for (const [key, def] of Object.entries(declared)) {
    assert.notEqual(
      JSON.stringify(configFrom({ [key]: probe(def) })),
      base,
      `configFrom ignores the devvit.json setting "${key}"`
    );
  }
});

test('the devvit.json default values agree with the defaults', () => {
  const defaults = configFrom({});
  const fromManifest = (key: string): unknown => declared[key]?.defaultValue;
  assert.equal(fromManifest('enabled'), defaults.enabled);
  assert.equal(fromManifest('dailyCap'), defaults.dailyCap);
  assert.equal(
    fromManifest('tradingFlairs'),
    defaults.tradingFlairs.join(', ')
  );
  assert.equal(fromManifest('courierPage'), defaults.courierPage);
  assert.equal(fromManifest('disclaimerUrl'), defaults.disclaimerUrl);
  assert.equal(
    fromManifest('templateModsAndCouriers'),
    defaults.templates.modsAndCouriers
  );
  assert.equal(fromManifest('templateTier0'), defaults.templates.tier0);
  assert.equal(fromManifest('templateTier50'), defaults.templates.tier50);
  assert.equal(fromManifest('templateTier100'), defaults.templates.tier100);
  assert.equal(
    fromManifest('templateTradeClosed'),
    defaults.templates.tradeClosed
  );
});

test('every key configFrom reads is declared in devvit.json', () => {
  const keys = [
    'enabled',
    'dailyCap',
    'tradingFlairs',
    'templateModsAndCouriers',
    'templateTier0',
    'templateTier50',
    'templateTier100',
    'templateTradeClosed',
    'courierPage',
    'disclaimerUrl',
  ];
  assert.deepEqual(Object.keys(declared).sort(), keys.sort());
});
