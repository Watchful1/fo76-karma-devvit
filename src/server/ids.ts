export type CommentId = `t1_${string}`;
export type PostId = `t3_${string}`;

export function isCommentId(id: string): id is CommentId {
  return id.startsWith('t1_');
}

/** Accepts a post id with or without its t3_ prefix. */
export function asPostId(id: string): PostId {
  const trimmed = id.trim();
  return (trimmed.startsWith('t3_') ? trimmed : `t3_${trimmed}`) as PostId;
}

export function asCommentId(id: string): CommentId {
  const trimmed = id.trim();
  return (trimmed.startsWith('t1_') ? trimmed : `t1_${trimmed}`) as CommentId;
}
