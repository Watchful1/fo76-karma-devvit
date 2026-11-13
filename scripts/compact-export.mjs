// Compacts the MongoDB export of the old karma bot into the snapshot the app
// imports (src/server/import.ts).
//
// Usage: node scripts/compact-export.mjs <export-dir> <out-file> [--since <ISO time or ms>] [--base <snapshot file>]
//
// Reads fallout76marketplace_karma_db.user_karma.json and
// fallout76marketplace_karma_db.karma_logs.json from <export-dir> and writes
// compact JSON of this shape:
//
//   {
//     "newestMs": number,   // time of the newest reward included (0 when none); a delta export starts after it
//     "profiles": [[redditUsername, karma, m76Karma, [[platform, gamertag, gamertagId], ...]], ...],
//     "rewards":  [[commentId, postId, giver, receiver, atMs], ...]   // sorted by atMs
//   }
//
// Profiles: usernames are compared lowercased; of duplicates the one with any
// karma, m76 karma or gamertag wins (the highest karma if several). A full
// snapshot skips profiles with all zeros and no gamertags.
// Rewards: commentId is the last segment of comment_permalink, postId is
// submission_id, both without their t1_/t3_ prefix; atMs is utc_created in ms.
//
// A delta (--since) keeps only the rewards after that time. Its profiles are
// those of the users in these rewards, plus, with --base, every profile that
// differs from the base snapshot: that catches profiles edited by hand since.
// A delta keeps all-zero profiles, since they may replace a non-zero one.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const USERS_FILE = 'fallout76marketplace_karma_db.user_karma.json';
const LOGS_FILE = 'fallout76marketplace_karma_db.karma_logs.json';

function usage() {
  console.error(
    'Usage: node scripts/compact-export.mjs <export-dir> <out-file> [--since <ISO time or ms>] [--base <snapshot file>]'
  );
  process.exit(2);
}

function parseSince(text) {
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(ms)) {
    console.error(
      `--since: cannot read "${text}" as an ISO time or milliseconds`
    );
    process.exit(2);
  }
  return ms;
}

function parseArgs(argv) {
  const positional = [];
  let since;
  let base;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[++i];
      if (value === undefined) usage();
      since = parseSince(value);
    } else if (arg === '--base') {
      base = argv[++i];
      if (base === undefined) usage();
    } else if (arg.startsWith('--')) {
      usage();
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) usage();
  if (base !== undefined && since === undefined) {
    console.error('--base only applies to a delta: give --since as well');
    process.exit(2);
  }
  return { dir: positional[0], out: positional[1], since, base };
}

const stripPrefix = (id, prefix) =>
  id.startsWith(prefix) ? id.slice(prefix.length) : id;

function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

function compactProfile(doc) {
  const gamertags = (doc.gamertags ?? []).map((g) => {
    if (typeof g.gamertag !== 'string' || typeof g.platform !== 'string') {
      throw new Error(
        `Profile ${doc.reddit_username}: a gamertag has no "gamertag" or "platform" text`
      );
    }
    // gamertag_id is a string for most rows and the number 0 for some.
    return [g.platform, g.gamertag, String(g.gamertag_id ?? '')];
  });
  return [doc.reddit_username, doc.karma ?? 0, doc.m76_karma ?? 0, gamertags];
}

const hasData = (profile) =>
  profile[1] !== 0 || profile[2] !== 0 || profile[3].length > 0;

/** One profile per lowercased username: one with data beats an empty one, then the higher karma wins. */
function mergeProfiles(docs) {
  const byName = new Map();
  for (const doc of docs) {
    const profile = compactProfile(doc);
    const key = profile[0].toLowerCase();
    const kept = byName.get(key);
    if (
      kept === undefined ||
      (hasData(profile) && (!hasData(kept) || profile[1] > kept[1]))
    )
      byName.set(key, profile);
  }
  return byName;
}

function compactRewards(docs) {
  const rewards = docs.map((doc) => {
    const segments = doc.comment_permalink.split('/').filter((s) => s !== '');
    const commentId = stripPrefix(segments[segments.length - 1], 't1_');
    return [
      commentId,
      stripPrefix(String(doc.submission_id), 't3_'),
      doc.from_user,
      doc.to_user,
      doc.utc_created * 1000,
    ];
  });
  // Array.prototype.sort is stable, so rewards at the same second keep their export order.
  return rewards.sort((a, b) => a[4] - b[4]);
}

/** The profiles a delta carries: users in its rewards, and those that differ from the base snapshot. */
function deltaProfiles(merged, rewards, basePath) {
  const wanted = new Set();
  for (const r of rewards) {
    wanted.add(r[2].toLowerCase());
    wanted.add(r[3].toLowerCase());
  }
  if (basePath !== undefined) {
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const baseRows = new Map(
      base.profiles.map((p) => [p[0].toLowerCase(), JSON.stringify(p)])
    );
    for (const [key, profile] of merged) {
      const before = baseRows.get(key);
      // A profile the base skipped as empty and that is still empty has not changed.
      if (
        before === undefined
          ? hasData(profile)
          : before !== JSON.stringify(profile)
      )
        wanted.add(key);
    }
  }
  return [...merged].filter(([key]) => wanted.has(key)).map(([, p]) => p);
}

const { dir, out, since, base } = parseArgs(process.argv.slice(2));

const userDocs = readJson(dir, USERS_FILE);
const logDocs = readJson(dir, LOGS_FILE);
const merged = mergeProfiles(userDocs);

let rewards = compactRewards(logDocs);
let profiles;
if (since === undefined) {
  profiles = [...merged.values()].filter(hasData);
} else {
  rewards = rewards.filter((r) => r[4] > since);
  profiles = deltaProfiles(merged, rewards, base);
}

const newestMs = rewards.reduce((max, r) => Math.max(max, r[4]), 0);
writeFileSync(out, JSON.stringify({ newestMs, profiles, rewards }));

const skipped =
  since === undefined ? userDocs.length - profiles.length : 'n/a (delta)';
const newest = newestMs === 0 ? 'none' : new Date(newestMs).toISOString();
console.log(
  `profiles kept ${profiles.length}, skipped ${skipped}, rewards ${rewards.length}, ` +
    `rows ${profiles.length + rewards.length} (the import reports this total), ` +
    `newest ${newest} (${newestMs}), ${statSync(out).size} bytes`
);
