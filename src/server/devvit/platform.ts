// Wires the handler's ports to Devvit: this install's store, settings,
// scheduler and Reddit client.

import { context, redis, scheduler, settings } from '@devvit/web/server';

import { configFrom } from '../settings';
import { Store, type RedisPort } from '../store';
import type { Config, Ports } from '../types';
import { devvitReddit } from './reddit';

/** The scheduler task of devvit.json that runs one hop of the import. */
export const IMPORT_JOB = 'import-hop';

// Typed as the port, so the compiler checks that the client fits it.
const redisPort: RedisPort = redis;

export function store(): Store {
  return new Store(redisPort);
}

export async function config(): Promise<Config> {
  return configFrom(await settings.getAll());
}

export async function ports(): Promise<Ports> {
  return {
    reddit: devvitReddit,
    store: store(),
    config: await config(),
    subredditName: context.subredditName,
    now: Date.now,
    log: (message) => console.log(message),
  };
}

export async function scheduleImportHop(
  run: string,
  delayMs = 0
): Promise<void> {
  await scheduler.runJob({
    name: IMPORT_JOB,
    runAt: new Date(Date.now() + delayMs),
    data: { run },
  });
}
