// The 3.5" touch panel's remote screen: state polling, transport, volume, seek and zone selection,
// for Roon zones and Spotify alike (see lib/targets.js).
//
// Zones: a Roon zone is addressed by its zone id or display name. Spotify is one extra "zone"
// addressed as "spotify"; which Spotify Connect device it plays on is switched with /select_zone.
// Controls are POST with query parameters, which keeps the firmware side to a bare URL.

const { toDisplayText } = require("../lib/text");
const { action, read, httpError } = require("../lib/http");
const { isSpotify, roonZoneState, LOOP_ORDER } = require("../lib/targets");

const CONTROLS = new Set(["play", "pause", "playpause", "stop", "previous", "next"]);

function mount(app, { roon, sp, targets }) {
    // ---- the zone picker ----

    // `ref` is what the panel stores and sends back as ?zone= for this entry.
    function zoneSummary(z) {
        const np = z.now_playing;
        const lines = (np && np.three_line) || {};
        return {
            id: z.zone_id,
            ref: z.display_name,
            name: toDisplayText(z.display_name),
            state: z.state,
            title: toDisplayText(lines.line1 || ""),
            artist: toDisplayText(lines.line2 || ""),
        };
    }

    // Spotify Connect devices as picker entries: the ones Spotify lists now, then remembered ones it
    // doesn't ("asleep"; picking one tries the transfer anyway, see lib/spotify.js). Never throws:
    // Spotify trouble must not take the Roon zones down with it. Every /remote poll lands here,
    // Roon zone or not, and the picker only shows a title, so it settles for player state up to 5s
    // old (the Spotify screen itself re-reads at the usual 1s via the target's state()).
    function deviceState(d, p) {
        if (!d.online) return "asleep";
        if (d.is_restricted) return "not controllable";
        return d.is_active ? (p && p.is_playing ? "playing" : "paused") : "available";
    }

    async function spotifyZoneEntries() {
        if (!targets.spotifyLinked()) return [];
        try {
            const [p, devs] = await Promise.all([sp.player(5000), sp.allDevices()]);
            const title = p && p.item ? toDisplayText(p.item.name) : "";
            if (!devs.length) {
                return [{ id: "spotify", ref: "spotify", name: "Spotify", state: "no devices online", title: "", artist: "" }];
            }
            return devs.map((d) => ({
                id: `spotify-dev:${d.id}`,
                ref: "spotify",
                name: toDisplayText(`Spotify: ${d.name}`),
                state: deviceState(d, p),
                title: d.is_active ? title : "",
                artist: "",
            }));
        } catch (e) {
            return [{ id: "spotify", ref: "spotify", name: "Spotify", state: toDisplayText(e.message), title: "", artist: "" }];
        }
    }

    async function allZones() {
        return [...Object.values(roon.zones).map(zoneSummary), ...(await spotifyZoneEntries())];
    }

    // ---- reads ----

    app.get("/zones", read(async () => ({ zones: await allZones() })));

    // Everything the remote screen needs in one poll: the selected zone's full state plus a short
    // list of all zones (Roon zones and Spotify devices) for the picker. Always 200: problems show
    // up as the zone's state, so the panel keeps its picker to switch away with.
    app.get("/remote", read(async (req) => {
        const zones = await allZones();
        const stopped = { has_zone: true, zone_id: "spotify", state: "stopped", has_track: false };
        if (isSpotify(req.query.zone)) {
            if (!targets.spotifyLinked()) return { ...stopped, zone_name: "Spotify (not linked)", zones };
            try {
                return { ...(await targets.resolveSpotify().state()), zones };
            } catch (e) {
                return { ...stopped, zone_name: "Spotify", title: toDisplayText(e.message), zones };
            }
        }
        const zone = roon.findZone(req.query.zone);
        if (!zone) return { has_zone: false, zones };
        return { ...roonZoneState(zone), zones };
    }));

    // ---- controls ----

    // Picking an entry in the panel's zone list. Roon zones need nothing here; a Spotify device
    // entry moves Spotify playback onto that device.
    app.post("/select_zone", action(async (req) => {
        const id = String(req.query.id || "");
        if (id.startsWith("spotify-dev:")) await targets.resolveSpotify().transfer(id.slice("spotify-dev:".length));
    }));

    app.post("/control", action(async (req) => {
        const act = req.query.action;
        if (!CONTROLS.has(act)) throw httpError(400, "bad action");
        await targets.resolve(req.query.zone).control(act);
    }));

    app.post("/pause_all", action(async () => {
        await targets.pauseAll();
    }));

    // mode: "absolute" (value in the zone's own units) or "relative_step" (value = +/- steps).
    app.post("/volume", action(async (req) => {
        const mode = req.query.mode === "absolute" ? "absolute" : "relative_step";
        const value = Number(req.query.value);
        if (!Number.isFinite(value)) throw httpError(400, "bad value");
        await targets.resolve(req.query.zone).changeVolume(mode, value);
    }));

    // value=mute|unmute; anything else toggles.
    app.post("/mute", action(async (req) => ({
        muted: await targets.resolve(req.query.zone).mute(req.query.value),
    })));

    app.post("/seek", action(async (req) => {
        const seconds = Math.max(0, Math.round(Number(req.query.seconds)));
        if (!Number.isFinite(seconds)) throw httpError(400, "bad seconds");
        await targets.resolve(req.query.zone).seek(seconds);
    }));

    // shuffle=true|false|toggle, loop=disabled|loop|loop_one|next (next cycles through the three).
    // Responds with what was applied.
    app.post("/settings", action(async (req) => {
        const target = targets.resolve(req.query.zone);
        const cur = await target.settings();
        const change = {};
        if (req.query.shuffle !== undefined) {
            change.shuffle = req.query.shuffle === "toggle" ? !cur.shuffle : req.query.shuffle === "true";
        }
        if (req.query.loop !== undefined) {
            change.loop = req.query.loop === "next" ? LOOP_ORDER[(LOOP_ORDER.indexOf(cur.loop) + 1) % 3] : req.query.loop;
            if (!LOOP_ORDER.includes(change.loop)) throw httpError(400, "bad loop");
        }
        await target.applySettings(change);
        return change;
    }));
}

module.exports = { mount };
