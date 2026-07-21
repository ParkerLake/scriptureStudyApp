# Book of Mormon Study

A personal study app for the Book of Mormon: read, highlight, and take notes, with your data synced across devices via a GitHub-backed data file.

## What's here

- `index.html` / `app.js` / `styles.css` — the app itself. No build step, no framework, no dependencies.
- `content.json` — the full text of the Book of Mormon (239 chapters, ~6,440 verses), plus chapter/book headings and the official front matter (Introduction, Testimony of Witnesses, Joseph Smith's account, Brief Explanation), extracted from the official PDF.
- `data/` — where your synced study data (`study-data.json`) lands if you use GitHub sync. Not committed by default; created the first time you push from the app.

## Features

- **Reading**: full text, organized by book and chapter, with the official chapter summaries shown above each chapter.
- **Highlighting**: select any word or phrase and apply a highlighter, underline, or box — in any color. These stack, so the same words can be highlighted, underlined, *and* boxed at once.
- **Notes**: add a note to an entire chapter, or to any individual verse (click the verse number).
- **Search**: search scripture text and your own notes from the sidebar.
- **Study links**: every chapter links out to a live ChurchofJesusChrist.org search, General Conference talk search, and the Gospel Library reading view for that chapter.
- **Sync**: your highlights and notes can be stored as a single JSON file in this repo (or any repo you point it at), so the same data follows you across devices.

## Running it locally

No build step needed — it's static files. From this folder:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set the source to the `main` branch, root folder.
3. Your app will be live at `https://<you>.github.io/<repo>/`.

## Setting up cross-device sync

The app can read and write a single data file (`data/study-data.json` by default) in a GitHub repo using a personal access token — no separate backend or account needed beyond GitHub itself.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Scope it to just this repository, with **Contents: Read and write** permission. Nothing else is needed.
3. In the app, open the **Sync** tab in the right panel, and fill in:
   - Repo owner (your GitHub username or org)
   - Repo name
   - File path (defaults to `data/study-data.json`)
   - The token you just created
4. Click **Save settings**, then **Push to GitHub** to create the file for the first time.
5. On any other device, open the app and enter the same settings — it will pull your data automatically on load.

The token is stored only in your browser's local storage on each device; it is never included in the synced data file itself.

**Note:** sync is last-write-wins per full file. If you edit on two devices without syncing in between, the more recent save wins and the other device's changes since its last sync could be lost. For personal single-user use this is a reasonable tradeoff, but it's not built for simultaneous multi-device editing.

## Known limitations

- The official cross-reference footnotes (the small superscript-lettered references to other scriptures and Topical Guide entries) are not included — the source PDF's footnote layout couldn't be reliably parsed into verse-level references. "Footnotes and commentary" in this app means your own notes.
- Text extraction is very high quality but not perfect — a handful of chapters (out of 239) may have small extraction artifacts, mostly at the very start of a chapter. If you spot one, it's easy to fix directly in `content.json` (each verse is a plain `{"verse": N, "text": "..."}` entry).
