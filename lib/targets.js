// Playback targets: one interface for everything the remote screen and the deck tiles can drive,
// whether that's a Roon zone or Spotify (playing on whichever Connect device is active). Routes
// resolve a target from the panel's ?zone= and call it, instead of branching on the source.
//
//   state()                 the /remote body for this target (the route adds `zones`)
//   control(action)         play | pause | playpause | stop | previous | next
//   changeVolume(mode, v)   "absolute" (the target's own units) or "relative_step" (+/- steps)
//   mute(how) -> muted      "mute" | "unmute" | anything else toggles
//   seek(seconds)
//   settings()              current { shuffle, loop }, loop being disabled | loop | loop_one
//   applySettings(change)   change: { shuffle?, loop? } in the same terms
//
// Roon targets also expose `zone`; the Spotify target adds a few Spotify-only actions.

const { roonCall } = require("./roon");
const { httpError } = require("./http");
const { toDisplayText } = require("./text");

const isSpotify = (ref) => String(ref || "").toLowerCase() === "spotify";

const REPEAT_TO_LOOP = { off: "disabled", context: "loop", track: "loop_one" };
const LOOP_TO_REPEAT = { disabled: "off", loop: "context", loop_one: "track" };

// ---- Roon ----

function volumeOf(zone) {
    // A zone is one output unless grouped; the first output with a volume control speaks for it.
    const out = (zone.outputs || []).find((o) => o.volume);
    if (!out) return null;
    const v = out.volume;
    return {
        type: v.type, // "number" | "db" | "incremental"
        min: v.min === undefined ? null : v.min,
        max: v.max === undefined ? null : v.max,
        value: v.value === undefined ? null : v.value,
        step: v.step === undefined ? null : v.step,
        muted: !!v.is_muted,
    };
}

// Needs no transport: /remote shows a zone's state even while its controls would fail.
function roonZoneState(zone) {
    const np = zone.now_playing;
    const lines = (np && np.three_line) || {};
    const settings = zone.settings || {};
    return {
        has_zone: true,
        zone_id: zone.zone_id,
        zone_name: toDisplayText(zone.display_name),
        state: zone.state, // playing | paused | loading | stopped
        has_track: !!np,
        title: toDisplayText(lines.line1 || ""),
        artist: toDisplayText(lines.line2 || ""),
        album: toDisplayText(lines.line3 || ""),
        art_key: (np && np.image_key) || "",
        seek_seconds: (np && np.seek_position) || 0,
        length_seconds: (np && np.length) || 0,
        can_prev: !!zone.is_previous_allowed,
        can_next: !!zone.is_next_allowed,
        can_seek: !!zone.is_seek_allowed,
        shuffle: !!settings.shuffle,
        loop: settings.loop || "disabled", // disabled | loop | loop_one
        volume: volumeOf(zone),
    };
}

function roonTarget(zone, transport) {
    function volumeOutputs() {
        const outputs = (zone.outputs || []).filter((o) => o.volume);
        if (!outputs.length) throw httpError(409, "zone has no volume control");
        return outputs;
    }

    return {
        zone,
        state: () => roonZoneState(zone),
        control: (action) => roonCall((cb) => transport.control(zone, action, cb)),
        async changeVolume(mode, value) {
            // Grouped zones: move every output, which is what Roon's own zone volume does.
            await Promise.all(
                volumeOutputs().map((o) => {
                    let v = value;
                    if (mode === "absolute" && o.volume.min !== undefined && o.volume.max !== undefined) {
                        v = Math.min(o.volume.max, Math.max(o.volume.min, v));
                    }
                    return roonCall((cb) => transport.change_volume(o, mode, v, cb));
                })
            );
        },
        async mute(how) {
            const outputs = volumeOutputs();
            if (how !== "mute" && how !== "unmute") how = outputs[0].volume.is_muted ? "unmute" : "mute";
            await Promise.all(outputs.map((o) => roonCall((cb) => transport.mute(o, how, cb))));
            return how === "mute";
        },
        seek: (seconds) => roonCall((cb) => transport.seek(zone, "absolute", seconds, cb)),
        settings() {
            const s = zone.settings || {};
            return { shuffle: !!s.shuffle, loop: s.loop || "disabled" };
        },
        applySettings: (change) => roonCall((cb) => transport.change_settings(zone, change, cb)),
    };
}

// ---- Spotify ----

// Picks a cover image near `want` pixels and turns its URL into an /art.raw key.
function spotifyArtKey(images, want = 300) {
    if (!images || !images.length) return "";
    const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
    const pick = sorted.find((i) => (i.width || 0) >= want) || sorted[sorted.length - 1];
    const m = /\/image\/([0-9a-f]+)$/i.exec(pick.url || "");
    return m ? `sp:${m[1]}` : "";
}

function spotifyTarget(sp) {
    return {
        async state() {
            const p = await sp.player();
            const item = p && p.item;
            const episode = item && item.type === "episode";
            const dev = p && p.device;
            const disallows = (p && p.actions && p.actions.disallows) || {};
            const hasVolume = dev && dev.supports_volume !== false && typeof dev.volume_percent === "number";
            return {
                has_zone: true,
                zone_id: "spotify",
                zone_name: toDisplayText(dev ? `Spotify: ${dev.name}` : "Spotify"),
                state: !p ? "stopped" : p.is_playing ? "playing" : "paused",
                has_track: !!item,
                title: toDisplayText(item ? item.name : ""),
                artist: toDisplayText(
                    !item ? "" : episode ? (item.show && item.show.name) || "" : (item.artists || []).map((a) => a.name).join(", ")
                ),
                album: toDisplayText(item && !episode && item.album ? item.album.name : ""),
                art_key: item ? spotifyArtKey(episode ? item.images || (item.show && item.show.images) : item.album && item.album.images) : "",
                seek_seconds: p ? Math.floor((p.progress_ms || 0) / 1000) : 0,
                length_seconds: item ? Math.floor((item.duration_ms || 0) / 1000) : 0,
                can_prev: !!item && !disallows.skipping_prev,
                can_next: !!item && !disallows.skipping_next,
                can_seek: !!item && !disallows.seeking,
                shuffle: !!(p && p.shuffle_state),
                loop: REPEAT_TO_LOOP[(p && p.repeat_state) || "off"] || "disabled",
                volume: hasVolume
                    ? { type: "number", min: 0, max: 100, value: dev.volume_percent, step: 1, muted: dev.volume_percent === 0 }
                    : null,
            };
        },
        control: (action) => sp.control(action),
        changeVolume: (mode, value) => sp.volume(mode, value),
        mute: (how) => sp.mute(how),
        seek: (seconds) => sp.seek(seconds),
        async settings() {
            const p = await sp.player(0);
            return { shuffle: !!(p && p.shuffle_state), loop: REPEAT_TO_LOOP[(p && p.repeat_state) || "off"] || "disabled" };
        },
        async applySettings(change) {
            if (change.shuffle !== undefined) await sp.setShuffle(change.shuffle);
            if (change.loop !== undefined) await sp.setRepeat(LOOP_TO_REPEAT[change.loop]);
        },

        // Spotify-only
        transfer: (deviceId) => sp.transfer(deviceId),
        play: (body) => sp.play(body), // body: { context_uri } or { uris, offset }
        async playPlaylist(title) {
            const pl = await sp.findPlaylist(title);
            if (!pl) throw new Error(`playlist "${title}" not found`);
            await sp.play({ context_uri: pl.uri });
        },
        // By name, including remembered devices Spotify isn't listing right now.
        async transferTo(deviceName) {
            const want = String(deviceName || "").toLowerCase();
            const dev = (await sp.allDevices(0)).find((d) => d.name.toLowerCase() === want);
            if (!dev) throw new Error(`Spotify device "${deviceName}" not seen yet`);
            await sp.transfer(dev.id);
        },
    };
}

// ---- resolving a panel's ?zone= ----

function createTargets({ roon, sp }) {
    const spotifyLinked = () => sp.authorized();

    function resolveSpotify() {
        if (!spotifyLinked()) throw httpError(503, "Spotify not linked (see /spotify/login on the bridge)");
        return spotifyTarget(sp);
    }

    // A zone id or display name; none means the bridge's default zone.
    function resolveRoon(ref) {
        const transport = roon.transport();
        if (!transport) throw httpError(503, "not paired with a Roon Core");
        const zone = roon.findZone(ref);
        if (!zone) throw httpError(404, ref ? `zone "${ref}" not found` : "no Roon zones");
        return roonTarget(zone, transport);
    }

    // "spotify" (any case) is Spotify; anything else is a Roon zone.
    const resolve = (ref) => (isSpotify(ref) ? resolveSpotify() : resolveRoon(ref));

    // Pauses every Roon zone and, if it's playing, Spotify. A Spotify failure is ignored so it
    // can't stop the Roon half from reporting success.
    async function pauseAll() {
        const jobs = [];
        const transport = roon.transport();
        if (transport) jobs.push(roonCall((cb) => transport.pause_all(cb)));
        if (spotifyLinked()) {
            jobs.push(sp.player(0).then((p) => (p && p.is_playing ? sp.control("pause") : null)).catch(() => {}));
        }
        await Promise.all(jobs);
    }

    return { resolve, resolveRoon, resolveSpotify, pauseAll, spotifyLinked };
}

module.exports = { createTargets, isSpotify, roonZoneState, LOOP_ORDER: ["disabled", "loop", "loop_one"] };
