import { Hono } from 'hono';

import {
  config,
  IMPORT_JOB,
  scheduleImportHop,
  store,
} from '../server/devvit/platform';
import { devvitReddit } from '../server/devvit/reddit';
import {
  currentImportSource,
  importNextBatch,
  loadSnapshot,
  setImportStatus,
  setTodaysCounts,
} from '../server/import';

export const scheduledJobs = new Hono();

/** How long one hop keeps loading batches before it hands over to the next, well inside a request's 30 seconds. */
const HOP_BUDGET_MS = 15_000;
/**
 * The pause before the next hop. The platform limits how fast new jobs are
 * scheduled ("limit exceeded: new action rate" after 60 hops in 17 seconds).
 */
const HOP_GAP_MS = 2_000;

// One hop of the import. It reschedules itself until the snapshot is loaded.
scheduledJobs.post(`/${IMPORT_JOB}`, async (c) => {
  const db = store();
  const body = await c.req
    .json<{ data?: { run?: string } }>()
    .catch(() => undefined);
  const run = body?.data?.run;
  const source = await currentImportSource(db, run);
  if (!run || !source) {
    console.log('Import hop from a chain that is no longer current; stopping');
    return c.json({}, 200);
  }

  let total = 0;
  try {
    const snapshot = await loadSnapshot(devvitReddit, source);
    total = snapshot.profiles.length + snapshot.rewards.length;
    // The file's karma would overwrite karma given since: never load while the bot answers commands.
    if ((await config()).enabled) {
      const { rows } = await db.importProgress();
      await setImportStatus(db, { source, state: 'stopped', rows, total });
      console.log(
        `Import from ${source} stopped at ${rows}/${total} rows because Enabled is on`
      );
      return c.json({}, 200);
    }

    const started = Date.now();
    let progress = await importNextBatch(snapshot, db);
    while (!progress.done && Date.now() - started < HOP_BUDGET_MS) {
      progress = await importNextBatch(snapshot, db);
    }
    console.log(
      `Import from ${source}: ${progress.rows}/${progress.total}${progress.done ? ', done' : ''}`
    );
    if (!progress.done) {
      await setImportStatus(db, {
        source,
        state: 'running',
        rows: progress.rows,
        total,
      });
      await scheduleImportHop(run, HOP_GAP_MS);
      return c.json({}, 200);
    }
    await setTodaysCounts(db, Date.now());
    await setImportStatus(db, {
      source,
      state: 'done',
      rows: progress.rows,
      total,
    });
    console.log(`Import from ${source} finished: ${progress.total} rows`);
  } catch (error) {
    console.error(`Import hop failed: ${String(error)}`);
    try {
      const { rows } = await db.importProgress();
      await setImportStatus(db, {
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
