// The Roon Core connection: pairing, the live zone list, and the services the routes use.
//
// createRoon() only builds the extension; start() begins discovery. The zone helpers are plain
// functions of the zone map, so they can be used (and tested) without a Core.

const RoonApi = require("node-roon-api");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiImage = require("node-roon-api-image");
const RoonApiBrowse = require("node-roon-api-browse");

// The zone the display follows: `zoneName` if it exists, else the first one playing, else the
// first known zone.
function chooseZone(zones, zoneName) {
    const all = Object.values(zones);
    if (!all.length) return undefined;
    if (zoneName) {
        const match = all.find((z) => z.display_name === zoneName);
        if (match) return match;
    }
    const playing = all.find((z) => z.state === "playing");
    return playing || all[0];
}

// Accepts a zone id, a zone's display name, or the name (or id) of any speaker (output) in a zone,
// case-insensitive; with no ref, falls back to chooseZone. Grouping in Roon merges zones into one
// with a new name ("Kitchen + 1"), so matching members keeps a deck tile saying "Kitchen" working
// while Kitchen is grouped. A zone's own name wins over a member name.
function findZone(zones, ref, zoneName) {
    if (!ref) return chooseZone(zones, zoneName);
    if (zones[ref]) return zones[ref];
    const all = Object.values(zones);
    const byName = (name) =>
        all.find((z) => z.display_name.toLowerCase() === name) ||
        all.find((z) => (z.outputs || []).some((o) => (o.display_name || "").toLowerCase() === name || o.output_id === ref));
    const lower = String(ref).toLowerCase();
    // A group's name held from before it was ungrouped (the panel remembers the zone it last showed):
    // fall back to the group's first member.
    return byName(lower) || (lower.includes(" + ") ? byName(lower.split(" + ")[0].trim()) : undefined);
}

// Roon's service calls take a trailing (err, result) callback; roonCall(cb => svc.x(..., cb))
// turns one into a promise of the result.
function roonCall(fn) {
    return new Promise((resolve, reject) => {
        fn((err, result) => (err ? reject(new Error(String(err))) : resolve(result)));
    });
}

function createRoon({ zoneName }) {
    let core, transport, image, browse;
    const zones = {}; // zone_id -> zone object, kept current by the transport subscription

    const api = new RoonApi({
        // The Roon API logs every zone update in full by default, which buries our own messages and
        // grows the service log without bound on a long-running install.
        log_level: "none",
        extension_id: "com.local.now-playing-bridge",
        display_name: "Now Playing Bridge",
        display_version: "1.0.0",
        publisher: "local",
        email: "noreply@example.com",
        website: "https://github.com/",

        core_paired: (core_) => {
            core = core_;
            transport = core.services.RoonApiTransport;
            image = core.services.RoonApiImage;
            browse = core.services.RoonApiBrowse;
            console.log(`Paired with Roon Core: ${core.display_name}`);

            transport.subscribe_zones((response, msg) => {
                if (response === "Subscribed") {
                    for (const z of msg.zones) zones[z.zone_id] = z;
                } else if (response === "Changed") {
                    if (msg.zones_removed) {
                        for (const id of msg.zones_removed) delete zones[id];
                    }
                    if (msg.zones_added) {
                        for (const z of msg.zones_added) zones[z.zone_id] = z;
                    }
                    if (msg.zones_changed) {
                        for (const z of msg.zones_changed) zones[z.zone_id] = z;
                    }
                    if (msg.zones_seek_changed) {
                        for (const s of msg.zones_seek_changed) {
                            const z = zones[s.zone_id];
                            if (z && z.now_playing) z.now_playing.seek_position = s.seek_position;
                        }
                    }
                }
            });
        },

        core_unpaired: () => {
            console.log("Unpaired from Roon Core");
            core = transport = image = browse = undefined;
            for (const id of Object.keys(zones)) delete zones[id];
        },
    });

    const svcStatus = new RoonApiStatus(api);
    api.init_services({
        required_services: [RoonApiTransport, RoonApiImage],
        // Optional so an older pairing keeps working if the Core ever declines it.
        optional_services: [RoonApiBrowse],
        provided_services: [svcStatus],
    });

    return {
        zones,
        start() {
            svcStatus.set_status("Waiting for Roon Core...", false);
            api.start_discovery();
        },
        paired: () => !!core,
        // Each is undefined while unpaired; browse also when the Core declined it.
        transport: () => transport,
        image: () => image,
        browse: () => browse,
        chooseZone: () => chooseZone(zones, zoneName),
        findZone: (ref) => findZone(zones, ref, zoneName),
    };
}

module.exports = { createRoon, chooseZone, findZone, roonCall };
