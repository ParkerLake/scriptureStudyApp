# Book of Mormon Study

A personal study app for the Book of Mormon: read, highlight, and take notes, with your data synced across devices via a GitHub-backed data file — accessed through a Cloudflare Worker, so no GitHub credential ever touches your browser.

## What's here

- `index.html` / `app.js` / `styles.css` — the app itself. No build step, no framework, no dependencies.
- `content.json` — the full text of the Book of Mormon (239 chapters, ~6,440 verses), plus chapter/book headings and the official front matter (Introduction, Testimony of Witnesses, Joseph Smith's account, Brief Explanation), extracted from the official PDF.
- `worker.js` — a small Cloudflare Worker that proxies sync requests to GitHub, holding your GitHub token as a server-side secret. Deployed separately from the app itself (see below).
- `data/` — where your synced study data (`study-data.json`) lands. Not committed by default; created the first time you push from the app.

## Features

- **Reading**: full text, organized by book and chapter, with the official chapter summaries shown above each chapter.
- **Highlighting**: select any word or phrase and apply a highlighter, underline, or box — in any color. These stack, so the same words can be highlighted, underlined, *and* boxed at once.
- **Notes**: add a note to an entire chapter, or to any individual verse (click the verse number).
- **Search**: search scripture text and your own notes from the sidebar.
- **Study links**: every chapter links out to a live ChurchofJesusChrist.org search, General Conference talk search, and the Gospel Library reading view for that chapter.
- **Sync**: your highlights and notes are stored as a single JSON file in this repo (or any repo you point it at), so the same data follows you across devices — routed through a Cloudflare Worker so your GitHub token never lives in the browser, only a passcode does.

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

Sync works through a small Cloudflare Worker (`worker.js`) that sits between the app and GitHub. The Worker holds your GitHub token as a server-side secret; the app itself only ever holds the Worker's URL and a passcode. That way, nothing capable of writing to your GitHub account is ever exposed in the browser, on any device, even though the app is a public static site.

### 1. Create the GitHub token (for the Worker, not the app)

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Scope it to just this repository, with **Contents: Read and write** permission. Nothing else is needed.
3. Copy the token — you'll paste it into the Worker's secrets, not the app.

### 2. Deploy the Worker

1. In the Cloudflare dashboard: **Workers & Pages → Create → Create Worker**. Give it a name (e.g. `bom-sync`) and deploy the default template.
2. Open the Worker, go to its editor (**Edit code** / Quick Edit), delete the placeholder code, and paste in the contents of `worker.js` from this repo. Deploy.
3. Go to the Worker's **Settings → Variables and Secrets** and add:
   - `GITHUB_TOKEN` (secret) — the token from step 1
   - `APP_PASSCODE` (secret) — a passcode you make up; the app will send this on every request
   - `GITHUB_OWNER` (variable) — your GitHub username
   - `GITHUB_REPO` (variable) — `scriptureStudyApp`
   - `GITHUB_PATH` (variable) — `data/study-data.json`
   - `ALLOWED_ORIGIN` (variable, optional) — your GitHub Pages URL, e.g. `https://yourname.github.io`, to restrict which sites can call the Worker. Leave unset to allow any origin.
4. Note the Worker's URL (shown at the top of its dashboard page, looks like `https://bom-sync.yourname.workers.dev`).

### 3. Point the app at it

1. In the app, open the **Sync** tab in the right panel.
2. Enter the Worker URL and the passcode you chose in step 2.
3. Click **Save settings**, then **Push** to create the data file in your repo for the first time.
4. On any other device, enter the same Worker URL and passcode — it pulls your data automatically on load.

**Note:** sync is last-write-wins per full file. If you edit on two devices without syncing in between, the more recent save wins and the other device's changes since its last sync could be lost. For personal single-user use this is a reasonable tradeoff, but it's not built for simultaneous multi-device editing.

## Known limitations

- The official cross-reference footnotes (the small superscript-lettered references to other scriptures and Topical Guide entries) are not included — the source PDF's footnote layout couldn't be reliably parsed into verse-level references. "Footnotes and commentary" in this app means your own notes.
- Text extraction is very high quality but not perfect — a handful of chapters (out of 239) may have small extraction artifacts, mostly at the very start of a chapter. If you spot one, it's easy to fix directly in `content.json` (each verse is a plain `{"verse": N, "text": "..."}` entry).
