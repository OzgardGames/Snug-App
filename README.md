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

Produces `release/Snug Setup 1.0.0.exe`. The build bundles ffmpeg, which
stitches instant-replay segments together on save.
