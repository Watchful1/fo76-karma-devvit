// Who is a moderator and who is a courier, for the checks and the flair.

import type { Party, RedditPort } from './types';

function courierName(item: string): string {
  return item
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^\/?u\//i, '')
    .toLowerCase();
}

/**
 * Reads the courier list from the wiki page's YAML. The page is a `couriers:`
 * key followed by `- name` items, or by `[name, name]` on the same line;
 * `# comments` and anything else are ignored. Names come back lowercased.
 */
export function parseCourierList(markdown: string | undefined): Set<string> {
  const couriers = new Set<string>();
  if (!markdown) return couriers;
  let inList = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    // A YAML comment starts the line or follows a space.
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const key = /^couriers\s*:(.*)$/i.exec(line);
    if (key) {
      inList = true;
      const inline = /^\s*\[(.*)\]\s*$/.exec(key[1] ?? '');
      for (const item of inline?.[1]?.split(',') ?? []) {
        const name = courierName(item);
        if (name) couriers.add(name);
      }
      continue;
    }
    // A line of dashes only is a YAML document marker, not an item.
    if (/^-+$/.test(line)) continue;
    if (inList && line.startsWith('-')) {
      const name = courierName(line.slice(1));
      if (name) couriers.add(name);
      continue;
    }
    // Another top-level key ends the list.
    if (inList && /^[A-Za-z_]+\s*:/.test(line)) inList = false;
  }
  return couriers;
}

/** Looks up roles for the people in one command, reading the courier page once. */
export class Roles {
  private couriers: Promise<Set<string>> | undefined;
  private readonly mods = new Map<string, Promise<boolean>>();

  constructor(
    private readonly reddit: RedditPort,
    private readonly courierPage: string
  ) {}

  async isCourier(username: string): Promise<boolean> {
    this.couriers ??= this.reddit
      .readWikiPage(this.courierPage)
      .then(parseCourierList);
    return (await this.couriers).has(username.toLowerCase());
  }

  async isMod(username: string): Promise<boolean> {
    const key = username.toLowerCase();
    let pending = this.mods.get(key);
    if (!pending) {
      pending = this.reddit.isModerator(username);
      this.mods.set(key, pending);
    }
    return pending;
  }

  async party(username: string): Promise<Party> {
    const [isMod, isCourier] = await Promise.all([
      this.isMod(username),
      this.isCourier(username),
    ]);
    return { name: username, isMod, isCourier };
  }
}
