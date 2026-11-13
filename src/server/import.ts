// Loads the compacted export of the old karma bot into the store, a batch of
// rows per hop. The format is written by scripts/compact-export.mjs.

import type {
  Gamertag,
  ImportedReward,
  Platform,
  Profile,
  StorePort,
} from './types';
import { PLATFORMS } from './types';

export type GamertagRow = [platform: string, username: string, userId: string];
export type ProfileRow = [
  redditUsername: string,
  karma: number,
  m76Karma: number,
  gamertags: GamertagRow[],
];
export type RewardRow = [
  commentId: string,
  postId: string,
  giver: string,
  receiver: string,
  atMs: number,
];

export type Snapshot = {
  /** Time in ms of the newest reward included; a delta export starts after it. */
  newestMs: number;
  profiles: ProfileRow[];
  rewards: RewardRow[];
};

/** Rows loaded per hop of the import job. */
export const BATCH_ROWS = 1000;

type ImportStore = Pick<
  StorePort,
  'importProgress' | 'setImportProgress' | 'importBatch'
>;

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function isGamertagRow(value: unknown): value is GamertagRow {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(isString) &&
    PLATFORMS.includes(value[0] as Platform)
  );
}

function isProfileRow(value: unknown): value is ProfileRow {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    isString(value[0]) &&
    isNumber(value[1]) &&
    isNumber(value[2]) &&
    Array.isArray(value[3]) &&
    value[3].every(isGamertagRow)
  );
}

function isRewardRow(value: unknown): value is RewardRow {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    isString(value[0]) &&
    isString(value[1]) &&
    isString(value[2]) &&
    isString(value[3]) &&
    isNumber(value[4])
  );
}

/** Parses the snapshot's JSON, throwing an error that names the first thing wrong with it. */
export function parseSnapshot(json: string): Snapshot {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(
      'Snapshot must be an object with newestMs, profiles and rewards'
    );
  }
  const { newestMs, profiles, rewards } = data as Record<string, unknown>;
  if (!isNumber(newestMs))
    throw new Error('Snapshot newestMs must be a number');
  if (!Array.isArray(profiles))
    throw new Error('Snapshot profiles must be an array');
  if (!Array.isArray(rewards))
    throw new Error('Snapshot rewards must be an array');
  const badProfile = profiles.findIndex((row) => !isProfileRow(row));
  if (badProfile >= 0)
    throw new Error(
      `Snapshot profile row ${badProfile} is not [username, karma, m76Karma, [[platform, gamertag, gamertagId], ...]] with a platform of ${PLATFORMS.join(', ')}`
    );
  const badReward = rewards.findIndex((row) => !isRewardRow(row));
  if (badReward >= 0) {
    throw new Error(
      `Snapshot reward row ${badReward} is not [commentId, postId, giver, receiver, atMs]`
    );
  }
  return {
    newestMs,
    profiles: profiles as ProfileRow[],
    rewards: rewards as RewardRow[],
  };
}

/**
 * Parses a snapshot pasted on a wiki page. Reddit returns wiki text with
 * `&`, `<` and `>` as HTML entities, so those are decoded first; they never
 * change the structure of JSON. A moderator may also have wrapped the JSON in
 * a code fence, so when the text does not parse, it is tried again without one.
 */
export function parsePastedSnapshot(content: string): Snapshot {
  const decoded = content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return parseSnapshot(decoded);
  } catch (error) {
    const unwrapped = decoded
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/&quot;/g, '"');
    if (unwrapped === decoded) throw error;
    try {
      return parseSnapshot(unwrapped);
    } catch {
      throw error;
    }
  }
}

function gamertagFromRow([platform, username, userId]: GamertagRow): Gamertag {
  if (!PLATFORMS.includes(platform as Platform))
    throw new Error(`Unknown platform "${platform}" for ${username}`);
  return { platform: platform as Platform, username, userId };
}

export function profileFromRow([
  redditUsername,
  karma,
  m76Karma,
  gamertags,
]: ProfileRow): Profile {
  return {
    redditUsername,
    karma,
    m76Karma,
    gamertags: gamertags.map(gamertagFromRow),
  };
}

const withPrefix = (id: string, prefix: string) =>
  id.startsWith(prefix) ? id : prefix + id;

/** Reddit ids are stored with their `t1_`/`t3_` prefix; the old log has none. */
export function rewardFromRow([
  commentId,
  postId,
  giver,
  receiver,
  atMs,
]: RewardRow): ImportedReward {
  return {
    commentId: withPrefix(commentId, 't1_'),
    postId: withPrefix(postId, 't3_'),
    giver,
    receiver,
    sign: 0,
    atMs,
  };
}

/** Time in ms of the newest reward in the snapshot. */
export function importedAtLeast(snapshot: Snapshot): number {
  return snapshot.newestMs;
}

/**
 * Loads the next batch of rows (profiles first, then rewards) and advances the
 * progress. The progress moves only after the batch is stored, so a hop that
 * fails is repeated with the same rows. Does nothing once the import is done.
 */
export async function importHop(
  snapshot: Snapshot,
  store: ImportStore,
  batchRows: number = BATCH_ROWS
): Promise<{ rows: number; total: number; done: boolean }> {
  const total = snapshot.profiles.length + snapshot.rewards.length;
  const progress = await store.importProgress();
  if (progress.done) return { rows: progress.rows, total, done: true };

  const start = progress.rows;
  const end = Math.min(start + batchRows, total);
  const profileCount = snapshot.profiles.length;
  const profiles = snapshot.profiles.slice(
    Math.min(start, profileCount),
    Math.min(end, profileCount)
  );
  const rewards = snapshot.rewards.slice(
    Math.max(start - profileCount, 0),
    Math.max(end - profileCount, 0)
  );

  await store.importBatch({
    profiles: profiles.map(profileFromRow),
    rewards: rewards.map(rewardFromRow),
  });
  const next = { rows: end, done: end >= total };
  await store.setImportProgress(next);
  return { ...next, total };
}

/** For a delta: the number of rewards per `<giver lowercased>|<day>`, to become the day's `given:` counts. */
export function dailyCountsFrom(
  rewards: ImportedReward[],
  dayKey: (ms: number) => string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reward of rewards) {
    const key = `${reward.giver.toLowerCase()}|${dayKey(reward.atMs)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
