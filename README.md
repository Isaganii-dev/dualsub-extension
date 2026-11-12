# DualSub for YouTube & Netflix

Shows two subtitle languages at once (e.g. original + your own language) in a custom overlay.

## Install (Chrome, Edge, Brave, other Chromium browsers; Chrome 111+)
1. Unzip, open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Reload any open YouTube/Netflix tabs (Netflix needs a fresh page load so the hook runs early).
4. Play a video, click the DualSub icon, choose a top and second language.

## How it works
- `inject.js` runs in the page's own JS world.
  - YouTube: reads the caption tracks from the player, fetches them as `json3`, and uses YouTube's
    machine translation (`tlang`) for languages that have no real track. If YouTube demands its
    request token, it briefly asks the player to enable captions once to learn it.
  - Netflix: wraps `JSON.parse` / `JSON.stringify` to ask the manifest for WebVTT subtitle files for
    all languages, then downloads the ones you pick.
- `content.js` draws the overlay synced to `video.currentTime` and hides the site's own captions.

## Known limits
- Both sites change internals without notice; this relies on undocumented behavior and may break.
- Netflix: titles whose subtitles are image-based only (some Asian-language tracks) won't appear.
  "Original language" on Netflix is a best guess; pick a language explicitly if it's wrong.
- YouTube auto-generated captions can repeat/overlap because of how YouTube builds them.
- Auto-translated YouTube lines are machine translated.
