# Snug

A voice-chat app for playing with friends: share a room code, talk, share
your screen, and keep a rolling instant replay of the last few seconds in
case something worth keeping happens.

## Layout

| path | what it is |
|---|---|
| `snug/` | The web app (Next.js) and the Socket.IO signalling server it talks to. |
| `snug-desktop/` | The Electron shell — bundles the web app, adds the tray, global shortcuts, corner overlay and instant replay. |
| `*.dc.html` | Design canvases for the screens, kept alongside the code they describe. |

## Running it

```bash
cd snug && npm install && npm run dev:all   # web app + signalling server
cd snug-desktop && npm install && npm run dev
```

`snug/` needs a `.env.local` with `NEXT_PUBLIC_SIGNAL_URL` pointing at the
signalling server (`http://localhost:3001` when running it locally). That
file is gitignored — it holds credentials.

## Tests

```bash
cd snug && npm test
```

Covers the room passcode hashing, the upload type boundary (which decides
what an uploaded file is served back as), and the modal dialog behaviour.

## Building the desktop installer

```bash
cd snug-desktop && npm run package:win
```

Produces `release/Snug Setup <version>.exe`. The build bundles ffmpeg,
which stitches instant-replay segments together on save.

## Releasing an update

The desktop app checks GitHub Releases for a newer version, downloads it
quietly, and installs it the next time you quit. It never restarts itself
while you're mid-call.

To ship one:

1. Bump `version` in `snug-desktop/package.json`. The updater compares
   against this, so an unchanged version ships nothing.
2. Set a GitHub token with `repo` scope and publish:

   ```bash
   cd snug-desktop
   GH_TOKEN=<your token> npm run release
   ```

That builds and uploads the installer plus `latest.yml` — the manifest the
updater reads — to a GitHub release. Installed copies pick it up within a
few hours, or immediately via Settings → About → Check.

Note the installer isn't code-signed, so Windows SmartScreen warns on first
install. Updates themselves still apply; signing is what removes the
warning.
