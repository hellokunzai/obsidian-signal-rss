# Signal RSS

Subscribe to RSS and Atom feeds, read them in a dedicated reader tab inside Obsidian, and turn any article into a Markdown note in your vault.

## Features

- **Subscriptions** — add feeds by pasting either a feed URL or a site home page; RSS 2.0, Atom and RSS 1.0 (RDF) are supported. Feeds can be sorted into groups, and groups themselves can be created, renamed and deleted from the subscription tree.
- **Subscription list in the sidebar** — the search box, the feed tree, the article list and the drag handle between them live in the right sidebar. The list is the only place you pick from, and what it picks is what the reader shows.
- **Reader tab** — the selected article opens in its own tab in the main area, with the title, source, author and date up top and the article body below. Star, mark read or unread, fetch full text, open in the browser and save as note sit next to the title.
- **Full text extraction** — when a feed only ships a summary, the article page is fetched and its main content extracted, so you read (and keep) the whole thing.
- **Markdown export** — save any article as a note. The destination folder, the file name and both the front matter and body templates are configurable, with `{{title}}`, `{{feed}}`, `{{author}}`, `{{published}}`, `{{created}}`, `{{summary}}` and `{{content}}` variables.
- **Automatic refresh** — feeds are polled in the background at an interval you choose. Set it to 0 to switch automatic refresh off.
- **Read state** — unread counts per feed, a global unread count, read/unread toggling and a star list.
- **Search and filters** — full-text search over the fetched articles plus per-feed include/exclude keyword rules.
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

## Settings

| Setting | Description |
| --- | --- |
| Automatic refresh interval | Background polling interval in minutes; 0 turns it off |
| Request timeout | How long to wait for a feed before giving up (5–120 s) |
| Articles kept per feed | Upper bound on stored articles per feed |
| Mark as read when opened | Clear the unread flag as soon as an article is opened |
| Fetch full text when opened | Fetch the article page when a feed only ships a summary |
| Fetch full text while refreshing | Do that during refresh instead, so articles are readable offline |
| Custom cache folder | Vault-relative folder holding the caches; *Migrate cache* moves the data across from a folder used earlier |
| Reader font size / line height | Typography of the article body |
| Note folder | Destination folder for saved articles |
| File name template | Template for the note file name |
| Front matter template | YAML written at the top of every saved note |
| Note body template | Wrapper around the article body |
| Open the note after saving | Open the created note in a new tab |

## Where data lives

- Subscriptions, read/starred state and settings are stored in the plugin's `data.json`.
- Article content is cached under `.signal-rss/` at the root of your vault, one JSON file per feed — a dot folder, so it stays out of the file explorer and out of Obsidian's index. The folder is configurable; earlier versions kept it at `<your vault>/.obsidian/plugins/signal-rss/cache/`, and **Settings → Custom cache folder → Migrate cache** moves anything still sitting in an older folder (including that one) into the current folder, merging rather than overwriting so no read flag or extracted body is lost. Nothing is written into your notes folder unless you explicitly save an article.

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

```bash
npm install
npm run dev     # watch build
npm run build   # type check + production bundle
```

Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/signal-rss/` to try a build.

## License

MIT
