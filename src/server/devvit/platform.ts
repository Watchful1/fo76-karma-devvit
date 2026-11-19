// Wires the handler's ports to Devvit: this install's store, settings and
// Reddit client.

import { context, reddit, redis, settings } from '@devvit/web/server';

import { configFrom } from '../settings';
import { Store, type RedisPort } from '../store';
import type { Config, Ports } from '../types';
import { devvitReddit } from './reddit';

export function store(): Store {
  return new Store(redis as RedisPort);
}

/** The username of the user making this request, if they moderate the subreddit. */
export async function currentModerator(): Promise<string | undefined> {
  const user = await reddit.getCurrentUser();
  if (!user) return undefined;
  const permissions = await user.getModPermissionsForSubreddit(
    context.subredditName
  );
  return permissions.length > 0 ? user.username : undefined;
}

export async function config(): Promise<Config> {
  return configFrom(await settings.getAll());
}

export async function ports(): Promise<Ports> {
  const current = await config();
  return {
    reddit: devvitReddit,
    store: store(),
    config: current,
    subredditName: context.subredditName,
    now: Date.now,
    log: (message) => console.log(message),
  };
}
