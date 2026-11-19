// Runs one command comment from start to finish: parse, claim, build the
// snapshot, judge it, and carry out the verdict through the ports. The order of
// writes is in docs/features.md, under Giving karma.

import { judgeClose, judgeKarma } from './checks';
import { parseCommand, type CommandInput } from './commands';
import { refreshFlair } from './flair';
import { isCommentId } from './ids';
import {
  closeRefusalText,
  closeSuccessText,
  karmaRefusalText,
  karmaSuccessText,
  permalinkFor,
  withFooter,
} from './replies';
import { Roles } from './roles';
import { utcDayKey } from './time';
import type {
  CloseRefusal,
  CommentInfo,
  KarmaRefusal,
  Ports,
  PostInfo,
  ReplyTarget,
} from './types';

export type Outcome =
  | 'not-a-command'
  | 'disabled'
  | 'skipped'
  | 'already-handled'
  | 'ignored'
  | 'refused'
  | 'rewarded'
  | 'closed'
  | 'failed';

/** What handling a command did, with the reason of a refusal and the message of a failure. */
export type CommandResult =
  | { outcome: Exclude<Outcome, 'refused' | 'failed'> }
  | { outcome: 'refused'; reason: KarmaRefusal | CloseRefusal }
  | { outcome: 'failed'; message: string };

/** One command being handled: what every step needs. */
type Run = {
  comment: CommentInfo;
  author: string;
  post: PostInfo;
  roles: Roles;
  ports: Ports;
  /** The comment was answered before, and a moderator is running it again. */
  answeredBefore: boolean;
};

export async function handleCommand(
  input: CommandInput,
  ports: Ports
): Promise<CommandResult> {
  if (input.body !== undefined && parseCommand(input.body) === undefined)
    return { outcome: 'not-a-command' };
  if (!ports.config.enabled && input.source !== 'rerun')
    return { outcome: 'disabled' };

  // Where the command is, for the failure message: the id until the comment is fetched.
  const where = { text: input.commentId };
  try {
    return await runCommand(input, ports, where);
  } catch (error) {
    // The claim stays pending, so a moderator's re-run picks the command up again.
    const message = `Command ${where.text} (${input.source}) failed: ${String(error)}`;
    ports.log(message);
    return { outcome: 'failed', message };
  }
}

async function runCommand(
  input: CommandInput,
  ports: Ports,
  where: { text: string }
): Promise<CommandResult> {
  const { reddit, store, config, log } = ports;
  const rerun = input.source === 'rerun';

  const comment = await reddit.getComment(input.commentId);
  where.text = permalinkFor(ports.subredditName, comment.postId, comment.id);
  const kind = parseCommand(comment.body);
  if (kind === undefined) return { outcome: 'not-a-command' };

  const author = comment.authorName;
  if (author === undefined) return { outcome: 'skipped' };
  const appUsername = await reddit.appUsername();
  if (
    [appUsername.toLowerCase(), 'automoderator'].includes(author.toLowerCase())
  )
    return { outcome: 'skipped' };

  // A removed command waits, unclaimed, for a moderator's approval to bring it back.
  if (comment.removed) {
    log(`${comment.id} ignored: the command comment is removed`);
    return { outcome: 'ignored' };
  }

  const claim = await store.claim(comment.id, { takeOver: rerun });
  if (claim === 'busy' || (claim === 'done' && !rerun))
    return { outcome: 'already-handled' };
  log(
    `${kind} by u/${author} on ${comment.id} (${input.source}${claim === 'resumed' ? ', resuming' : ''})`
  );

  const run: Run = {
    comment,
    author,
    post: await reddit.getPost(comment.postId),
    roles: new Roles(reddit, config.courierPage),
    ports,
    answeredBefore: claim === 'done',
  };
  return kind === 'close' ? closePost(run) : giveKarma(kind, run);
}

/** Runs one Reddit call, naming it in the error, so the log says which call failed. */
async function step(name: string, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (error) {
    throw new Error(`${name}: ${String(error)}`, { cause: error });
  }
}

async function closePost(run: Run): Promise<CommandResult> {
  const { comment, author, post, roles, ports } = run;
  const { reddit, store, config } = ports;
  const verdict = judgeClose(
    {
      author: await roles.party(author),
      post: {
        author: post.authorName
          ? await roles.party(post.authorName)
          : undefined,
        removed: post.removed,
        flairText: post.flairText,
      },
    },
    config
  );
  if (verdict.kind === 'refuse') {
    ports.log(`${comment.id} refused: ${verdict.reason}`);
    await reply(
      ports,
      { kind: 'comment', id: comment.id },
      post.id,
      closeRefusalText(verdict.reason)
    );
    await store.finish(comment.id);
    return { outcome: 'refused', reason: verdict.reason };
  }

  await step('setting the Trade Closed flair', () =>
    reddit.setPostFlair(post.id, config.templates.tradeClosed)
  );
  await step('locking the post', () => reddit.lockPost(post.id));
  if (!run.answeredBefore) {
    await reply(
      ports,
      { kind: 'post', id: post.id },
      post.id,
      closeSuccessText()
    );
  }
  await store.finish(comment.id);
  return { outcome: 'closed' };
}

async function giveKarma(
  kind: 'give' | 'take',
  run: Run
): Promise<CommandResult> {
  const { comment, author, post, roles, ports } = run;
  const { reddit, store, config, now } = ports;

  const parentIsPost = !isCommentId(comment.parentId);
  const parentComment = parentIsPost
    ? undefined
    : await reddit.getComment(comment.parentId);
  const parentAuthorName = parentIsPost
    ? post.authorName
    : parentComment?.authorName;

  // A command that already recorded its reward is not judged again: the answer
  // could differ now (the cap counts this very reward), and the point stands.
  const recorded = await recordedBy(kind, run, parentAuthorName);
  if (recorded) {
    return afterReward(run, recorded.receiver, recorded.sign, {
      reply: !run.answeredBefore && !recorded.imported,
    });
  }

  const giver = await roles.party(author);
  const parentAuthor = parentAuthorName
    ? await roles.party(parentAuthorName)
    : undefined;
  const postAuthor = post.authorName
    ? await roles.party(post.authorName)
    : undefined;
  const dayKey = utcDayKey(now());

  const verdict = judgeKarma(
    {
      kind,
      giver,
      parent: {
        author: parentAuthor,
        removed: parentIsPost
          ? post.removed
          : (parentComment?.removed ?? false),
        isPost: parentIsPost,
      },
      post: {
        author: postAuthor,
        removed: post.removed,
        flairText: post.flairText,
      },
      alreadyRewarded:
        giver.isMod || !parentAuthorName
          ? undefined
          : await store.earlierReward(post.id, author, parentAuthorName),
      givenToday: await store.givenToday(author, dayKey),
    },
    config
  );

  if (verdict.kind === 'refuse') {
    return refuse(
      run,
      verdict.reason,
      parentAuthorName,
      verdict.reason === 'already-rewarded'
        ? verdict.earlierCommentId
        : undefined
    );
  }

  const { receiver, sign, enforceLimits } = verdict;
  const result = await store.recordReward(
    {
      commentId: comment.id,
      postId: post.id,
      giver: author,
      receiver,
      sign,
      atMs: now(),
    },
    { enforceLimits, dayKey, dailyCap: config.dailyCap }
  );
  // Another command got there between the checks and the write.
  if (result.kind === 'already-rewarded')
    return refuse(run, 'already-rewarded', receiver, result.earlierCommentId);
  if (result.kind === 'cap') return refuse(run, 'cap', receiver);

  return afterReward(run, receiver, sign, { reply: true });
}

/**
 * The reward this command recorded on an earlier attempt, if it did. A reward
 * imported from the old bot's log is in the once-per-pair index only, and the
 * old bot answered it.
 */
async function recordedBy(
  kind: 'give' | 'take',
  run: Run,
  parentAuthorName: string | undefined
): Promise<{ receiver: string; sign: 1 | -1; imported: boolean } | undefined> {
  const { comment, author, post, ports } = run;
  const recorded = await ports.store.recordedReward(comment.id);
  if (recorded)
    return {
      receiver: recorded.receiver,
      sign: recorded.sign,
      imported: false,
    };
  if (!parentAuthorName) return undefined;
  const earlier = await ports.store.earlierReward(
    post.id,
    author,
    parentAuthorName
  );
  return earlier === comment.id
    ? {
        receiver: parentAuthorName,
        sign: kind === 'take' ? -1 : 1,
        imported: true,
      }
    : undefined;
}

async function refuse(
  run: Run,
  reason: KarmaRefusal,
  receiver: string | undefined,
  earlierCommentId?: string
): Promise<CommandResult> {
  const { comment, author, post, ports } = run;
  ports.log(`${comment.id} refused: ${reason}`);
  const text = karmaRefusalText(reason, {
    giver: author,
    ...(receiver ? { receiver } : {}),
    ...(earlierCommentId
      ? {
          earlierLink: permalinkFor(
            ports.subredditName,
            post.id,
            earlierCommentId
          ),
        }
      : {}),
  });
  await reply(ports, { kind: 'comment', id: comment.id }, post.id, text);
  await ports.store.finish(comment.id);
  return { outcome: 'refused', reason };
}

/**
 * What follows a recorded reward: the receiver's flair and the reply. The
 * point is already safe, so a flair that cannot be set is reported and does
 * not stop the reply.
 */
async function afterReward(
  run: Run,
  receiver: string,
  sign: 1 | -1,
  options: { reply: boolean }
): Promise<CommandResult> {
  const { comment, author, post, roles, ports } = run;
  const link = permalinkFor(ports.subredditName, post.id, comment.id);

  try {
    await refreshFlair(ports, receiver, roles);
  } catch (error) {
    ports.log(
      `The karma at ${link} is recorded, but the flair of u/${receiver} could not be set: ${String(error)}. Re-run the command to set it.`
    );
  }

  if (options.reply) {
    await reply(
      ports,
      { kind: 'comment', id: comment.id },
      post.id,
      karmaSuccessText(author, receiver, sign)
    );
  }

  await ports.store.finish(comment.id);
  return { outcome: 'rewarded' };
}

/** Replies under the comment, or under the post when the comment can't take a reply. */
async function reply(
  ports: Ports,
  target: ReplyTarget,
  postId: string,
  body: string
): Promise<void> {
  const text = withFooter(body, ports.config.disclaimerUrl);
  try {
    await ports.reddit.replyLocked(target, text);
  } catch (error) {
    if (target.kind === 'post') throw error;
    ports.log(
      `Replying to ${target.id} failed (${String(error)}); replying on the post instead`
    );
    await ports.reddit.replyLocked({ kind: 'post', id: postId }, text);
  }
}
