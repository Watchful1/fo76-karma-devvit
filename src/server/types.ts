// The shapes shared by the pure logic, the store and the platform code. Nothing
// here imports Devvit, so every module built on it is testable without the
// platform. The behaviour these types describe is docs/features.md.

// ---------------------------------------------------------------- profiles

export type Platform = 'XBOX' | 'PlayStation' | 'PC';
export const PLATFORMS: readonly Platform[] = ['XBOX', 'PlayStation', 'PC'];

export type Gamertag = { platform: Platform; username: string; userId: string };

export type Profile = {
  /** The username in its canonical case, as Reddit shows it. */
  redditUsername: string;
  /** Karma earned on r/Fallout76Marketplace. */
  karma: number;
  /** Karma carried over from r/Market76. Shown in the total, ignored by the flair tier. */
  m76Karma: number;
  gamertags: Gamertag[];
};

export function emptyProfile(redditUsername: string): Profile {
  return { redditUsername, karma: 0, m76Karma: 0, gamertags: [] };
}

/** Usernames are compared and stored lowercased. */
export function userKey(username: string): string {
  return username.toLowerCase();
}

// ---------------------------------------------------------------- settings

export type FlairTemplates = {
  modsAndCouriers: string;
  /** Local karma 0–49 (and below zero). */
  tier0: string;
  /** Local karma 50–99. */
  tier50: string;
  /** Local karma 100 and up. */
  tier100: string;
  tradeClosed: string;
};

/** The subreddit settings, read once per request with defaults applied. */
export type Config = {
  enabled: boolean;
  dailyCap: number;
  /** Post flair texts that mark a trading post, compared ignoring case. */
  tradingFlairs: string[];
  templates: FlairTemplates;
  courierPage: string;
  disclaimerUrl: string;
};

// ---------------------------------------------------------------- commands

export type CommandKind = 'give' | 'take' | 'close';

// ---------------------------------------------------------------- checks

/** Someone involved in a command, with the roles the checks care about. */
export type Party = {
  name: string;
  isMod: boolean;
  isCourier: boolean;
};

/** A comment or post as the checks see it. `author` is undefined when deleted. */
export type Content = {
  author: Party | undefined;
  /** Removed by a moderator or a filter. */
  removed: boolean;
};

/** Everything the karma checks read. Built by the handler, judged by `checks.ts`. */
export type KarmaSnapshot = {
  kind: 'give' | 'take';
  giver: Party;
  /** What the command replied to: a comment, or the post when top-level. */
  parent: Content & { isPost: boolean };
  post: Content & { flairText: string };
  /** The comment id of the giver's earlier reward to this receiver in this post, if any. */
  alreadyRewarded: string | undefined;
  /** Rewards the giver has made since midnight UTC. */
  givenToday: number;
};

export type CloseSnapshot = {
  author: Party;
  post: Content & { flairText: string };
};

export type KarmaRefusal =
  | 'unauthorized' // -karma from a non-moderator
  | 'wrong-post-type'
  | 'self'
  | 'top-level'
  | 'removed'
  | 'too-many-users'
  | 'already-rewarded'
  | 'cap';

export type KarmaVerdict =
  | {
      kind: 'pass';
      receiver: string;
      sign: 1 | -1;
      /** False for moderators, who skip the once-per-pair rule and the daily cap. */
      enforceLimits: boolean;
    }
  | { kind: 'refuse'; reason: Exclude<KarmaRefusal, 'already-rewarded'> }
  | { kind: 'refuse'; reason: 'already-rewarded'; earlierCommentId: string };

export type CloseVerdict =
  { kind: 'pass' } | { kind: 'refuse'; reason: 'not-op' | 'not-trading' };

// ---------------------------------------------------------------- rewards and history

export type Reward = {
  commentId: string;
  postId: string;
  giver: string;
  receiver: string;
  sign: 1 | -1;
  atMs: number;
};

/** One line of a user's history. Imported rewards have an unknown sign. */
export type HistoryEntry =
  | {
      kind: 'reward';
      atMs: number;
      commentId: string;
      postId: string;
      giver: string;
      receiver: string;
      sign: 1 | -1 | 0;
    }
  | {
      kind: 'edit';
      atMs: number;
      moderator: string;
      before: Profile;
      after: Profile | undefined;
    };

// ---------------------------------------------------------------- the store

/**
 * - `claimed`: this request is the first to handle the comment.
 * - `resumed`: an earlier attempt did not finish, and this request took it over.
 * - `busy`: another request is handling the comment right now.
 * - `done`: the comment was answered before.
 */
export type ClaimResult = 'claimed' | 'resumed' | 'busy' | 'done';

export type RecordResult =
  | { kind: 'recorded' }
  /** This very comment's reward is already on record. */
  | { kind: 'already-recorded' }
  | { kind: 'already-rewarded'; earlierCommentId: string }
  | { kind: 'cap' };

/** Everything the app keeps in Redis. Keys are in docs/features.md §11. */
export interface StorePort {
  // profiles
  loadProfile(username: string): Promise<Profile>;
  /** Writes the whole profile, karma included. */
  saveProfile(profile: Profile): Promise<void>;
  /** Writes the gamertags and Market76 karma, leaving the karma alone. */
  saveDetails(profile: Profile): Promise<void>;
  /** Adds to a user's karma atomically and returns the new value. */
  addKarma(username: string, delta: number): Promise<number>;
  /**
   * Removes the profile, its history and its entries in the reward indexes,
   * and replaces the name with a placeholder in the partners' histories and
   * the event log. Returns the placeholder.
   */
  deleteProfile(username: string): Promise<string>;

  // commands
  /**
   * Claims a comment for handling. With `takeOver`, an attempt that is still
   * in flight is taken over too (a moderator's re-run).
   */
  claim(
    commentId: string,
    options?: { takeOver?: boolean }
  ): Promise<ClaimResult>;
  finish(commentId: string): Promise<void>;

  // rewards
  /** The comment id of giver's earlier reward to receiver in the post, if any. */
  earlierReward(
    postId: string,
    giver: string,
    receiver: string
  ): Promise<string | undefined>;
  givenToday(giver: string, dayKey: string): Promise<number>;
  /** Sets a day's count outright (after an import that carries today's rewards). */
  setGivenToday(giver: string, dayKey: string, count: number): Promise<void>;
  /** The reward a command comment recorded, if it recorded one since the app went live. */
  recordedReward(commentId: string): Promise<Reward | undefined>;
  /**
   * One transaction: the per-comment and once-per-pair entries, the karma
   * change, the day's count, the event and both histories. A comment records
   * at most one reward, whoever sent it. With `enforceLimits` the pair entry
   * and the daily cap are gates as well, and of two racing commands one wins.
   */
  recordReward(
    reward: Reward,
    options: { enforceLimits: boolean; dayKey: string; dailyCap: number }
  ): Promise<RecordResult>;

  // history and events
  appendHistory(username: string, entry: HistoryEntry): Promise<void>;
  /** Newest first, skipping the newest `offset` entries. */
  history(
    username: string,
    options: { offset?: number; limit: number }
  ): Promise<HistoryEntry[]>;
  /** Rewards from the given time on, oldest first, at most `limit`. */
  eventsSince(sinceMs: number, limit: number): Promise<ImportedReward[]>;

  // small values the routes keep between requests, such as the import's source
  meta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  // import
  importProgress(): Promise<{ rows: number; done: boolean }>;
  setImportProgress(progress: { rows: number; done: boolean }): Promise<void>;
  /** Loads one batch of imported profiles and rewards. Safe to repeat. */
  importBatch(batch: {
    profiles: Profile[];
    rewards: ImportedReward[];
  }): Promise<void>;
}

/** A reward from the old log, which has no sign. */
export type ImportedReward = Omit<Reward, 'sign'> & { sign: 1 | -1 | 0 };

// ---------------------------------------------------------------- the platform

export type CommentInfo = {
  id: string;
  /** Undefined when the author's account is deleted. */
  authorName: string | undefined;
  body: string;
  /** `t1_…` for a reply, `t3_…` for a top-level comment. */
  parentId: string;
  postId: string;
  removed: boolean;
  permalink: string;
};

export type PostInfo = {
  id: string;
  authorName: string | undefined;
  flairText: string;
  removed: boolean;
  locked: boolean;
  permalink: string;
};

export type ReplyTarget = { kind: 'comment' | 'post'; id: string };

/** The Reddit calls the app makes, behind an interface so tests can fake them. */
export interface RedditPort {
  appUsername(): Promise<string>;
  getComment(id: string): Promise<CommentInfo>;
  getPost(id: string): Promise<PostInfo>;
  isModerator(username: string): Promise<boolean>;
  /** The page's markdown, or undefined when it does not exist. Any other failure throws. */
  readWikiPage(page: string): Promise<string | undefined>;
  /** Writes a page only moderators can see. Returns false when the page was written but could not be restricted. */
  writeModWikiPage(
    page: string,
    content: string,
    reason: string
  ): Promise<boolean>;
  /** Posts a distinguished, locked reply and returns its id. */
  replyLocked(target: ReplyTarget, text: string): Promise<string>;
  setUserFlair(
    username: string,
    text: string,
    templateId: string
  ): Promise<void>;
  clearUserFlair(username: string): Promise<void>;
  setPostFlair(postId: string, templateId: string): Promise<void>;
  lockPost(postId: string): Promise<void>;
}

/** What the command handler needs from the outside world. */
export type Ports = {
  reddit: RedditPort;
  store: StorePort;
  config: Config;
  subredditName: string;
  now: () => number;
  log: (message: string) => void;
};
