// Loads the compacted export of the old karma bot into the store. The format
// is written by scripts/compact-export.mjs. The scheduler job runs the import
// in hops (src/routes/scheduler.ts); each hop loads batch after batch until its
// time is up, and the progress between batches is kept in the store.

import bundled from './data/snapshot.json';
import { asCommentId, asPostId } from './ids';
import type { Store } from './store';
import { utcDayKey } from './time';
import {
  PLATFORMS,
  userKey,
  type Gamertag,
  type ImportedReward,
  type Platform,
  type Profile,
  type RedditPort,
} from './types';

type GamertagRow = [platform: Platform, username: string, userId: string];
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

/** Rows per batch: each reward row can cost up to three sorted-set writes, so a batch takes a few seconds at most. */
const BATCH_ROWS = 300;

const SOURCE = 'import:source';
const STATUS = 'import:status';
/** The id of the chain of hops that may run; a hop from any other chain stops. */
const RUN = 'import:run';

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

/** A markdown backslash escape: a backslash before ASCII punctuation. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * Parses a snapshot pasted on a wiki page. Reddit returns wiki text with
 * `&`, `<` and `>` as HTML entities, so those are decoded first; they never
 * change the structure of JSON. When the text does not parse, it is tried
 * again without a code fence a moderator may have wrapped it in, and then
 * without the backslashes the reddit.com wiki editor puts before markdown
 * characters such as `[` and `_`.
 */
export function parsePastedSnapshot(content: string): Snapshot {
  const decoded = content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const unwrapped = decoded
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/&quot;/g, '"');
  const unescaped = unwrapped.replace(MARKDOWN_ESCAPE, '$1');
  let firstError: unknown;
  for (const text of new Set([decoded, unwrapped, unescaped])) {
    try {
      return parseSnapshot(text);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

/** The snapshot named by an import source: the bundled file, or `wiki:<page>` for a delta on a wiki page. */
export async function loadSnapshot(
  reddit: Pick<RedditPort, 'readWikiPage'>,
  source: string
): Promise<Snapshot> {
  if (source === 'bundled') return parseSnapshot(JSON.stringify(bundled));
  const page = source.replace(/^wiki:/, '');
  const content = await reddit.readWikiPage(page);
  if (content === undefined)
    throw new Error(`Wiki page ${page} does not exist`);
  return parsePastedSnapshot(content);
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
    gamertags: gamertags.map(([platform, username, userId]): Gamertag => ({
      platform,
      username,
      userId,
    })),
  };
}

/** Reddit ids are stored with their `t1_`/`t3_` prefix; the old log has none. */
export function rewardFromRow([
  commentId,
  postId,
  giver,
  receiver,
  atMs,
]: RewardRow): ImportedReward {
  return {
    commentId: asCommentId(commentId),
    postId: asPostId(postId),
    giver,
    receiver,
    sign: 0,
    atMs,
  };
}

/**
 * Loads the next batch of rows (profiles first, then rewards) and advances the
 * progress. The progress moves only after the batch is stored, so a batch that
 * fails is repeated with the same rows. Does nothing once the import is done.
 */
export async function importNextBatch(
  snapshot: Snapshot,
  store: Pick<Store, 'importProgress' | 'setImportProgress' | 'importBatch'>,
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

/**
 * The rewards of today (UTC) count against the daily cap: sets each giver's
 * count for today from the events, after an import that carries some.
 */
export async function setTodaysCounts(
  store: Store,
  nowMs: number
): Promise<void> {
  const today = utcDayKey(nowMs);
  const counts = new Map<string, number>();
  for (const reward of await store.eventsSince(Date.parse(today), 100_000)) {
    if (utcDayKey(reward.atMs) !== today) continue;
    const giver = userKey(reward.giver);
    counts.set(giver, (counts.get(giver) ?? 0) + 1);
  }
  for (const [giver, count] of counts)
    await store.setGivenToday(giver, today, count);
}

/** Where the last import stands, kept between the hops of the import job. */
export type ImportStatus = {
  source: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  rows: number;
  total: number;
  /** When the state last changed or a hop last finished. */
  atMs: number;
  error?: string;
};

/** A running import that has not advanced for this long has stopped without saying so. */
export const IMPORT_STALLED_MS = 3 * 60 * 1000;

export async function importStatus(
  store: Store
): Promise<ImportStatus | undefined> {
  const stored = await store.meta(STATUS);
  return stored === undefined
    ? undefined
    : (JSON.parse(stored) as ImportStatus);
}

export async function setImportStatus(
  store: Store,
  status: Omit<ImportStatus, 'atMs'>
): Promise<void> {
  await store.setMeta(STATUS, JSON.stringify({ ...status, atMs: Date.now() }));
}

function utcTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function importStatusText(
  status: ImportStatus | undefined,
  nowMs: number
): string {
  if (!status) return 'No import has run on this install.';
  const progress = `${status.rows} of ${status.total} rows from ${status.source}`;
  const at = `${utcTime(status.atMs)} UTC`;
  switch (status.state) {
    case 'done':
      return `Last import: finished, ${progress}, at ${at}.`;
    case 'failed':
      return `Last import: FAILED at ${progress}, at ${at}: ${status.error ?? 'unknown error'}. Start it again with the same source to resume.`;
    case 'stopped':
      return `Last import: stopped at ${progress}, at ${at}, because Enabled was turned on. Turn it off and start again to resume.`;
    case 'running':
      return nowMs - status.atMs > IMPORT_STALLED_MS
        ? `Last import: STALLED at ${progress}; no progress since ${at}. Start it again with the same source to resume.`
        : `An import is running: ${progress}, last progress at ${at}. Starting again restarts the job from where it is.`;
  }
}

/**
 * Prepares a chain of hops that loads `source`, and returns the chain's id for
 * the first hop. The same unfinished source resumes where it stopped; a
 * different source, or a finished one, starts over. A chain started earlier
 * stops at its next hop. Returns undefined, changing nothing, when `source`
 * already finished and `again` is false.
 */
export async function startImport(
  store: Store,
  source: string,
  total: number,
  again: boolean
): Promise<string | undefined> {
  const sameSource = (await store.meta(SOURCE)) === source;
  const progress = await store.importProgress();
  if (sameSource && progress.done && !again) return undefined;
  const restart = !sameSource || progress.done;
  if (restart) await store.setImportProgress({ rows: 0, done: false });

  const run = crypto.randomUUID();
  await store.setMeta(SOURCE, source);
  await store.setMeta(RUN, run);
  const rows = restart ? 0 : progress.rows;
  await setImportStatus(store, { source, state: 'running', rows, total });
  return run;
}

/** The source being imported, if `run` is the chain of hops that may run. */
export async function currentImportSource(
  store: Store,
  run: string | undefined
): Promise<string | undefined> {
  const [source, current] = await Promise.all([
    store.meta(SOURCE),
    store.meta(RUN),
  ]);
  return run !== undefined && run === current ? source : undefined;
}
