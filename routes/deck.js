// The touch panel's Stream Deck-style tile grid. Tiles live in deck.json next to server.js (see
// deck.example.json) and are re-read on every request, so edits apply on the device's next poll.
// The device only ever sends a tile's id, so adding or changing tiles never needs a reflash.

const fs = require("fs");
const path = require("path");
const { toDisplayText } = require("../lib/text");
const { read } = require("../lib/http");
const { playByTitle } = require("../lib/roon-browse");
const { isSpotify } = require("../lib/targets");

const ROOT = path.join(__dirname, "..");
const CONTROLS = new Set(["play", "pause", "playpause", "stop", "previous", "next"]);
const DEFAULT_ICONS = { playpause: "play", next: "next", previous: "prev", stop: "stop", play: "play",
    pause: "pause", play_playlist: "list", play_radio: "radio", volume_step: "volume", transfer: "audio" };
const SPOTIFY_GREEN = "#1a7f3c";

function readDeck(deckPath, examplePath) {
    for (const p of [deckPath, examplePath]) {
        try {
            const deck = JSON.parse(fs.readFileSync(p, "utf8"));
            if (Array.isArray(deck.tiles)) return deck;
        } catch (e) {
            if (e.code !== "ENOENT") console.error(`deck: ${path.basename(p)}: ${e.message}`);
        }
    }
    return { tiles: [] };
}

const usesSpotify = (tile) => tile.type === "spotify" || (tile.type === "open_remote" && isSpotify(tile.zone));

// What the panel draws for one tile. Pure: `now` is { findZone, anyRoonPlaying, spLinked, spPlayer },
// spPlayer being Spotify's player state (or null), fetched once per /deck request.
function tileState(tile, now) {
    const out = {
        id: String(tile.id),
        label: toDisplayText(tile.label || tile.id),
        sub: "",
        icon: tile.icon || "",
        color: tile.color || "",
        active: false,
        kind: tile.type === "open_remote" ? "remote" : "action",
    };
    const spTitle = now.spPlayer && now.spPlayer.item ? toDisplayText(now.spPlayer.item.name) : "";
    const spPlaying = !!(now.spPlayer && now.spPlayer.is_playing);
    const nowPlayingTitle = (z) => toDisplayText(z.now_playing.three_line?.line1 || "");

    if (tile.type === "open_remote") {
        out.icon = out.icon || "audio";
        if (tile.zone) out.zone = isSpotify(tile.zone) ? "spotify" : tile.zone;
        if (isSpotify(tile.zone)) {
            out.sub = now.spLinked ? spTitle : "not linked";
            out.active = spPlaying;
        } else {
            const z = now.findZone(tile.zone);
            if (z && z.now_playing) out.sub = nowPlayingTitle(z);
            out.active = !!(z && z.state === "playing");
            if (tile.zone) out.zone = z ? z.display_name : tile.zone;
        }
    } else if (tile.type === "roon") {
        if (tile.action === "pause_all") {
            const anyPlaying = now.anyRoonPlaying || spPlaying;
            out.icon = out.icon || "pause";
            out.active = anyPlaying;
            out.sub = anyPlaying ? "" : "all paused";
        } else {
            const z = now.findZone(tile.zone);
            if (!z) {
                out.sub = "zone offline";
            } else {
                out.active = z.state === "playing";
                if (["playpause", "next", "previous"].includes(tile.action) && z.now_playing) out.sub = nowPlayingTitle(z);
                if (["play_playlist", "play_radio"].includes(tile.action)) out.sub = toDisplayText(z.display_name);
            }
            if (tile.action === "playpause" && !tile.icon) out.icon = out.active ? "pause" : "play";
            out.icon = out.icon || DEFAULT_ICONS[tile.action] || "";
        }
    } else if (tile.type === "spotify") {
        out.color = out.color || SPOTIFY_GREEN;
        out.active = spPlaying;
        if (!now.spLinked) out.sub = "not linked";
        else if (["playpause", "next", "previous"].includes(tile.action)) out.sub = spTitle;
        else if (tile.action === "transfer") out.sub = "move Spotify here";
        else out.sub = "Spotify";
        if (tile.action === "playpause" && !tile.icon) out.icon = spPlaying ? "pause" : "play";
        out.icon = out.icon || DEFAULT_ICONS[tile.action] || "audio";
    } else if (tile.type === "http") {
        out.icon = out.icon || "bolt";
    }
    return out;
}

function mount(app, { roon, sp, targets, deckPath = path.join(ROOT, "deck.json"), examplePath = path.join(ROOT, "deck.example.json") }) {
    app.get("/deck", read(async () => {
        const deck = readDeck(deckPath, examplePath);
        const spLinked = targets.spotifyLinked();
        let spPlayer = null;
        if (spLinked && deck.tiles.some(usesSpotify)) {
            // The deck polls every 2s; a few seconds of staleness is fine for tile highlights.
            spPlayer = await sp.player(4000).catch(() => null);
        }
        const now = {
            findZone: roon.findZone,
            anyRoonPlaying: Object.values(roon.zones).some((z) => z.state === "playing"),
            spLinked,
            spPlayer,
        };
        return {
            title: toDisplayText(deck.title || "Deck"),
            paired: !!roon.transport(),
            tiles: deck.tiles.map((t) => tileState(t, now)),
        };
    }));

    async function runTile(tile) {
        if (tile.type === "roon") {
            if (tile.action === "pause_all") return targets.pauseAll();
            const target = targets.resolveRoon(tile.zone);
            if (CONTROLS.has(tile.action)) return target.control(tile.action);
            if (tile.action === "play_playlist") return playByTitle(roon.browse(), "playlists", tile.title, target.zone);
            if (tile.action === "play_radio") return playByTitle(roon.browse(), "internet_radio", tile.title, target.zone);
            if (tile.action === "volume_step") return target.changeVolume("relative_step", Number(tile.value) || 1);
            throw new Error(`unknown roon action "${tile.action}"`);
        }
        if (tile.type === "spotify") {
            const spotify = targets.resolveSpotify();
            if (CONTROLS.has(tile.action)) return spotify.control(tile.action);
            if (tile.action === "volume_step") return spotify.changeVolume("relative_step", Number(tile.value) || 1);
            if (tile.action === "play_playlist") return spotify.playPlaylist(tile.title);
            if (tile.action === "transfer") return spotify.transferTo(tile.device);
            throw new Error(`unknown spotify action "${tile.action}"`);
        }
        if (tile.type === "http") {
            const r = await fetch(tile.url, {
                method: tile.method || "POST",
                headers: tile.headers || (tile.body ? { "Content-Type": "application/json" } : undefined),
                body: tile.body === undefined ? undefined : typeof tile.body === "string" ? tile.body : JSON.stringify(tile.body),
                signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return;
        }
        if (tile.type === "open_remote") return; // handled on the device
        throw new Error(`unknown tile type "${tile.type}"`);
    }

    // Not wrapped in action(): a failed press is always 502 with the reason (which the panel shows),
    // whatever status the underlying error would carry elsewhere, and it's logged.
    app.post("/deck/press", async (req, res) => {
        const deck = readDeck(deckPath, examplePath);
        const tile = deck.tiles.find((t) => String(t.id) === String(req.query.id));
        if (!tile) return res.status(404).json({ ok: false, error: "no such tile" });
        try {
            await runTile(tile);
            res.json({ ok: true });
        } catch (e) {
            console.error(`deck press ${tile.id}: ${e.message}`);
            res.status(502).json({ ok: false, error: toDisplayText(e.message) });
        }
    });
}

module.exports = { mount, tileState };
