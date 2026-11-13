import type {
  CloseSnapshot,
  CloseVerdict,
  Config,
  KarmaSnapshot,
  KarmaVerdict,
} from './types';

/** Whether a post flair text is one of the trading flairs, ignoring case and surrounding spaces. */
export function isTradingFlair(
  flairText: string,
  tradingFlairs: string[]
): boolean {
  const wanted = flairText.trim().toLowerCase();
  return tradingFlairs.some((flair) => flair.trim().toLowerCase() === wanted);
}

/** Runs the karma checks in order and returns the first verdict that applies. */
export function judgeKarma(
  snapshot: KarmaSnapshot,
  config: Pick<Config, 'tradingFlairs' | 'dailyCap'>
): KarmaVerdict {
  const { giver, parent, post } = snapshot;

  // Moderators skip every check, but there must be someone to reward.
  if (giver.isMod) {
    if (!parent.author) return { kind: 'refuse', reason: 'removed' };
    const sign = snapshot.kind === 'take' ? -1 : 1;
    return {
      kind: 'pass',
      receiver: parent.author.name,
      sign,
      enforceLimits: false,
    };
  }

  if (snapshot.kind === 'take')
    return { kind: 'refuse', reason: 'unauthorized' };
  if (!isTradingFlair(post.flairText, config.tradingFlairs))
    return { kind: 'refuse', reason: 'wrong-post-type' };
  if (
    parent.author &&
    giver.name.toLowerCase() === parent.author.name.toLowerCase()
  ) {
    return { kind: 'refuse', reason: 'self' };
  }
  if (parent.isPost) return { kind: 'refuse', reason: 'top-level' };
  if (!parent.author || parent.removed || !post.author || post.removed)
    return { kind: 'refuse', reason: 'removed' };

  const exemptByName = new Map<string, boolean>();
  for (const party of [giver, parent.author, post.author]) {
    exemptByName.set(party.name.toLowerCase(), party.isMod || party.isCourier);
  }
  const counted = [...exemptByName.values()].filter((exempt) => !exempt).length;
  if (counted > 2) return { kind: 'refuse', reason: 'too-many-users' };

  if (snapshot.alreadyRewarded !== undefined) {
    return {
      kind: 'refuse',
      reason: 'already-rewarded',
      earlierCommentId: snapshot.alreadyRewarded,
    };
  }
  if (snapshot.givenToday >= config.dailyCap)
    return { kind: 'refuse', reason: 'cap' };

  return {
    kind: 'pass',
    receiver: parent.author.name,
    sign: 1,
    enforceLimits: true,
  };
}

/** Decides whether the author may close the post. */
export function judgeClose(
  snapshot: CloseSnapshot,
  config: Pick<Config, 'tradingFlairs'>
): CloseVerdict {
  const { author, post } = snapshot;
  if (author.isMod) return { kind: 'pass' };
  if (
    !post.author ||
    author.name.toLowerCase() !== post.author.name.toLowerCase()
  ) {
    return { kind: 'refuse', reason: 'not-op' };
  }
  if (!isTradingFlair(post.flairText, config.tradingFlairs))
    return { kind: 'refuse', reason: 'not-trading' };
  return { kind: 'pass' };
}
