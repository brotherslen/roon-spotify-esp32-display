// The 3.16" bar display's feed (/nowplaying + /art.raw), and / as a quick pairing check.
// /art.raw also serves the touch deck, Spotify covers included.

const { toDisplayText } = require("../lib/text");

function mount(app, { config, roon, art }) {
    app.get("/", (req, res) => {
        const zone = roon.chooseZone();
        res.json({
            core_paired: roon.paired(),
            known_zones: Object.values(roon.zones).map((z) => z.display_name),
            active_zone: zone ? zone.display_name : null,
        });
    });

    app.get("/nowplaying", (req, res) => {
        const zone = roon.chooseZone();
        if (!zone) {
            return res.json({ has_zone: false });
        }

        const np = zone.now_playing;
        if (!np) {
            return res.json({ has_zone: true, playing: false, zone_name: toDisplayText(zone.display_name) });
        }

        const lines = np.three_line || {};
        res.json({
            has_zone: true,
            playing: zone.state === "playing",
            zone_name: toDisplayText(zone.display_name),
            title: toDisplayText(lines.line1),
            artist: toDisplayText(lines.line2),
            album: toDisplayText(lines.line3),
            art_key: np.image_key || "",
            seek_seconds: np.seek_position || 0,
            length_seconds: np.length || 0,
        });
    });

    app.get("/art.raw", async (req, res) => {
        const key = req.query.key;
        if (!key) return res.status(400).end();
        // Optional ?size= for other panels; default stays ART_PX for the 3.16" bar display.
        const size = req.query.size ? Math.round(Number(req.query.size)) : config.ART_PX;
        if (!Number.isFinite(size) || size < 32 || size > 480) return res.status(400).end();
        try {
            const buf = await art.getArt(key, size);
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Length", buf.length);
            res.end(buf);
        } catch (e) {
            res.status(502).end();
        }
    });
}

module.exports = { mount };
