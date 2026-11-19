// The shapes shared by the pure logic, the store and the platform code. Nothing
// here imports Devvit, so every module built on it is testable without the
// platform. The behaviour these types describe is docs/features.md.

import type { Store } from './store';

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

export type CommandKind = 'give' | 'take' | 'close';

/** Someone involved in a command, with the roles the checks care about. */
export type Party = {
  name: string;
  isMod: boolean;
  isCourier: boolean;
};

/** A comment or post as the checks see it. `author` is undefined when deleted. */
type Content = {
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

export type CloseRefusal = 'not-op' | 'not-trading';

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
  { kind: 'pass' } | { kind: 'refuse'; reason: CloseRefusal };

export type Reward = {
  commentId: string;
  postId: string;
  giver: string;
  receiver: string;
  sign: 1 | -1;
  atMs: number;
};

/** A reward from the old bot's log, which has no sign. */
export type ImportedReward = Omit<Reward, 'sign'> & { sign: 1 | -1 | 0 };

export type CommentInfo = {
  id: string;
  /** Undefined when the author's account is deleted. */
  authorName: string | undefined;
  body: string;
  /** `t1_…` for a reply, `t3_…` for a top-level comment. */
  parentId: string;
  postId: string;
  removed: boolean;
};

export type PostInfo = {
  id: string;
  authorName: string | undefined;
  flairText: string;
  removed: boolean;
};

export type ReplyTarget = { kind: 'comment' | 'post'; id: string };

/** The Reddit calls the app makes, behind an interface so tests can fake them. */
export interface RedditPort {
  appUsername(): Promise<string>;
  /** The username of the user making this request, if they moderate the subreddit. */
  currentModerator(): Promise<string | undefined>;
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
  /** Posts a distinguished, locked reply. */
  replyLocked(target: ReplyTarget, text: string): Promise<void>;
  setUserFlair(
    username: string,
    text: string,
    templateId: string
  ): Promise<void>;
  clearUserFlair(username: string): Promise<void>;
  setPostFlair(postId: string, templateId: string): Promise<void>;
  lockPost(postId: string): Promise<void>;
}

/** What the command handler and the moderator forms need from the outside world. */
export type Ports = {
  reddit: RedditPort;
  store: Store;
  config: Config;
  subredditName: string;
  now: () => number;
  log: (message: string) => void;
};
