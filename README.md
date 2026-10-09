REMYELLIS.AU — PORTFOLIO SITE
============================

This is the source for [remyellis.au](https://remyellis.au/). The main portfolio is static HTML/CSS/JS based on the Hyperspace template by HTML5 UP, with a small Node backend for Notes.

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

- WikiMD, rendered by the compiler from `Breakerchap/WikiMD`
- raw HTML embedded directly inside WikiMD
- LaTeX using `$...REMYELLIS.AU — PORTFOLIO SITE
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

, `$...$`, `\(...\)` and `\[...\]`
- WikiMD callouts, highlighting, collapsible sections and other non-tab formatting features
- per-note custom CSS
- custom fonts through `@font-face` in the note CSS
- server-side drafts that are available across devices
- manual draft saving only — there is no autosave
- publish, unpublish and delete controls
- `Ctrl+S` / `Cmd+S` as an explicit Save draft shortcut

WikiMD is compiled server-side into an HTML fragment using the WikiMD compiler's tab-free renderer. Tab directives are intentionally ignored in Notes. LaTeX delimiters are preserved by WikiMD and rendered in the browser with KaTeX.

Notes data is not stored in Git. By default the service can use a local data file, but production should set `NOTES_DATA_PATH=/var/lib/remy-notes/notes.json`.

Local testing on Windows
------------------------

You can run the portfolio and Notes backend together with one command after installing the WikiMD dependency. Node 20 or newer is required.

From PowerShell in the repository folder:

    cd C:\Users\Remy\Documents\CodingProjects\remyellis-site
    git pull
    npm install
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

The Notes backend uses WikiMD as an npm dependency.

1. Copy/deploy the repository to `/var/www/remyellis.au` as usual, then install dependencies:

       cd /var/www/remyellis.au
       npm install --omit=dev

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


Moderated comments on Notes
---------------------------

Individual public notes display a comment thread. Visitors supply only a name and
a comment; no email address or account is requested. Replies are supported, with
one level of nesting. Every anonymous comment and reply starts as **pending** and
is invisible to the public until approved. Comments remain linked to the note's
internal ID, so changing a note slug does not lose its discussion.

Comments deliberately use a **restricted WMD subset**: headings (# through ###),
*bold*, _italics_, links, unordered lists, block quotes, inline and fenced code,
plain prose, and maths rendered by KaTeX. The public comments compiler always
escapes HTML and never executes WMD configuration, custom styles, embeds, CSS
or JavaScript. It does not use the unrestricted Notes compiler.

The Notes admin page has a **Comments** button in the header, with a live
pending count. The inbox defaults to **All**, with Pending, Published and Hidden
filters. You can approve, hide, edit or delete comments, and reply directly to
any published comment. Hiding removes it from the public note but preserves it
for later approval; deletion is permanent and removes its replies too.

To **post as Remy Ellis**, sign in through the Notes admin page, then open a
published note in another tab on the **same origin**. The public Write a comment
and Reply controls then post immediately as the verified author without
Turnstile or manual approval. Other visitors must use Turnstile and always need
approval. Your replies have the Signature.png avatar and author badge. Merely
typing your name never grants author privileges.

The public composer is collapsed by default and uses the same CodeMirror WMD
syntax highlighting as the Notes editor. Both Write/Preview and moderation
reply/edit editors support WMD. No visitor email addresses are collected.
The download UI and download endpoints for notes have been removed.

### Turnstile setup

Create a **Managed** Cloudflare Turnstile widget with hostname
`remyellis.au` (and `www.remyellis.au` if serving that hostname).
Cloudflare Turnstile's Free plan permits unlimited verification requests.
Add the values below to the **private** `/etc/remy-notes.env` file used
by the systemd service (never commit the secret key):

    COMMENTS_TURNSTILE_SITE_KEY=the_public_site_key
    COMMENTS_TURNSTILE_SECRET=the_private_secret_key

Reload the service after changing the environment:

    sudo systemctl restart remy-notes.service

If either value is missing, visitor submissions are **disabled**, but published
comments remain visible. The server verifies every visitor's Turnstile token
against Cloudflare's Siteverify endpoint, validates its hostname, and rejects
missing, expired or reused tokens. The client widget alone is not trusted.

If the website legitimately accepts comments on another domain, list its host
name(s) in `COMMENTS_ALLOWED_HOSTNAMES` as a comma-separated value. Never
turn off hostname validation for production.

The default private data file is `comments.json` beside `NOTES_DATA_PATH`
(usually `/var/lib/remy-notes/comments.json`). It can be overridden with:

    COMMENTS_DATA_PATH=/var/lib/remy-notes/comments.json

Back up **both** `notes.json` and `comments.json`. Neither belongs in Git.
The service user needs write permission to the private data directory. The
comments file is created with mode 0600. Deleting a note also deletes its
comments.

Anti-spam protection includes Turnstile, server-side request validation,
a hidden honeypot, a per-IP and global hourly submission limit, a preview
limit, and mandatory moderation. Names are 2–60 characters, comments are
3–4000 characters. The submission limit is in-memory and resets when the
service restarts; moderation remains mandatory regardless.

### Notifications

The admin Comments button has a live pending count, refreshed when you log in
and approximately once a minute while the admin page is open. This works
without any extra services.

Optional **email notifications to the site owner only** can use a configured
local `sendmail`-compatible program (such as msmtp in sendmail mode).
It is not enabled automatically and does not collect visitor email addresses.
For instance:

    COMMENTS_NOTIFY_EMAIL=remy@remyellis.au
    COMMENTS_SENDMAIL_PATH=/usr/bin/msmtp

Configure the mail transport separately and test it on the Pi before relying
on email; an unavailable mail transport does not prevent submission or
moderation. No email is sent to visitors.

### Local development and tests

    npm run check
    npm run test:comments

For localhost testing of the form, Cloudflare provides dedicated test
credentials. Set the following **only on localhost**, never in production:

    COMMENTS_TURNSTILE_SITE_KEY=1x00000000000000000000AA
    COMMENTS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA

The test credentials still use the real Siteverify HTTP endpoint. Production
must use a separate genuine Turnstile widget. Test the full moderation flow
locally before deploying. The comment endpoints run through the existing
`/api/` reverse-proxy route – no new nginx location is necessary.
