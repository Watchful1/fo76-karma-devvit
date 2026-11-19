# Features

What the Devvit app does once it replaces the PRAW bot
([Fallout76MarketplaceKarmaBot](https://github.com/r-Fallout76Marketplace/Fallout76MarketplaceKarmaBot))
and the Pip-Boy 2000 app on r/Fallout76Marketplace. Where the behaviour
differs from the old bot, the difference is marked **Changed**.

## 1. Commands

A command is a comment whose text, after trimming and removing backslashes
(Reddit's editor escapes a leading `+` or `-`), starts with one of these in
any letter case. Text after the command is ignored.

| Command                                        | Effect                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `+karma` or `karma+`, with any number of signs | Gives the parent's author one karma point |
| `-karma` or `karma-`, with any number of signs | Takes one point. Moderators only          |
| `!close`, `close!`                             | Closes the post                           |

- Commands arrive through `onCommentCreate`, which fires after Reddit's filters have run. A command that a filter removed gets no reply, `!close` included; when a moderator approves it, `onModAction` (`approvecomment`) runs it then. **Changed:** the old bot refused filtered commands with a reply, and never saw the approval.
- Each comment is run at most once, however many times its events arrive, and however much later a moderator approves it.
- Comments by the app account and by AutoModerator are ignored. Edits are ignored.
- While the **Enabled** setting is off, every command is ignored, `!close` included. The menu items keep working.

## 2. Giving karma

For a non-moderator, the checks run in this order, and the first failure gets a reply:

1. **Trading post only:** the post's flair text equals one of the trading flairs (`XBOX`, `PlayStation`, `PC`; a setting), ignoring case.
2. **No self-reward:** the giver is not the author of the parent.
3. **Must reply to a comment:** a top-level command is refused.
4. **Nothing deleted or removed:** the parent and the post are intact. A command comment that is itself removed is not refused but ignored, since approval will bring it back (section 1).
5. **Two parties only:** giver, receiver and post author are at most two distinct people, not counting moderators and couriers.
6. **Once per pair per post:** the same giver has not already rewarded the same receiver in this post. The reply links the earlier command. Two commands for the same pair seconds apart give exactly one point.
7. **Daily cap:** the giver has given fewer than the cap (10, a setting) since midnight UTC. Two commands at once from a giver one short of the cap give one point and one refusal. **Changed:** the old bot reset at the server's local midnight while telling users UTC.

`-karma` from a non-moderator is refused with no other checks.

Moderators skip every check: they can give or take karma anywhere, including on a top-level comment, which targets the post author. There must still be someone to reward: a moderator's command under a deleted user's comment gets the "deleted or removed" reply.

## 3. What a successful command does

1. **Claims the comment:** sets `answered:<commentId>` to a `pending` token that carries its start time, if the key is unset. A `done` key means the command was answered and is not run again. A `pending` younger than 45 seconds means another request is handling the comment right now (a request is killed at 30), so this one stops. An older `pending` is an attempt that died, and this request takes it over.
2. **Skips to step 4 if this comment's reward is already on record** from an earlier attempt. The checks are not run again: the daily count already includes this reward, and the point stands whatever has changed since.
3. **Records everything in one Redis transaction:** the per-comment entry (the gate that makes one comment give at most one point, for moderators too), the once-per-pair entry and the daily cap (the gates for checks 6 and 7, for non-moderators, so a race gives one point), the karma increment, the day's count, the global event, and the giver's and receiver's history.
4. Sets the receiver's flair (section 5). A failure here is logged and does not stop the reply.
5. Replies.
6. Sets `answered:<commentId>` to `done`.

A failure after step 3 never gives a second point; it can lose the flair update or the reply, which the log reports and a moderator's **Re-run karma command** repairs. **Changed:** the old bot updated the score with a read-then-write and logged, scored and replied concurrently.

## 4. Closing a post

- **Who:** the post's author, if the post has a trading flair; or any moderator, on any post.
- **Action:** sets the "Trade Closed" flair (a template id setting), locks the post, and leaves a top-level comment saying so.
- **Refusals:** a non-author gets "only the OP or mods"; the author of a non-trading post gets "this type can't be closed".

## 5. Flair

The receiver's flair is rebuilt from their profile after every change:

- **Text:** `<platform emojis> <label>: <total>`, where the emojis are `:xbox:`, `:playstation:` and `:pc:` for the platforms of the user's verified gamertags, the label is `Verified Courier` for couriers and `Karma` otherwise, and the total is local karma plus Market76 karma.
- **Template:** mods and couriers get the mod template; otherwise local karma 0–49, 50–99 and 100 and up pick the three tier templates (all five template ids are settings). **Changed:** the old bot gave exactly 49 and 99 the 100+ template.
- Negative karma uses the lowest tier. Only the receiver's flair is touched; nothing refreshes flair on a schedule.

## 6. Roles

- **Moderators:** the subreddit's moderator list, read per command.
- **Couriers:** the YAML list on the wiki page `custom_bot_config/courier_list` (page name a setting), matched case-insensitively, read per command. Other tools read the same page, so it stays on the wiki. The app reads a `couriers:` key followed by `- name` items or an inline `[name, name]` list, with `#` comments; it is not a full YAML parser. A missing page means no couriers; a page that cannot be read fails the command, so a courier's flair is never rewritten as an ordinary user's by a passing error.

## 7. Replies

- Every reply ends with the "performed by a bot" footer and the disclaimer link, is distinguished as a moderator comment, and is locked.
- A reply that Reddit rate-limits is retried once if the wait it names is under 10 seconds; otherwise the failure is logged and the point stands.
- If the command comment can no longer be replied to, the reply goes on the post instead.
- The wording is kept from the old bot, with two changes: the "deleted or removed" reply no longer mentions the user's own comment being removed (that case gets no reply now) and does mention the comment replied to being gone, and the daily-cap reply matches the UTC reset.

## 8. Moderator and user menu items

| Item                     | Who        | On            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Karma profile**        | everyone   | post, comment | Read-only form: the author's local karma, Market76 karma, gamertag per platform (as Pip-Boy showed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Edit karma profile**   | moderators | post, comment | Edit karma, Market76 karma, gamertags and gamertag ids. Karma changes by the difference from the value the form opened with, so a reward given while the form was open is kept. Saving rebuilds the flair and writes a history entry naming the moderator and the old and new values. A tick box deletes the profile: the data-deletion path. It removes the profile, the history and the index entries, and replaces the name with a unique placeholder such as `[deleted-4f2a9c1e]` in the trading partners' histories and the event log, so their record of the trades stays and the name does not |
| **Karma lookup**         | moderators | subreddit     | A username field that opens the two profile items above for a user whose posts are gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Re-run karma command** | moderators | comment       | Runs the comment's command again, taking over any earlier attempt, even while **Enabled** is off. A reward already on record is not given again: the flair is rebuilt, and a command that was already answered gets no second reply. A refusal is judged again, since its reason may be gone. It repairs a lost flair update or reply, and sweeps commands posted while the bot was off                                                                                                                                                                                                               |
| **Export karma rewards** | moderators | subreddit     | Writes the rewards since a date or time to a wiki page only moderators can see, at most 2,000 a page, and opens the page on old.reddit.com, the only place the old wiki shows; a longer export says where to continue. The rollback and audit export                                                                                                                                                                                                                                                                                                                                                  |
| **Import karma data**    | moderators | subreddit     | Shows where the last import stands, and loads the bundled snapshot, or a delta from a wiki page (section 11). Refuses while **Enabled** is on, and stops if it is turned on mid-import                                                                                                                                                                                                                                                                                                                                                                                                                |

Every moderator item checks on the server that the user moderates the subreddit; hiding the item is not the check.

## 9. Failures

The app's log, read with `devvit logs`, holds a line for:

- an error that stopped a command from completing, with the comment's id;
- a reward whose flair could not be set, with the comment's permalink;
- an import that finished, failed or was stopped.

The app sends nothing outside Reddit.

## 10. Settings

All per subreddit, editable by the moderators on the app's settings page:

| Setting                                                                     | Default                                                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Enabled (the kill switch; off means commands are ignored)                   | off                                                                                                              |
| Daily cap                                                                   | 10                                                                                                               |
| Trading flair texts                                                         | `XBOX, PlayStation, PC`                                                                                          |
| Five flair template ids: mods and couriers, 0–49, 50–99, 100+, Trade Closed | the live subreddit's ids, as the old bot had them in its code. A field that is cleared falls back to its default |
| Courier wiki page                                                           | `custom_bot_config/courier_list`                                                                                 |
| Disclaimer link                                                             | the current post on u/Vault-TecTradingCo                                                                         |

## 11. Data

Everything lives in the install's Redis. Usernames are lowercased in keys and fields; times are milliseconds.

| Key                                                                              | Holds                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `karma` (hash, field per username)                                               | local karma as an integer, so `hIncrBy` can change it atomically                                                                                                |
| `profiles` (hash, field per username)                                            | `{ redditUsername, m76Karma, gamertags[] }`                                                                                                                     |
| `rewards` (hash, field `<postId>                                                 | <giver>                                                                                                                                                         | <receiver>`) | the comment id of the pair's latest reward in the post. Never expires |
| `recorded` (hash, field per command comment id)                                  | the reward that comment recorded, as JSON. Makes a comment give at most one point. Not filled by the import: an imported reward is known by its `rewards` entry |
| `given:<giver>:<UTC date>`                                                       | the day's count. Expires after two days                                                                                                                         |
| `answered:<commentId>`                                                           | `pending:<start time>:<token>` or `done`. Expires after a year                                                                                                  |
| `events` (sorted set by time)                                                    | every reward: comment id, giver, receiver, sign. Feeds the export and the delta. When a profile is deleted, its name here becomes the placeholder               |
| `history:<username>` (sorted set by time)                                        | the user's rewards given and received and profile edits                                                                                                         |
| `import:progress`, `meta:import:source`, `meta:import:status`, `meta:import:run` | the import's row count and done flag, its source, what the menu item shows, and the id of the chain of hops allowed to run                                      |

**Import.** The snapshot (all profiles, all 34,305 rewards) ships in the app and loads through a chained scheduler job, batches of 300 rows for up to 15 seconds a hop with 2 seconds between hops, so it never meets the 30-second limit and resumes where it stopped. Starting an import reads and checks the whole file first and reports the row count; a source that already finished needs a tick box to load again, since an import overwrites karma with the file's values. What it does with the old data:

- merges the one duplicate profile (`IcarusLex`, two rows) keeping the non-zero one, keeps the 22 negative scores and the 69,420 as they are, and skips the 1,867 profiles that are all zero with no gamertags;
- creates history for the roughly 400 users who are in the log but have no profile;
- stores the comment id, not the permalink, and builds the link as `/r/<sub>/comments/<post>/_/<comment>/`;
- marks imported history entries with an unknown sign, since the old log has none;
- for the 31 duplicate (giver, receiver, post) groups, the index keeps the last and the history keeps all;
- reports rows processed (profiles kept plus rewards: 47,614 for the October export), the same total `scripts/compact-export.mjs` prints.

A **delta** (the rewards since the snapshot, the profiles of the users in them, and every profile that differs from the snapshot) is built with `--since` and `--base` and loads the same way from a wiki page. A delta keeps all-zero profiles, since they may replace a non-zero one. Every import ends by setting today's `given:` counts from today's events.

## 12. Not carried over

- Pastebin, and the Discord traceback link that depended on it.
- The systemd service, restart loop, cooldown and log rotation.
- The Karma API, MongoDB, and the Pip-Boy 2000 app.
- The Market76 karma transfer bot. Its number stays on the profile, editable by moderators, and the automatic transfer can be added later from a link to the user's own Market76 post. Until then, users who ask are sent to the moderators, which the announcement should say.
