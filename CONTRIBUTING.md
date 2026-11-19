# Working on the karma bot

The bot is a [Devvit Web](https://developers.reddit.com/docs) app: a small
TypeScript server that Reddit runs, with Redis storage provided by Reddit.
What it does, rule by rule, is in [docs/features.md](docs/features.md).

## Setup

You need Node 24 (see `.nvmrc`) and a Reddit account.

```bash
npm ci
npx devvit login
npm run verify
```

`npm run verify` type-checks, lints, runs the tests and builds. The tests use
in-memory fakes of Reddit and Redis, so they need no login or network.

## Layout

| Path                  | Holds                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `devvit.json`         | The app definition: triggers, menu items, forms, settings, permissions          |
| `src/routes/`         | The endpoints Reddit calls: triggers, menu items, forms, the import job         |
| `src/server/`         | The logic: commands, checks, flair, replies, storage, import                    |
| `src/server/devvit/`  | The real Reddit and Redis clients behind the interfaces the logic uses          |
| `src/server/testing/` | The fakes the tests use                                                         |
| `scripts/`            | `compact-export.mjs`, which turns the old bot's database export into a snapshot |

Settings have their defaults in two places, `devvit.json` and
`src/server/settings.ts`. A test fails if they differ.

## Trying a change on Reddit

Uploaded versions can only be installed on subreddits with fewer than 200
members, so test on a subreddit of your own:

1. Create the subreddit and turn on user and post flair.
2. Add post flairs named `XBOX`, `PlayStation`, `PC` and `Trade Closed`.
3. Add four user flair templates: one each for moderators and couriers, karma
   0 to 49, karma 50 to 99, and karma 100 and up.
4. Run `npx devvit playtest <your subreddit>`. It installs the app there and
   reloads it on every save.
5. In the app's settings on that subreddit, paste the five flair template ids
   (from **Copy ID** on the flair pages) and tick **Enabled**. A template id
   the subreddit does not have makes Reddit answer `403 Forbidden`.
6. Optionally, add a wiki page `custom_bot_config/courier_list` holding a
   YAML list: `couriers:` followed by `- username` lines.

`npm run dev` playtests on the subreddit named in `devvit.json` under `dev`.

## Releasing

1. Run `npm run verify`.
2. Run `npm run release`. It bumps the version, uploads the code and asks
   Reddit to review it; reviews have taken minutes, and can take a few days.
3. Once approved, update the app on r/Fallout76Marketplace from its page in
   the subreddit's installed apps.

Releasing needs a Reddit account that is a developer of the
`vault-tectradingco` app. Ask a current maintainer to add you.

Never uninstall the app from r/Fallout76Marketplace: that deletes all its
karma data. Updating a version keeps it.

## Logs

`npm run logs` streams the app's log on r/Fallout76Marketplace. Every command
it answers is a line like `t1_abc123 (create): rewarded`, and every failure
starts with the comment id and says what failed.

## The karma data

The old bot's karma was moved in once, from a snapshot bundled into the app.
`src/server/data/snapshot.json` is tracked only as an empty placeholder: the
real file holds usernames and gamertags and must never be committed. CI fails
if the placeholder is changed.
