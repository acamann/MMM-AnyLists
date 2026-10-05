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

Checked items stay visible, struck-through and dimmed, until they are removed
in the AnyList app.

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
| `animationSpeed` | DOM update animation in ms. `0` = instant. | `0` |

## How it works

- The `node_helper` owns a single `anylist` client. All AnyList operations
  (login, list loads, toggles) are serialized through an `async` queue of
  concurrency 1 — parallel requests cause AnyList login/update errors.
- The front-end talks to the helper only via socket notifications:
  `INIT`, `TOGGLE_ITEM` → `LIST_DATA`, `ANYLIST_ERROR`.
- Tapping an item flips its checked state locally at once (optimistic
  strike-through), then the helper locates the live `Item` by
  `{listId, identifier}`, flips `checked`, and calls `save()`. AnyList's
  websocket then broadcasts `lists-update`, which reconciles the mirror.

## License

MIT
