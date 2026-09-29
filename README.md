# Roon Now Playing Bridge

A small Node service that puts what's playing on your stereo onto cheap ESP32-S3 displays.

Roon's own API is a persistent socket protocol built for desktop extensions, which a microcontroller
can't reasonably speak. This bridge pairs with Roon Core once, then exposes the parts a display
actually needs as plain HTTP: current track, album art pre-scaled to the panel's resolution, and
transport controls. The firmware side stays a dumb polling client, which is what makes it reliable.

Spotify is supported through the same interface, so a display or a tile keeps working whether the
music is coming from Roon or from Spotify Connect.

## What it drives

| Display | What it shows |
|---|---|
| ESP32-S3 bar display | Now playing: title, artist, album art, progress |
| 3.5" touch panel | A tile grid: play/pause per zone, volume, playlists, radio, transfer between zones |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /nowplaying` | Current track as JSON, plus album art as a pre-scaled JPEG |
| `GET /deck` | Tile layout and per-tile state for the touch panel |
| `POST /remote/...` | Transport: play/pause, next, previous, volume, zone transfer |
| `GET /library/...` | Browse Roon's library: playlists, radio, albums |
| `GET /spotify/login` | One-time OAuth link for Spotify Connect |

## Running it

```bash
npm install
node server.js
```

Then approve the extension in Roon under **Settings → Extensions**. Pairing happens once and the
token is written to `config.json`, which is gitignored.

Point the firmware at `http://<host-ip>:8080`. Defaults live in `config.js` and each one can be
overridden with an environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port the firmware polls |
| `ZONE_NAME` | *(empty)* | Pin one Roon zone; empty means "whichever zone is playing" |

For Spotify, create an app in the Spotify developer dashboard, put its client ID in `spotify.json`,
and visit `/spotify/login` once. That file and the resulting token are gitignored.

To build a tile grid, copy `deck.example.json` to `deck.json` and edit it. It's re-read on every
request, so changes appear on the panel's next poll, without a restart.

On Windows, `run-bridge.cmd` is a supervisor for running the bridge as a scheduled task: it
truncates the log at startup, restarts the service if it exits, and shuts down cleanly when the task
is stopped rather than leaving an orphaned process holding the port.

## Design notes

A few things that turned out to matter:

- **Album art is resized server-side** with `sharp`. The panel has no headroom to decode and scale a
  1400×1400 JPEG, so it gets exactly the pixels it will draw.
- **Roon and Spotify sit behind one interface** (`lib/targets.js`), so routes never branch on which
  source is playing.
- **Spotify state is served from cache while it refreshes.** A slow Spotify API call used to stall
  Roon polling, which showed up on the display as a frozen track.
- **One bad request can't take the service down.** An unhandled rejection is logged, not fatal:
  otherwise the display reads "Bridge unreachable" until someone notices.

## Layout

```
server.js       wiring only: create services, mount routes, listen
config.js       defaults, all overridable by environment variable
lib/roon.js     pairing, zone tracking, transport
lib/spotify.js  Web API client and token refresh
lib/targets.js  Roon and Spotify behind a single interface
lib/art.js      album art fetch and resize
routes/         one module per screen or feature
```
