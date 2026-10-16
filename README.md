# MMM-AnyLists

A [MagicMirror²](https://magicmirror.builders/) module that displays **multiple
[AnyList](https://www.anylist.com/) lists side-by-side on one panel** and lets
you **tap an item to check it off directly on the mirror**.

Adapted from upstream [`codetheweb/MMM-AnyList`](https://github.com/codetheweb/MMM-AnyList):
reuses its `node_helper` login, queue, and websocket plumbing, extended to
render any number of lists as columns from a single shared AnyList login, and
to write check-offs back to AnyList.

- Parents manage the lists from the AnyList mobile/web app.
- Kids check items off on the mirror.
- Both stay in sync via AnyList's websocket-driven live update channel.

Checked items are hidden by default so the panel reads as what is left to do.
An eye toggle on the right of the header brings them back: a slashed eye while
they are hidden, a solid accent eye while they are shown. The chosen visibility
is stored in `localStorage` and survives a server restart; clear the
`MMM-AnyLists:showChecked:v2:*` key to go back to the configured default.

## Panel layout

```
┌──────────────────────────────────────────────┐
│  To Do                                     👁  │  ← header + eye toggle
├───────────────┬───────────────┬──────────────┤
│    Daniel      │     Luke      │     Ben      │  ← one column per list
│  ☐ Feed dog   │  ☐ Homework   │  ☐ Practice  │
│  ☐ Take out   │  ☐ Pack bag   │              │
│   trash       │               │              │
└───────────────┴───────────────┴──────────────┘
```

## Installation

```bash
cd ~/MagicMirror/modules
git clone <this repo> MMM-AnyLists
cd MMM-AnyLists
npm install
```

## Configuration

Add to `config/config.js`:

```js
{
  module: 'MMM-AnyLists',
  position: 'fullscreen_below',
  config: {
    email: '${ANYLIST_EMAIL}',
    password: '${ANYLIST_PASSWORD}',
    lists: ['Daniel', 'Luke', 'Ben'], // exact AnyList list names, one column each
    refreshOnExternalChange: true,    // websocket-driven reload (default true)
    maxItemsPerList: 0,               // 0 = unlimited
    textAlign: 'left',
    showQuantities: false,
    columnSeparator: true,
    header: 'To Do',              // panel title above the lists; '' hides it
    showCheckedToggle: true,      // show/hide-checked button on the header's right
    hideCheckedItems: true,       // initial state, before the first tap
  }
}
```

### Credentials via environment

Never hardcode credentials in `config.js`. MagicMirror² loads `config/config.env`
into the environment and substitutes `${VAR}` placeholders in `config.js`:

```
ANYLIST_EMAIL=you@example.com
ANYLIST_PASSWORD=your-password
```

One AnyList login is shared by the whole mirror — a single client instance
loads all configured lists.

### Options

| Option | Description | Default |
| --- | --- | --- |
| `email` | **Required.** AnyList account email. Use `'${ANYLIST_EMAIL}'`. | `''` |
| `password` | **Required.** AnyList account password. Use `'${ANYLIST_PASSWORD}'`. | `''` |
| `lists` | **Required.** Array of exact AnyList list names; each renders as one equally-wide column, in order. | `[]` |
| `refreshOnExternalChange` | Reload lists when they change in the AnyList app (websocket `lists-update`). | `true` |
| `maxItemsPerList` | Maximum items shown per column. `0` = unlimited. | `0` |
| `textAlign` | Item text alignment: `'left'` or `'center'`. | `'left'` |
| `showQuantities` | Show each item's quantity after its name. | `false` |
| `columnSeparator` | Draw a thin vertical separator between columns. | `true` |
| `header` | Panel title shown above the columns. `''` removes the header bar. | `'To Do'` |
| `showCheckedToggle` | Render the eye toggle on the right of the header. | `true` |
| `hideCheckedItems` | Whether checked items start hidden. The last tapped state is remembered from then on. | `true` |
| `animationSpeed` | DOM update animation in ms. `0` = instant. | `0` |

## How it works

- The `node_helper` owns a single `anylist` client. All AnyList operations
  (login, list loads, toggles) are serialized through an `async` queue of
  concurrency 1 — parallel requests cause AnyList login/update errors.
- The front-end talks to the helper only via socket notifications:
  `INIT`, `RETRY`, `TOGGLE_ITEM` → `LIST_DATA`, `ANYLIST_ERROR`.
- Tapping an item flips its checked state locally at once (optimistic
  strike-through), then the helper locates the live `Item` by
  `{listId, identifier}`, flips `checked`, and calls `save()`. AnyList's
  websocket then broadcasts `lists-update`, which reconciles the mirror.

### Connection retries

The mirror is a long-running appliance that often boots before WiFi has an
address, so the initial connect is retried: 5 attempts with a 2s / 5s / 15s /
30s backoff. Only *transient* failures are retried — network-level socket
errors (`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`, timeouts, …) and HTTP
5xx/408/429. A `401` or a bad config fails immediately so real mistakes are
not hidden behind a minute of waiting.

If the panel still shows the red error banner, tap it: it sends `RETRY`, which
replays the stored `INIT` payload.

### Patches to `anylist@0.8.6`

`node_helper.js` applies two repairs at startup (see `_repairUpstreamDefects`).
They exist because `0.8.6` is the newest published version, so there is no
upstream fix to wait for.

1. **`beforeError` hook.** The library builds an authenticated `got` client with
   a `beforeError` hook that reads `error.response.request.options.url.href`
   without checking that `error.response` exists. `got`'s `_error()` discards
   the original error whenever a hook throws, so *any* network-level failure
   surfaced as `Cannot read properties of undefined (reading 'request')` and the
   real cause (DNS failure, refused connection, timeout) was thrown away. The
   hook is swapped for a guarded one, so the underlying error reaches the log.
2. **`_refreshTokens`.** The websocket error handler awaits a token refresh that
   reads `error.response.statusCode` unguarded, throwing on exactly the network
   errors this module should ride out. Nothing catches it, so it escaped as an
   unhandled rejection. It is wrapped to log instead.

## Troubleshooting

Read the server log first — it carries the full error and stack, while the
panel shows only a short hint:

```bash
pm2 logs magicmirror --lines 50
tail -n 60 ~/.pm2/logs/magicmirror-error.log
```

| Panel shows | Meaning | Check |
| --- | --- | --- |
| `Loading …` for more than ~1 min | The helper is retrying a transient failure; it gives up after 5 attempts. | Look for `connect attempt N/5 failed` in the log. |
| `Cannot reach AnyList — check the mirror's network connection.` | DNS, routing, or TLS failure reaching `www.anylist.com`. | `ping -c3 1.1.1.1`, `getent hosts www.anylist.com`, `curl -sS -o /dev/null -w '%{http_code}\n' https://www.anylist.com/auth/token` |
| `AnyList: Response code 401` | Credentials rejected. | `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` in `config/config.env`. |
| `no lists configured` | `lists` missing or empty in `config.js`. | The `lists` array. |
| `List not found in AnyList` | The name does not match exactly (case and spacing). | Compare against the names in the AnyList app. |

A stale token cache lives at `~/.anylist_credentials`. Delete it to force a
fresh login; it is recreated automatically.

## License

MIT
