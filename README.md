REMYELLIS.AU — PORTFOLIO SITE
============================

This is the source for remyellis.au. The main portfolio is static HTML/CSS/JS based on the Hyperspace template by HTML5 UP, with a small Node backend for Notes.

Main files
----------

- `index.html` — portfolio homepage
- `notes.html` — public Notes page
- `notes-admin.html` — private Notes editor
- `assets/css/remy.css` — main portfolio styling
- `assets/css/notes.css` — public Notes styling
- `assets/css/notes-admin.css` — editor styling
- `assets/js/notes.js` — public Notes client
- `assets/js/notes-admin.js` — Notes editor client
- `server/notes-server.js` — Notes API and server-side storage

Notes
-----

The Notes section is separate from Writing. Public notes are listed newest-first with a short preview; opening one expands the full note in place.

The editor is at `/notes-admin.html`. It supports:

- Markdown
- basic LaTeX using `$...$`, `$$...$$`, `\(...\)` and `\[...\]`
- raw HTML notes
- per-note custom CSS
- custom fonts through `@font-face` in the note CSS
- server-side drafts that are available across devices
- manual draft saving only — there is no autosave
- publish, unpublish and delete controls
- `Ctrl+S` / `Cmd+S` as an explicit Save draft shortcut

Markdown is rendered in the browser with Marked. LaTeX is rendered with KaTeX. Those browser libraries are pinned to specific CDN versions.

Notes data is not stored in Git. By default the service can use a local data file, but production should set `NOTES_DATA_PATH=/var/lib/remy-notes/notes.json`.

Local testing on Windows
------------------------

You can run the portfolio and Notes backend together with one command. Node 20 or newer is required, but there are no npm dependencies to install.

From PowerShell in the repository folder:

    cd C:\Users\Remy\Documents\CodingProjects\remyellis-site
    git pull
    npm run dev

Then open:

- `http://127.0.0.1:8790/` — portfolio homepage
- `http://127.0.0.1:8790/notes.html` — public Notes page
- `http://127.0.0.1:8790/notes-admin.html` — Notes editor

Local development defaults to the admin password `dev`. It binds to `127.0.0.1`, disables the HTTPS-only cookie flag, serves the static site itself, and stores test notes in `server/data/notes.dev.json`.

Nothing is autosaved. A draft is written to that local data file only when you press **Save draft** or use `Ctrl+S` / `Cmd+S`.

To use a different local password for a session, set the development-only variable before starting the server:

    $env:NOTES_DEV_PASSWORD = "something-else"
    npm run dev

Press `Ctrl+C` in the terminal to stop the local server.

Production setup on the Pi
--------------------------

The Notes backend uses only Node's built-in modules, so there is no `npm install` step.

1. Copy/deploy the repository to `/var/www/remyellis.au` as usual.

2. Create the private data directory:

       sudo install -d -o remy -g remy -m 700 /var/lib/remy-notes

3. Create `/etc/remy-notes.env`:

       sudo nano /etc/remy-notes.env

   Put these values in it:

       NOTES_ADMIN_PASSWORD=choose-a-long-unique-password
       NOTES_DATA_PATH=/var/lib/remy-notes/notes.json
       NOTES_HOST=127.0.0.1
       NOTES_PORT=8790

   Then protect it:

       sudo chmod 600 /etc/remy-notes.env

4. Install the systemd service:

       sudo cp /var/www/remyellis.au/server/remy-notes.service.example /etc/systemd/system/remy-notes.service
       sudo systemctl daemon-reload
       sudo systemctl enable --now remy-notes.service

5. Add the contents of `server/nginx-notes.conf.example` inside the existing nginx `server { ... }` block for remyellis.au, then test and reload nginx:

       sudo nginx -t
       sudo systemctl reload nginx

6. Check the service:

       systemctl status remy-notes.service
       curl http://127.0.0.1:8790/api/notes

The API listens only on `127.0.0.1`; nginx proxies `/api/` to it. The admin session cookie is HttpOnly, SameSite=Strict and Secure by default. Login attempts are rate-limited in memory.

For local HTTP development, set `NOTES_SECURE_COOKIE=0` so the browser accepts the session cookie without HTTPS.

Custom fonts
------------

Place webfont files under `assets/fonts/` (for example, `assets/fonts/my-font.woff2`) and reference them in a note's Custom CSS field:

    @font-face {
      font-family: "My Font";
      src: url("/assets/fonts/my-font.woff2") format("woff2");
      font-display: swap;
    }

    .note-body {
      font-family: "My Font", serif;
    }

Because custom HTML and CSS are authored by the site owner, the Notes renderer deliberately allows styling and a broad subset of HTML. It strips `<script>`, `<object>`, `<embed>`, `<base>`, `<meta>`, inline event handlers and `javascript:` URLs before inserting note content.

Existing portfolio content
--------------------------

To add a paper, copy an `<article class="publication">...</article>` block in the Research section of `index.html` and replace its title, metadata, description and link.

To add a software project, copy one `<article class="project-card">...</article>` block in the Software section.

To add a story or film, copy an `<article>...</article>` block from the Writing section.
