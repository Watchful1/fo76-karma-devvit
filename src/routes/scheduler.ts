import { Hono } from 'hono';
import { scheduler } from '@devvit/web/server';

import { config, store } from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import {
  dailyCountsFrom,
  importHop,
  parsePastedSnapshot,
  parseSnapshot,
  type Snapshot,
} from '../server/import';
import bundled from '../server/data/snapshot.json';
import type { Store } from '../server/store';
import { utcDayKey } from '../server/time';
import type { ImportStatus } from '../server/ui';

export const scheduler_ = new Hono();

export const IMPORT_JOB = 'import-hop';
/** Rows per batch: each reward row can cost two sorted-set writes, so a batch takes a few seconds at most. */
export const IMPORT_HOP_ROWS = 300;
/** How long one hop keeps loading batches before it hands over to the next, well inside a request's 30 seconds. */
const HOP_BUDGET_MS = 15_000;
/**
 * The pause before the next hop. The platform limits how fast new jobs are
 * scheduled ("limit exceeded: new action rate" after 60 hops in 17 seconds).
 */
const HOP_GAP_MS = 2_000;

const SOURCE = 'import:source';
const STATUS = 'import:status';
/** The id of the chain of hops that may run; a hop from any other chain stops. */
const RUN = 'import:run';

/** The snapshot named by the import's source: the bundled file, or a wiki page holding a delta. */
export async function loadSnapshot(source: string): Promise<Snapshot> {
  if (source === 'bundled') return parseSnapshot(JSON.stringify(bundled));
  const page = source.replace(/^wiki:/, '');
  const content = await devvitReddit.readWikiPage(page);
  if (content === undefined)
    throw new Error(`Wiki page ${page} does not exist`);
  return parsePastedSnapshot(content);
}

export async function importStatus(
  db: Store
): Promise<ImportStatus | undefined> {
  const stored = await db.meta(STATUS);
  return stored === undefined
    ? undefined
    : (JSON.parse(stored) as ImportStatus);
}

async function setStatus(
  db: Store,
  status: Omit<ImportStatus, 'atMs'>
): Promise<void> {
  await db.setMeta(STATUS, JSON.stringify({ ...status, atMs: Date.now() }));
}

async function scheduleHop(run: string, delayMs = 0): Promise<void> {
  await scheduler.runJob({
    name: IMPORT_JOB,
    runAt: new Date(Date.now() + delayMs),
    data: { run },
  });
}

/** Starts a chain of hops from where the progress stands. A chain started earlier stops at its next hop. */
export async function startImport(
  db: Store,
  source: string,
  total: number
): Promise<void> {
  const run = crypto.randomUUID();
  await db.setMeta(SOURCE, source);
  await db.setMeta(RUN, run);
  const { rows } = await db.importProgress();
  await setStatus(db, { source, state: 'running', rows, total });
  await scheduleHop(run);
}

/** The rewards of today (UTC) count against the daily cap: set each giver's count from the events. */
async function setTodaysCounts(db: Store): Promise<void> {
  const today = utcDayKey(Date.now());
  const rewards = await db.eventsSince(Date.parse(today), 100_000);
  for (const [key, count] of dailyCountsFrom(rewards, utcDayKey)) {
    const [giver, dayKey] = key.split('|');
    if (giver && dayKey === today) await db.setGivenToday(giver, today, count);
  }
}

// One hop of the import. It reschedules itself until the snapshot is loaded.
scheduler_.post(`/${IMPORT_JOB}`, async (c) => {
  const db = store();
  const body = await c.req
    .json<{ data?: { run?: string } }>()
    .catch(() => undefined);
  const run = body?.data?.run;
  const source = await db.meta(SOURCE);
  if (!source || !run || run !== (await db.meta(RUN))) {
    console.log('Import hop from a chain that is no longer current; stopping');
    return c.json({}, 200);
  }

  let total = 0;
  try {
    const snapshot = await loadSnapshot(source);
    total = snapshot.profiles.length + snapshot.rewards.length;
    // The file's karma would overwrite karma given since: never load while the bot answers commands.
    if ((await config()).enabled) {
      const { rows } = await db.importProgress();
      await setStatus(db, { source, state: 'stopped', rows, total });
      console.log(
        `Import from ${source} stopped at ${rows}/${total} rows because Enabled is on`
      );
      return c.json({}, 200);
    }

    const started = Date.now();
    let progress = await importHop(snapshot, db, IMPORT_HOP_ROWS);
    while (!progress.done && Date.now() - started < HOP_BUDGET_MS) {
      progress = await importHop(snapshot, db, IMPORT_HOP_ROWS);
    }
    console.log(
      `Import from ${source}: ${progress.rows}/${progress.total}${progress.done ? ', done' : ''}`
    );
    if (!progress.done) {
      await setStatus(db, {
        source,
        state: 'running',
        rows: progress.rows,
        total,
      });
      await scheduleHop(run, HOP_GAP_MS);
      return c.json({}, 200);
    }
    await setTodaysCounts(db);
    await setStatus(db, { source, state: 'done', rows: progress.rows, total });
    console.log(`Import from ${source} finished: ${progress.total} rows`);
  } catch (error) {
    console.error(`Import hop failed: ${String(error)}`);
    try {
      const { rows } = await db.importProgress();
      await setStatus(db, {
        source,
        state: 'failed',
        rows,
        total,
        error: String(error).slice(0, 300),
      });
    } catch (statusError) {
      console.error(`Import status not saved: ${String(statusError)}`);
    }
  }
  return c.json({}, 200);
});
