# Signal RSS

**English** · [简体中文](README.zh.md)

Subscribe to RSS, Atom and RSS 1.0 (RDF) feeds, read them in a dedicated reader tab inside Obsidian, and turn any article into a Markdown note in your vault.

## Features

- **Subscriptions** — add a feed by pasting either its feed URL or the site's home page; RSS 2.0, Atom and RSS 1.0 (RDF) are supported. Feeds can be sorted into groups, and groups themselves can be created, renamed and deleted from the subscription tree.
- **Subscription list in the right sidebar** — the search box, the filters, the feed tree, the article list and the drag handle between them all live in the right sidebar. The list is the only place you pick from, and what it picks is what the reader shows.
- **Reader tab** — the selected article opens in its own tab in the main area. Its title becomes the tab label and the view header; a one-row toolbar above the body carries star, read/unread, fetch full text, open in the browser and save as note.
- **Full text extraction** — when a feed only ships a summary, the article page is fetched and its main content extracted, so you read (and keep) the whole thing.
- **Markdown export** — save any article as a note. The destination folder, the file name and both the front matter and the body templates are configurable.
- **Automatic refresh** — feeds are polled in the background at an interval you choose. Set it to 0 to switch automatic refresh off. The ribbon icon's tooltip carries the current unread count.
- **Read state** — unread counts per feed and per group, a global unread count, read/unread toggling and a star list.
- **Search** — filters the article list as you type, matching against titles, authors and summaries.
- **OPML** — import an OPML file exported by another reader, and export your subscriptions back out.
- **Interface language** — English and Simplified Chinese, following the Obsidian language setting.

## Installation

### From the community plugin directory

Search for "Signal RSS" under **Settings → Community plugins → Browse**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them into `<your vault>/.obsidian/plugins/signal-rss/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Usage

1. Click the RSS icon in the ribbon. The subscription list opens in the right sidebar.
2. Add a feed. The empty list offers an **Add feed** button, and **Signal RSS: Add feed** in the command palette works from anywhere; with feeds already sorted into groups, right-clicking a group header gives you an **Add feed…** that pre-fills that group. Pasting a site home page works too — Signal RSS looks for the feed link on the page.
3. Articles show up under the three filters at the top of the list. Clicking one opens it in a reader tab in the main area.
4. Use **Save as note** in the reader to write the article into your vault.

Right-click a feed in the sidebar for refresh, mark-as-read, edit and delete. The menu behind a group header also carries OPML import and export, mark-all-read/unread for that group, and rename/delete for the group itself — deleting a group moves its feeds back to **Ungrouped** instead of deleting them, and renaming it takes them along.

Right-click the empty space under the subscription tree to create a group, or to add a feed without filing it into one. A group you create stays in the tree even while it holds no feeds — instead of an empty space it shows an **Add feed…** row, which pre-fills the group — until you delete it again.

The list only ever lives in the sidebar, so there is no position to choose: **Signal RSS: Toggle the subscription list sidebar** shows and hides it, and while it is hidden the reader's empty state offers a button that brings it back.

### The list pane

- **Search box** — filters the article list as you type, paused briefly so typing does not fight the caret.
- **Three filters** — **All articles**, **Unread** and **Starred**, each carrying its own count. Picking a feed in the tree narrows the list to that feed instead.
- **Feed tree** — a group header folds and unfolds on click, and shows its own unread total while folded.
- **Drag handle** — the divider between the tree and the article list resizes the two. Drag it, double-click it to go back to the default, or focus it and use the arrow keys (hold Shift for bigger steps).

## Commands

| Command | Description |
| --- | --- |
| Open RSS reader | Show the reader tab — empty until an article is picked |
| Refresh all feeds | Fetch every subscription |
| Add feed | Open the add-feed dialog |
| Import OPML file | Import subscriptions from an OPML file |
| Export OPML file | Write an OPML file to the vault root |
| Save current article as note | Save the article open in the reader |
| Mark all articles as read | Clear the unread state everywhere |
| Collapse all groups | Fold every group in the feed tree shut |
| Expand all groups | Unfold every group in the feed tree |
| Toggle the subscription list sidebar | Show or hide the list in the right sidebar |

The three commands that need something to act on — save the current article, collapse all groups, expand all groups — are hidden from the command palette while they would do nothing.

## Settings

The settings page is split into four tabs.

### Basic settings

| Setting | Description |
| --- | --- |
| Automatic refresh interval | Background polling interval in minutes; 0 turns it off |
| Request timeout | How long to wait for a feed before giving up (5–120 s) |
| Articles kept per feed | Upper bound on stored articles per feed; the oldest are dropped past it |
| Mark as read when opened | Clear the unread flag as soon as an article is opened |
| Fetch full text when opened | Fetch the article page when a feed only ships a summary |
| Fetch full text while refreshing | Do that during refresh instead, so articles are readable offline |
| Custom cache folder | Vault-relative folder holding the caches, with a **Migrate cache** button beside it |

### Subscriptions

The list of everything you subscribe to, with **Import OPML**, **Export OPML** and **Add feed** on the toolbar, a search box that filters by title, group or address, and one row per feed showing its title, its group and three actions: refresh, edit and delete.

### Note export

| Setting | Description |
| --- | --- |
| Open the note after saving | Open the created note in a new tab |
| Note folder | Destination folder for saved articles; created when missing |
| File name template | Template for the note file name |
| Front matter template | YAML written between the `---` markers at the top of every saved note |
| Note body template | Wrapper around the article body |

### About

Shows the version, a **Check for updates** button that opens the plugin's page in Obsidian, and **Reset settings**, which restores every option on the page to its default while keeping your subscriptions.

### Template variables

Both the file name and the two templates accept these variables:

| Variable | Value |
| --- | --- |
| `{{title}}` | Article title |
| `{{feed}}` | Feed title, falling back to its address |
| `{{group}}` | Group the feed is filed under |
| `{{author}}` | Article author |
| `{{link}}` | Article address |
| `{{published}}` | Publication date, `YYYY-MM-DD` by default |
| `{{created}}` | Date the note is written, `YYYY-MM-DD` by default |
| `{{summary}}` | Summary as shipped by the feed |
| `{{content}}` | The article body, converted to Markdown — body template only |

A date variable takes a Moment.js format after a colon, for example `{{published:YYYY-MM-DD HH:mm}}`. Appending `:yaml` escapes a value for the front matter, which is how the default front matter template writes `{{title:yaml}}` and `{{author:yaml}}`. The default file name template is `{{published:YYYY-MM-DD}} {{title}}`, and the default note folder is `RSS Inbox`.

## Where data lives

- Subscriptions, read/starred state and settings are stored in the plugin's `data.json`.
- Article content is cached under `.signal-rss/` at the root of your vault, one JSON file per feed — a dot folder, so it stays out of the file explorer and out of Obsidian's index. The folder is configurable; changing it does not move anything by itself, and **Settings → Basic settings → Custom cache folder → Migrate cache** is the deliberate second step that pulls the caches across from the folder previously in use, merging rather than overwriting so no read flag or extracted body is lost.
- Versions up to 0.7.0 kept the caches inside the plugin folder instead (`<config folder>/plugins/<plugin id>/cache/`, with `.obsidian` as the usual config folder). If you have been using the plugin since before it was renamed from `rss-subscribe` to `signal-rss`, a cache left behind under the old plugin id needs to be moved into the current folder by hand.
- Nothing is written into your notes folder unless you explicitly save an article.

## Privacy and network access

This plugin makes network requests, but only to the addresses you subscribe to:

- Feed URLs are requested to fetch articles.
- An article's own URL is requested when full text extraction runs.

There is no account, no telemetry, no analytics and no third-party service. Requests go through Obsidian's `requestUrl` API, so they are not sent to any proxy of ours.

## Troubleshooting a feed that will not load

Some addresses are unreachable, rate-limited, or hang on the server side. Signal RSS gives up after the configured request timeout and reports the reason rather than waiting indefinitely, and it stops early when the host itself is unreachable instead of retrying every guessed path.

A public **RSS bridge** (such as `rsshub.app` or one of the community instances) is often the culprit rather than the site you actually want:

- Most public instances are heavily rate-limited and drop requests under load.
- They may be unreachable from some networks and regions.
- A single route can be broken on an otherwise healthy instance — the instance root answers instantly while one specific route never returns, because the instance's own upstream fetch is hanging. Try the same route on a different instance, or [self-host an instance](https://docs.rsshub.app/deploy/), which is by far the most reliable option.

To confirm a feed works before subscribing, open its URL in a browser. A working feed shows raw XML; a broken one shows an error, a blank page, or spins forever.

## Security notes

Feed content is third-party markup and is treated as untrusted:

- Before anything is displayed or saved, it is reduced to a small allowlist of tags and attributes. Attributes such as `on*` handlers, `style`, and any `javascript:` URL are dropped by construction.
- Article bodies are inserted with Obsidian's `sanitizeHTMLToDom`; `innerHTML` is not used anywhere in this plugin.
- Code blocks coming from a feed are re-fenced with a delimiter longer than any backtick run inside them, so a feed cannot smuggle a `dataviewjs` or `templater` fence into a saved note and get it executed later.
- Files are only ever created inside your vault, and only when you ask for a note to be saved.

## Mobile

The plugin works on mobile (`isDesktopOnly: false`). It uses only cross-platform Obsidian APIs — no Node.js file system access.

The layout adapts to a phone rather than merely fitting on it:

- The subscription list lives in the right sidebar, which on a phone is a drawer. Tapping the RSS icon in the ribbon opens it; picking an article folds it away so the article is visible right away.
- Long-pressing a subscription, a group header, or the empty space under the tree opens its menu (refresh, mark as read, edit, delete, OPML, mark all, new group, rename, delete group), since there is no right-click.
- Touch targets, the search box, and the reader's margins are sized for a thumb and for iOS' minimum input font size.

## Development

Requires Node.js 18 or newer (CI uses 22) and Obsidian 1.7.2 or newer.

```bash
npm install
npm run dev     # watch build
npm run build   # type check + production bundle
```

Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/signal-rss/` to try a build.

### Layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Plugin entry: commands, view registration, shared list state, refresh and feed handling |
| `src/settings.ts` | The tabbed settings page |
| `src/i18n/index.ts` | Every user-visible string, in `en` and `zh-cn` |
| `src/core/` | Feed parsing, fetching, error normalisation, full text extraction, OPML, HTML sanitising, the cache store |
| `src/view/` | The sidebar list pane and the reader tab |
| `src/note/` | Template rendering and note writing |
| `src/ui/` | The add-feed and group-name dialogs |
| `styles.css` | Plugin styles, using Obsidian's CSS variables |

Every user-visible string goes through `t()`; a literal is not allowed to reach the UI directly.

### Checks

`manifest.json`, `package.json` and `versions.json` must carry the same version before anything ships:

```bash
node .github/scripts/check-version.mjs          # version consistency + manifest rules
node .github/scripts/check-version.mjs --tag X  # also assert a tag matches the manifest
```

CI runs this plus a type check, a production build and a scan of `main.js` for the dynamic-execution APIs Obsidian's review rejects.

### Releases

Releases are driven by GitHub Actions and the built assets are attached by CI, since `main.js` is not tracked:

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | push to `main`, any pull request | type check, build, security scan, asset check |
| `version-check.yml` | push, tags, pull requests | version and manifest consistency |
| `release.yml` | pushing a tag, or a manual run | GitHub release with `main.js`, `manifest.json`, `styles.css` |
| `beta.yml` | commit on `main` whose subject starts with `[beta]` or `[rc]` | pre-release tagged `<version>-beta.N` for [BRAT](https://github.com/TfTHacker/obsidian42-brat) |

Bump the version in all three files, commit, then push a tag without a `v` prefix:

```bash
git tag 0.9.0 && git push origin 0.9.0
```

The same release can be cut from the Actions tab instead, by running **Release** and passing the version — the workflow creates the tag itself. For testing before a release, start the commit subject on `main` with `[beta]`, or with `[rc]` to also clear older pre-releases, then install the resulting pre-release through BRAT. The keywords only count at the very start of the subject line, so a commit that merely mentions them in its body will not cut a pre-release.

## License

MIT
