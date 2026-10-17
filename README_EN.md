# Key to Magpie

[简体中文](./README.md) | English

A Chrome extension that adds an "Import to magpie" button on the token management pages of [new-api](https://github.com/QuantumNous/new-api) / [sub2api](https://github.com/Wei-Shaw/sub2api), letting you import your API Keys as providers with one click via the official [magpie](https://github.com/yetone/magpie) import protocol (`magpie://import` links).

## Installation

1. Open Chrome and go to `chrome://extensions`
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

## Import Mapping

| magpie config | source |
| --- | --- |
| name | `prefix · token name` (prefix customizable in advanced settings) |
| id | lowercase slug auto-generated from `host-prefix-tokenId` |
| chat / responses | `https://station/v1` (OpenAI-compatible endpoint) |
| anthropic | `https://station` (for Claude Code) |
| gemini | `https://station/v1beta` |
| key | plaintext token key (fetched via the station's API, passed only locally) |
| models | the token's "model restriction" list in new-api (empty if unrestricted) |
| catalog / website / keys | auto-completed (models.dev, station homepage, token page URL) |

### Endpoint Probing

Different relay stations support different API endpoints (e.g. some only expose
`/v1/chat/completions` without Anthropic's `/v1/messages`). When the import panel
opens, a minimal request is sent to each of the four endpoints for probing:

- `404 / 405` → the station doesn't support this endpoint; it gets unchecked automatically and marked "not detected" in advanced settings
- `401 / 400 / 200`, etc. → the endpoint exists, stays checked
- Probe failed (network error, etc.) → marked "not probed", stays checked by default

Probing only affects default checkboxes and hints. You can always toggle endpoints
manually under "Advanced settings → Imported API endpoints"; once you've changed
them by hand, your preference is remembered per station and probing won't override it.

Advanced settings also let you change the name prefix and catalog, and toggle each
of the four endpoints; preferences are remembered per station.

## Security Notes

- The extension only sends same-origin requests within the current site to read the token list and plaintext keys — no third-party servers involved
- Keys only appear in magpie import links; the link is cleared from the address bar immediately after the extension page opens
- After receiving a link, magpie shows a confirmation dialog first — the provider is only written to `~/.config/magpie/providers.json` after you click Add
- The extension requests no host permissions and only activates on matched token page paths

## Manual Test Checklist

- [ ] Load this directory via `chrome://extensions` with no errors
- [ ] Open `https://api.chengmo.cc.cd/keys` (new-api) and confirm the "Import to magpie" button appears
- [ ] Click the button and confirm the panel lists all tokens in the account
- [ ] Import a single key → magpie shows a confirmation window with correct host / key / models → click Add
- [ ] The new provider appears on magpie's Providers page and can chat normally
- [ ] Select all and import → queue mode completes one by one, all appearing in magpie
- [ ] (Optional) repeat the above on a sub2api station's `/keys` page
- [ ] Disable an endpoint (e.g. gemini) in advanced settings → that endpoint is empty after import
- [ ] Open a station that only supports some endpoints, confirm unsupported endpoints are unchecked automatically and marked "not detected"

## Friendly Links

- [linux.do](https://linux.do) — a new ideal type of tech community
- [V2EX](https://www.v2ex.com) — a community for creative professionals

## File Structure

```
manifest.json   Extension config (MV3, no host permissions)
content.js      Page script: injects button, reads tokens, builds import links, import queue
background.js   Service worker: opens/reuses the import page tab
open.html/js    In-extension import page: invokes the magpie protocol + fallback notes
popup.html/js   Toolbar popup: triggers the import panel in the current tab
icons/          Extension icons
```

## License

[MIT](./LICENSE)
