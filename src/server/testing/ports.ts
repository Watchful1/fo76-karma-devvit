// Ports for tests: a fake Reddit, the real store on a fake Redis, a clock the
// test moves by hand, and a log kept in memory.

import { Store } from '../store';
import type { Config, Ports } from '../types';
import { FakeReddit } from './fake-reddit';
import { FakeRedis } from './fake-redis';

/** 2027-01-15T08:00:00Z. */
export const T0 = 1_800_000_000_000;
/** The UTC day of T0. */
export const DAY = '2027-01-15';

export const TEST_CONFIG: Config = {
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
  courierPage: 'custom_bot_config/courier_list',
  disclaimerUrl: 'https://example.test/disclaimer',
};

export function testPorts(configOverrides: Partial<Config> = {}) {
  const clock = { now: T0 };
  const reddit = new FakeReddit();
  const redis = new FakeRedis(() => clock.now);
  const store = new Store(redis, () => clock.now);
  const log: string[] = [];
  const config: Config = { ...TEST_CONFIG, ...configOverrides };
  const ports: Ports = {
    reddit,
    store,
    config,
    subredditName: 'fo76',
    now: () => clock.now,
    log: (message) => log.push(message),
  };
  return { clock, reddit, redis, store, log, config, ports };
}
