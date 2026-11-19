# What the bot does

The rules the karma bot of r/Fallout76Marketplace follows, for moderators and
maintainers. The code that applies each rule is named where it helps.

## Commands

A command is a comment that starts with one of these, in any letter case,
after trimming and removing backslashes (Reddit's editor escapes a leading `+`
or `-`). Text after the command is ignored.

| Command                                        | Effect                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `+karma` or `karma+`, with any number of signs | Gives the parent's author one karma point |
| `-karma` or `karma-`, with any number of signs | Takes one point. Moderators only          |
| `!close`, `close!`                             | Closes the post                           |

- A command that a filter such as AutoModerator removed gets no reply. When a moderator approves it, it runs then.
- Each comment runs at most once, however many times Reddit delivers it.
- Comments by the bot and by AutoModerator are ignored, and so are edits.
- While the **Enabled** setting is off, every command is ignored. The menu items keep working.

## Giving karma

For a user who is not a moderator, the checks run in this order, and the first
that fails gets a reply (`src/server/checks.ts`):

1. **Trading post only:** the post's flair is one of the trading flairs (`XBOX`, `PlayStation`, `PC`; a setting), ignoring case.
2. **No self-reward:** the giver is not the author of the comment they reply to.
3. **Must reply to a comment:** a top-level command is refused.
4. **Nothing deleted or removed:** the comment replied to and the post are still there.
5. **Two parties only:** the giver, the receiver and the post's author are at most two people, not counting moderators and couriers.
6. **Once per pair per post:** the giver has not already rewarded the receiver in this post. The reply links the earlier command.
7. **Daily cap:** the giver has given fewer than the cap (10, a setting) since midnight UTC.

`-karma` from a user who is not a moderator is refused.

Moderators skip every check. They can give or take karma anywhere, and a
top-level command targets the post's author. A moderator's command under a
deleted user's comment still gets the "deleted or removed" reply.

A reward is recorded in one Redis transaction, then the receiver's flair is
set, then the bot replies. Two commands at once can never give two points
where one is allowed. If the flair or the reply fails, the point stands, the
log says so, and **Re-run karma command** repairs it.

## Closing a post

- **Who:** the post's author, if the post has a trading flair, or any moderator, on any post.
- **Action:** sets the Trade Closed post flair, locks the post, and leaves a comment saying so.

## Flair

The receiver's flair is rebuilt after every change to their karma:

- **Text:** `<platform emojis> <label>: <total>`. The emojis are `:xbox:`, `:playstation:` and `:pc:` for the user's verified gamertags; the label is `Verified Courier` for couriers and `Karma` otherwise; the total is the subreddit karma plus the Market76 karma.
- **Template:** moderators and couriers get their own template. Everyone else gets the template for karma 0–49, 50–99, or 100 and up. Negative karma uses the 0–49 template.

Only the receiver's flair changes. Nothing refreshes flairs on a schedule.

## Moderators and couriers

- **Moderators** are the subreddit's moderator list.
- **Couriers** are listed on the wiki page `custom_bot_config/courier_list` (a setting): a `couriers:` line followed by `- username` lines. A missing page means no couriers.

Both are read once per command.

## Replies

- Every reply ends with the bot footer and the disclaimer link, is distinguished as a moderator comment, and is locked.
- If Reddit asks the bot to wait 10 seconds or less before replying, it waits and tries once more.
- If the command comment can no longer be replied to, the reply goes on the post.
- The texts are in `src/server/replies.ts`.

## Menu items

| Item                     | Who        | On            | Does                                                                                                                                                              |
| ------------------------ | ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Karma profile**        | everyone   | post, comment | Shows the author's karma, Market76 karma and verified gamertags                                                                                                   |
| **Edit karma profile**   | moderators | post, comment | Edits the author's karma, Market76 karma, gamertags and gamertag ids, and rebuilds the flair. A reward given while the form is open is kept                       |
| **Karma lookup**         | moderators | subreddit     | Opens either profile item for a username, for a user whose posts are gone                                                                                         |
| **Re-run karma command** | moderators | comment       | Runs a comment's command again, even while **Enabled** is off. A reward already on record is not given twice; the flair is rebuilt. Repairs a lost flair or reply |
| **Export karma rewards** | moderators | subreddit     | Writes the rewards since a date to a wiki page only moderators can see, 2,000 to a page                                                                           |
| **Import karma data**    | moderators | subreddit     | Loads the bundled snapshot, or a smaller file from a wiki page, in the background. Only while **Enabled** is off                                                  |

Every moderator item checks on the server that the user is a moderator.

**Deleting a profile**, a tick box on **Edit karma profile**, is how a user's
data is removed on request. It removes the profile and clears the flair. In
the records of the user's trading partners, the username becomes a
placeholder such as `[deleted-4f2a9c1e]`, so their trades still count.

## Logs

The app's log (`npm run logs`) has a line for every command answered, every
moderator edit, every failure, and each step of an import.

## Import

The old bot's karma was moved in once, from a snapshot that
`scripts/compact-export.mjs` builds from its database export and that is
bundled into one release. The import loads it in batches through a scheduler
job, resumes where it stopped after a failure, and overwrites each imported
user's karma, Market76 karma and gamertags. A smaller file of changes since the
snapshot can be loaded the same way from a wiki page.
