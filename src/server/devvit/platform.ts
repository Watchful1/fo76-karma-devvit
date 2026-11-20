// Wires the handler's ports to Devvit: this install's store, settings and
// Reddit client.

import { context, redis, settings } from '@devvit/web/server';

import { configFrom } from '../settings';
import { Store, type RedisPort } from '../store';
import type { Config, Ports } from '../types';
import { devvitReddit } from './reddit';

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
