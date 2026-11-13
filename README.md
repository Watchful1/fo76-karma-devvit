# fo76-karma-devvit

The karma bot of r/Fallout76Marketplace as a Devvit app. It replaces the PRAW
bot [Fallout76MarketplaceKarmaBot](https://github.com/r-Fallout76Marketplace/Fallout76MarketplaceKarmaBot),
its Karma API and MongoDB, and the Pip-Boy 2000 profile app.

- What it does: [docs/features.md](docs/features.md)
- Terms and privacy policy: [docs/legal/](docs/legal/)

## How it works

Users give each other karma with `+karma` comments under trading posts. The
`onCommentCreate` trigger runs each command through the checks, records the
reward in Redis in one transaction, rebuilds the receiver's flair and replies.
A command that a filter removed runs when a moderator approves it
(`onModAction`). Moderators get menu items to look up, edit, export and
import karma. Everything the moderators might tune is a subreddit setting,
including a kill switch that defaults to off.

## Layout

| Path                                                            | Holds                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `devvit.json`                                                   | The app definition: triggers, scheduler, menu items, forms, settings, permissions                                                       |
| `src/routes/`                                                   | The platform-facing endpoints: triggers, menu items, forms, the import job. `guard.ts` checks the moderator on every moderator endpoint |
| `src/server/types.ts`                                           | The shared types and the ports the logic is written against                                                                             |
| `src/server/commands.ts`, `checks.ts`, `flair.ts`, `replies.ts` | Pure logic, tested without the platform                                                                                                 |
| `src/server/karma.ts`                                           | One command from start to finish, through the ports                                                                                     |
| `src/server/store.ts`                                           | Redis keys and the reward transaction                                                                                                   |
| `src/server/import.ts`                                          | Loading a snapshot or a delta, one batch at a time                                                                                      |
| `src/server/devvit/`                                            | The ports' real implementations: Reddit, Discord, settings                                                                              |
| `src/server/data/snapshot.json`                                 | The compacted export. A placeholder in git; the real file ships only in the cutover version                                             |
| `scripts/compact-export.mjs`                                    | Mongo export → snapshot or delta file                                                                                                   |

## Commands

| Command                                                                                  | Does                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                                            | Playtest on r/fo76_karma_dev_dev                                                                                                 |
| `npm run verify`                                                                         | Type-check, lint, test and build                                                                                                 |
| `node scripts/compact-export.mjs <export-dir> src/server/data/snapshot.json`             | Build the snapshot for the cutover version                                                                                       |
| `node scripts/compact-export.mjs <export-dir> delta.json --since <ms> --base <snapshot>` | Build a delta to paste on a wiki page: the rewards since the snapshot's newest, and every profile that differs from the snapshot |

## Fetch Domains

| Domain        | Why                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord.com` | Sends error alerts and daily-cap notices to the moderators' Discord channel through a webhook they set in the app's settings, as the PRAW bot did. |

This app is part of the App Migration Program: it migrates the Data API app
Fallout76MarketplaceKarmaBot.
