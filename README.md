# Roon & Spotify Now Playing Bridge

A small node service that allows you to see and control what's now playing via Roon or Spotify on any of your
speaker zones, displayed on an inexpensive 3.5" ESP32-S3 touch display. Additionally the remote allows
you to change songs, switch services, control speaker zones, etc. Base project is complete, with current work
being done on the UI and expanded functionality.

Roon's API expects a persistent connection and a real computer, which an ESP32 can't provide. The
bridge handles Roon and Spotify, then serves what the display needs: track info, resized album art,
and controls — as simple web requests. The display just asks what's playing every couple of seconds,
so a dropped connection or a restart fixes itself.

Developed with the assistance of Claude code. 

## What the panel shows

| Screen | What it does |
|---|---|
| Now playing | Title, artist, album art and progress for the active zone |
| Deck | A tile grid: play/pause per zone, volume, playlists, radio, transfer between zones |
| Remote | Transport controls for whichever zone you're pointed at, Roon or Spotify |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /nowplaying` | Current track as JSON |
| `GET /art.raw` | Album art, pre-scaled to the panel's resolution |
| `GET /deck` | Tile layout and per-tile state |
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
