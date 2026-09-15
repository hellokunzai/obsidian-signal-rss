# RSS Subscribe

Subscribe to RSS and Atom feeds, read them in a focused split view inside Obsidian, and turn any article into a Markdown note in your vault.

## Features

- **Subscriptions** — add feeds by pasting either a feed URL or a site home page; RSS 2.0, Atom and RSS 1.0 (RDF) are supported. Feeds can be sorted into groups.
- **Split reader** — one view with a subscription and article list on the left and the article body on the right. The layout collapses to a single pane when the view gets narrow.
- **Dockable list** — the subscription list (toolbar, search, feed tree and article list) can live inside the reader view or in the right sidebar. Either copy drives the same selection, so clicking an article in the sidebar updates the reader tab. Inside the reader view the list can also be folded away with one click from the toolbar, leaving the article full width; the switch stays put so the list is one click away again.
- **Full text extraction** — when a feed only ships a summary, the article page is fetched and its main content extracted, so you read (and keep) the whole thing.
- **Markdown export** — save any article as a note. The destination folder, the file name and both the front matter and body templates are configurable, with `{{title}}`, `{{feed}}`, `{{author}}`, `{{published}}`, `{{created}}`, `{{summary}}` and `{{content}}` variables.
- **Automatic refresh** — feeds are polled in the background at an interval you choose. Set it to 0 to switch automatic refresh off.
- **Read state** — unread counts per feed, a global unread count, read/unread toggling and a star list.
- **Search and filters** — full-text search over the fetched articles plus per-feed include/exclude keyword rules.
- **OPML** — import an OPML file exported by another reader, and export your subscriptions back out.
- **Interface language** — English and Simplified Chinese, following the Obsidian language setting.

## Installation

### From the community plugin directory

Search for "RSS Subscribe" under **Settings → Community plugins → Browse**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them into `<your vault>/.obsidian/plugins/rss-subscribe/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Usage

1. Click the RSS icon in the ribbon, or run **RSS Subscribe: Open RSS reader** from the command palette.
2. Click the plus button in the toolbar and paste a feed URL. A site home page also works — RSS Subscribe looks for the feed link on the page.
3. Articles appear in the left column. Selecting one opens it in the reader on the right.
4. Use **Save as note** in the reader to write the article into your vault.

Right-click a feed in the left column for refresh, mark-as-read, edit and delete.

## Commands

| Command | Description |
| --- | --- |
| Open RSS reader | Show the reader view |
| Refresh all feeds | Fetch every subscription |
| Add feed | Open the add-feed dialog |
| Import OPML file | Import subscriptions from an OPML file |
| Export OPML file | Write an OPML file to the vault root |
| Save current article as note | Save the article open in the reader |
| Mark all articles as read | Clear the unread state everywhere |
| Toggle the subscription list sidebar | Move the list between the reader view and the right sidebar |

## Settings

| Setting | Description |
| --- | --- |
| Subscription list position | Show the list inside the reader view, or dock it in the right sidebar |
| Automatic refresh interval | Background polling interval in minutes; 0 turns it off |
| Request timeout | How long to wait for a feed before giving up (5–120 s) |
| Articles kept per feed | Upper bound on stored articles per feed |
| Mark as read when opened | Clear the unread flag as soon as an article is opened |
| Fetch full text when opened | Fetch the article page when a feed only ships a summary |
| Fetch full text while refreshing | Do that during refresh instead, so articles are readable offline |
| Reader font size / line height | Typography of the article body |
| Note folder | Destination folder for saved articles |
| File name template | Template for the note file name |
| Front matter template | YAML written at the top of every saved note |
| Note body template | Wrapper around the article body |
| Open the note after saving | Open the created note in a new tab |

## Where data lives

- Subscriptions, read/starred state and settings are stored in the plugin's `data.json`.
- Article content is cached under `<your vault>/.obsidian/plugins/rss-subscribe/cache/`. One file per feed; nothing is written into your notes folder unless you explicitly save an article.

## Privacy and network access

This plugin makes network requests, but only to the addresses you subscribe to:

- Feed URLs are requested to fetch articles.
- An article's own URL is requested when full text extraction runs.

There is no account, no telemetry, no analytics and no third-party service. Requests go through Obsidian's `requestUrl` API, so they are not sent to any proxy of ours.

## Troubleshooting a feed that will not load

Some addresses are unreachable, rate-limited, or hang on the server side. RSS Subscribe gives up after the configured request timeout and reports the reason rather than waiting indefinitely, and it stops early when the host itself is unreachable instead of retrying every guessed path.

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

- The list and the reader are always stacked into one column, with a back arrow to return to the list. There is no split view and no drag handle to aim at.
- Long-pressing a subscription opens its menu (refresh, rename, delete), since there is no right-click.
- Touch targets, the search box, and the reader's margins are sized for a thumb and for iOS' minimum input font size.
- If you move the subscription list into the right sidebar, picking an article folds the drawer away so the article is visible right away.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type check + production bundle
```

Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/rss-subscribe/` to try a build.

## License

MIT
