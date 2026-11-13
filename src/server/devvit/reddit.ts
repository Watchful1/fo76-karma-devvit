// The RedditPort on Devvit's Reddit client.

import { context, reddit } from '@devvit/web/server';

import { asCommentId, asPostId } from '../ids';
import { withRateLimitRetry } from '../rate-limit';
import type { CommentInfo, PostInfo, RedditPort, ReplyTarget } from '../types';

const DELETED = '[deleted]';
/** WikiPagePermissionLevel.MODS_ONLY: only moderators may view and edit the page. */
const MODS_ONLY = 2;

function authorOf(name: string | undefined): string | undefined {
  return !name || name === DELETED ? undefined : name;
}

/** Whether a wiki read failed because the page is not there, as opposed to a failure worth reporting. */
export function isMissingPage(error: unknown): boolean {
  return /404|not[ _]?found|PAGE_NOT_CREATED|does(n't| not) exist/i.test(
    String(error)
  );
}

let cachedAppUsername: string | undefined;

export const devvitReddit: RedditPort = {
  async appUsername(): Promise<string> {
    cachedAppUsername ??=
      (await reddit.getAppUser())?.username ?? context.appSlug;
    return cachedAppUsername;
  },

  async getComment(id: string): Promise<CommentInfo> {
    const comment = await reddit.getCommentById(asCommentId(id));
    return {
      id: comment.id,
      authorName: authorOf(comment.authorName),
      body: comment.body,
      parentId: comment.parentId,
      postId: comment.postId,
      removed: comment.removed || comment.spam,
      permalink: comment.permalink,
    };
  },

  async getPost(id: string): Promise<PostInfo> {
    const post = await reddit.getPostById(asPostId(id));
    return {
      id: post.id,
      authorName: authorOf(post.authorName),
      flairText: post.flair?.text ?? '',
      removed: post.removed || Boolean(post.removedByCategory),
      locked: post.locked,
      permalink: post.permalink,
    };
  },

  async isModerator(username: string): Promise<boolean> {
    const matches = await reddit
      .getModerators({ subredditName: context.subredditName, username })
      .all();
    return matches.some(
      (moderator) => moderator.username.toLowerCase() === username.toLowerCase()
    );
  },

  async readWikiPage(page: string): Promise<string | undefined> {
    try {
      return (await reddit.getWikiPage(context.subredditName, page)).content;
    } catch (error) {
      if (isMissingPage(error)) return undefined;
      throw error;
    }
  },

  async writeModWikiPage(
    page: string,
    content: string,
    reason: string
  ): Promise<boolean> {
    const subredditName = context.subredditName;
    // Updating a page that does not exist creates it.
    await reddit.updateWikiPage({ subredditName, page, content, reason });
    try {
      await reddit.updateWikiPageSettings({
        subredditName,
        page,
        listed: false,
        permLevel: MODS_ONLY,
      });
      return true;
    } catch (error) {
      console.error(`Could not restrict wiki page ${page}: ${String(error)}`);
      return false;
    }
  },

  async replyLocked(target: ReplyTarget, text: string): Promise<string> {
    const id =
      target.kind === 'comment' ? asCommentId(target.id) : asPostId(target.id);
    const posted = await withRateLimitRetry(() =>
      reddit.submitComment({ id, text })
    );
    // The reply is up: failing to distinguish or lock it must not look like a failed reply.
    try {
      await posted.distinguish();
      await posted.lock();
    } catch (error) {
      console.error(
        `Reply ${posted.id} was posted but not distinguished or locked: ${String(error)}`
      );
    }
    return posted.id;
  },

  async setUserFlair(
    username: string,
    text: string,
    templateId: string
  ): Promise<void> {
    await reddit.setUserFlair({
      subredditName: context.subredditName,
      username,
      text,
      ...(templateId ? { flairTemplateId: templateId } : {}),
    });
  },

  async clearUserFlair(username: string): Promise<void> {
    await reddit.removeUserFlair(context.subredditName, username);
  },

  async setPostFlair(postId: string, templateId: string): Promise<void> {
    await reddit.setPostFlair({
      subredditName: context.subredditName,
      postId: asPostId(postId),
      flairTemplateId: templateId,
    });
  },

  async lockPost(postId: string): Promise<void> {
    await (await reddit.getPostById(asPostId(postId))).lock();
  },
};
