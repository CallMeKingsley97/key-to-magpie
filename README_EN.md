# Key to Magpie

[简体中文](./README.md) | English

A Chrome and Microsoft Edge (Chromium 111+) extension that adds an "Import to magpie" button on the token management pages of [new-api](https://github.com/QuantumNous/new-api) / [sub2api](https://github.com/Wei-Shaw/sub2api), letting you import your API Keys as providers with one click via the official [magpie](https://github.com/yetone/magpie) import protocol (`magpie://import` links).

## Installation

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge
2. Enable "Developer mode" in the top-right corner
3. Click "Load unpacked" and select this directory (`key-to-magpie/`)
4. Make sure the magpie desktop app is installed and has been launched at least once (`/Applications/magpie.app`)

## Usage

1. Open the token management page of your relay station:
   - new-api: `/token` (e.g. `https://your-station.com/token`)
   - sub2api: `/keys`
2. An **"Import to magpie"** button will appear next to the "Create Token / Add API Key" button on the page (shown at the bottom-right if no create button is found)
3. Click the button and a panel will pop up listing all your keys (name, status, group, model count, masked key)
4. Check the keys you want to import (single, multiple, or select all), then click "Import"
   - Single key: the magpie confirmation window pops up directly
   - Multiple keys: enters queue mode, invoking magpie one by one — confirm with **Add** in each magpie window
5. Go back to the Providers page in magpie to confirm the new providers appear

Open the browser toolbar popup to view and toggle the extension for the current site.
The setting is saved per origin (scheme, hostname, and port). Turning it off immediately
removes the page controls, closes extension panels, and stops extension requests; it stays
off after reload. Use this if a site is incompatible or reacts badly to extension requests.

On a new-api / sub2api token page, after content containing an `sk-` key is actually copied (for example, a key or connection info that includes the key), the extension asks whether to open the Magpie import panel. Choose "Open import panel" to select tokens, or "Not now" to dismiss the prompt without affecting the site's copy action. Merely opening a copy menu or copying content without a key does not trigger the prompt.

## Import Mapping

| magpie config | source |
| --- | --- |
| name | `prefix · token name` (prefix customizable in advanced settings) |
| id | lowercase slug auto-generated from `host-prefix-tokenId` |
| chat / responses | `https://station/v1` (OpenAI-compatible endpoint) |
| anthropic | `https://station` (for Claude Code) |
| gemini | `https://station/v1beta` |
| key | plaintext token key (fetched via the station's API, passed only locally) |
| models | the token's "model restriction" list in new-api; for sub2api, fetched from `/v1/models` with the plaintext key (empty if unrestricted) |
| catalog / website / keys | auto-completed (models.dev, station homepage, token page URL) |
| icon | the logo the station configured in its public API (see below) |

### Icon

`icon` prefers the logo the station itself configured in its public API
(new-api's `/api/status` → `logo`, sub2api's `/api/v1/settings/public` →
`site_logo`), falling back to the page favicon only when there is none.

magpie validates `icon` strictly (https, public host, no credentials or
fragment); a value that fails makes the whole import link invalid, so the
extension filters first. If nothing survives filtering, the parameter is left
out and magpie uses its own letter tile or the catalog's logo — better than
passing the panel favicon that looks identical on every relay.

### Balance

magpie has built-in balance queries for new-api and sub2api, but
`magpie://import` has no `balance` parameter — it can only be added afterwards
via the CLI. With "Advanced settings → configure balance query in batch
command" checked, each key in "Batch command" gains an extra line:

```sh
magpie provider set '<id>' balance='https://station/api/usage/token'
```

magpie infers the value field from the endpoint path (new-api's
`/api/usage/token`, sub2api's `/v1/usage`), so the URL alone is enough. This
switch only affects "Batch command", since single imports go through the GUI
where there is no command to run.

### Endpoint Probing

Different relay stations support different API endpoints (e.g. some only expose
`/v1/chat/completions` without Anthropic's `/v1/messages`). The extension uses one
enabled token's API key to request `/v1/models`, Chat, Responses, and Anthropic in
sequence. Each request has a three-second timeout; timing out stops the remaining
probes. Import never waits for probing: clicking Import aborts the active probe and
continues the import. Endpoint checkboxes are adjusted from probe results only when
all four requests finish before Import is clicked. Probe messages have a one-token
output limit, so successful requests may incur a small usage charge. Gemini requires
a separate model list, so it is not probed automatically to avoid repeating requests:

- `404 / 405 / 501` → the station doesn't support this endpoint; after all probes finish, it is unchecked by default and marked "not detected"; saved preferences are preserved
- `2xx` → the endpoint responded successfully and is marked "detected"
- Other `4xx` responses (except `401 / 403`) → the request was rejected and support is "unknown"; an error response is not treated as usable
- `401` → API key authentication failed and is not counted as success
- `403` → the key or its group lacks access; after all probes finish, the endpoint is unchecked by default, while saved preferences are preserved
- `429 / 5xx` or network errors → marked "could not confirm" and stays checked by default
- A request taking longer than three seconds stops the remaining probes; incomplete results do not change checkbox selections
- Failed responses show the HTTP status

OpenAI-compatible endpoints use `Authorization: Bearer`; Anthropic uses `x-api-key`.
If no enabled token exists or its plaintext key cannot be read, probing is skipped
rather than sending unauthenticated requests. Failure to probe `/v1/models` does not
block import; sub2api still fetches the model catalog with the selected key during
import, leaving `models` empty if that request fails.

Probing only affects default checkboxes and hints. You can always toggle endpoints
manually under "Advanced settings → Imported API endpoints"; once you've changed
them by hand, your preference is remembered per station and probing won't override it.

Advanced settings also let you change the name prefix and catalog, and toggle each
of the four endpoints; preferences are remembered per station.

## Security Notes

- The extension only sends same-origin requests within the current site to read the token list and plaintext keys — no third-party servers involved
- Authentication is read and refreshed in the token page's own context; tokens are only used for requests to that site
- On sub2api stations it calls the station's own `/v1/models` with the plaintext key to fetch the model list — also a same-origin request
- Keys only appear in magpie import links; the link is cleared from the address bar immediately after the extension page opens
- After receiving a link, magpie shows a confirmation dialog first — the provider is only written to `~/.config/magpie/providers.json` after you click Add
- To detect SPA navigation after login, the extension runs a lightweight URL check on HTTP(S) pages; it scans page content, shows UI, and calls station APIs only on supported token-page paths

## Manual Test Checklist

- [ ] Load this directory via `chrome://extensions` with no errors
- [ ] Load it via `edge://extensions`, refresh a signed-in token page, and confirm the panel lists tokens
- [ ] Open `https://api.chengmo.cc.cd/keys` (new-api) and confirm the "Import to magpie" button appears
- [ ] Click the button and confirm the panel lists all tokens in the account
- [ ] Import a single key → magpie shows a confirmation window with correct host / key / models → click Add
- [ ] The new provider appears on magpie's Providers page and can chat normally
- [ ] Select all and import → queue mode completes one by one, all appearing in magpie
- [ ] (Optional) repeat the above on a sub2api station's `/keys` page
- [ ] Disable an endpoint (e.g. gemini) in advanced settings → that endpoint is empty after import
- [ ] Open a station that only supports some endpoints, confirm unsupported endpoints are unchecked automatically and marked "not detected"
- [ ] Disable the current site from the extension popup; confirm page controls and panels disappear and remain disabled after reload
- [ ] Re-enable the current site from the extension popup and confirm the token-page button returns
- [ ] "Configure balance query" in advanced settings shows this station's balance endpoint (new-api: `/api/usage/token`, sub2api: `/v1/usage`)
- [ ] After importing via "Batch command", the provider card in magpie shows a balance
- [ ] After importing from a sub2api station, that provider's model list in magpie is not empty
- [ ] When the station configured its own logo, magpie shows that logo rather than the panel's default icon

## Friendly Links

- [linux.do](https://linux.do) — a new ideal type of tech community
- [V2EX](https://www.v2ex.com) — a community for creative professionals

## File Structure

```
manifest.json   Extension config (MV3, checks SPA routes on HTTP(S) pages)
content.js      Page script: injects button, reads tokens, builds import links, import queue
background.js   Service worker: opens/reuses the import page tab
open.html/js    In-extension import page: invokes the magpie protocol + fallback notes
popup.html/js   Toolbar popup: triggers the import panel in the current tab
icons/          Extension icons
```

## License

[MIT](./LICENSE)
