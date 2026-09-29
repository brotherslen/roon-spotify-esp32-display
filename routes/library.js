// Library browsing for the panel, one list at a time, for Roon zones and Spotify.
//
// GET  /library?zone=Z            -> top level for Z's source (Roon or Spotify)
// GET  /library?zone=Z&open=ID    -> descend into an item (or load the next page)
// GET  /library?zone=Z&back=1     -> up one level
// POST /library/play?zone=Z&id=ID -> play an item whose action is "play"
// Response: { title, can_back, items: [{ id, title, subtitle, action: "open" | "play" }] }
//
// Navigation state lives here (one panel), so the device only ever sends ids it was given. Note
// that a plain GET /library resets that state to the top — including from curl.
//
// Also GET /browse?hierarchy=playlists: exact titles to copy into deck.json.

const { toDisplayText } = require("../lib/text");
const { action, read, httpError } = require("../lib/http");
const { browseCall, loadCall, listTitles } = require("../lib/roon-browse");
const { isSpotify } = require("../lib/targets");

const PAGE = 100;
const HIERARCHIES = new Set(["playlists", "internet_radio", "albums", "artists", "genres", "composers"]);

function mount(app, { roon, sp, targets }) {
    function requireBrowse() {
        const browse = roon.browse();
        if (!browse) throw httpError(503, "Roon browse service unavailable");
        return browse;
    }

    app.get("/browse", read(async (req) => {
        const browse = requireBrowse();
        const hierarchy = req.query.hierarchy || "playlists";
        if (!HIERARCHIES.has(hierarchy)) throw httpError(400, "bad hierarchy");
        return { hierarchy, titles: await listTitles(browse, hierarchy) };
    }));

    // ---- Roon: its browse service is already a stateful list-at-a-time API ----

    const ROON_LIB = "deck-lib";
    let roonLib = { title: "", level: 0, offset: 0, count: 0 };

    async function roonListResponse(browse, list, offset = 0) {
        const r = await loadCall(browse, { hierarchy: "browse", multi_session_key: ROON_LIB, offset, count: PAGE });
        roonLib = { title: list.title || "Library", level: list.level || 0, offset, count: list.count || 0 };
        const items = (r.items || [])
            .filter((i) => i.hint !== "header")
            .map((i) => ({
                id: i.item_key,
                title: toDisplayText(i.title),
                subtitle: toDisplayText(i.subtitle || ""),
                action: i.hint === "action" ? "play" : "open",
            }));
        if (offset + PAGE < roonLib.count) items.push({ id: `more:${offset + PAGE}`, title: "More...", subtitle: "", action: "open" });
        return { title: toDisplayText(roonLib.title), can_back: roonLib.level > 0, items };
    }

    async function roonLibrary(req, zone) {
        const browse = requireBrowse();
        const zid = zone ? zone.zone_id : undefined;
        const open = req.query.open ? String(req.query.open) : "";
        if (open.startsWith("more:")) {
            const offset = Number(open.slice(5)) || 0;
            return roonListResponse(browse, { title: roonLib.title, level: roonLib.level, count: roonLib.count }, offset);
        }
        const nav = open ? { item_key: open } : req.query.back ? { pop_levels: 1 } : { pop_all: true };
        const r = await browseCall(browse, { hierarchy: "browse", ...nav, multi_session_key: ROON_LIB, zone_or_output_id: zid });
        if (r.action === "list") return roonListResponse(browse, r.list || {});
        // Selecting something that acts immediately; stay on the current list.
        return { played: true, message: toDisplayText(r.message || "") };
    }

    // ---- Spotify: a small fixed tree over the read-only library endpoints ----

    let spotifyStack = ["root"];
    const spotifyPlayable = new Map(); // id -> body for PUT /me/player/play

    function spTracksPage(tracks, idPrefix) {
        return tracks.filter(Boolean).map((t, i) => ({
            id: `${idPrefix}:${i}`,
            title: toDisplayText(t.name),
            subtitle: toDisplayText((t.artists || []).map((a) => a.name).join(", ")),
            action: "play",
        }));
    }

    async function spotifyView(view) {
        const [kind, arg] = view.split(":");
        const offset = Number(arg) || 0;
        const more = (next, id) => (next ? [{ id, title: "More...", subtitle: "", action: "open" }] : []);
        if (kind === "root") {
            return {
                title: "Spotify",
                items: [
                    { id: "playlists:0", title: "Playlists", subtitle: "", action: "open" },
                    { id: "liked:0", title: "Liked Songs", subtitle: "", action: "open" },
                    { id: "albums:0", title: "Albums", subtitle: "", action: "open" },
                    { id: "recent", title: "Recently played", subtitle: "", action: "open" },
                ],
            };
        }
        if (kind === "playlists") {
            const page = (await sp.playlists(offset)) || {};
            const items = (page.items || []).filter(Boolean).map((p) => {
                const id = `pl:${p.id}`;
                spotifyPlayable.set(id, { context_uri: p.uri });
                // Feb 2026 API: a playlist's track summary moved from `tracks` to `items`.
                const n = ((p.items || p.tracks) || {}).total;
                return { id, title: toDisplayText(p.name), subtitle: n === undefined ? "" : `${n} tracks`, action: "play" };
            });
            return { title: "Playlists", items: [...items, ...more(page.next, `playlists:${offset + 50}`)] };
        }
        if (kind === "liked") {
            const page = (await sp.likedTracks(offset)) || {};
            const tracks = (page.items || []).map((x) => x && (x.track || x.item));
            const uris = tracks.filter(Boolean).map((t) => t.uri);
            const items = spTracksPage(tracks, `liked${offset}`);
            items.forEach((it, i) => spotifyPlayable.set(it.id, { uris, offset: { position: i } }));
            return { title: "Liked Songs", items: [...items, ...more(page.next, `liked:${offset + 50}`)] };
        }
        if (kind === "albums") {
            const page = (await sp.savedAlbums(offset)) || {};
            const items = (page.items || []).map((x) => x && x.album).filter(Boolean).map((a) => {
                const id = `al:${a.id}`;
                spotifyPlayable.set(id, { context_uri: a.uri });
                return { id, title: toDisplayText(a.name), subtitle: toDisplayText((a.artists || []).map((r) => r.name).join(", ")), action: "play" };
            });
            return { title: "Albums", items: [...items, ...more(page.next, `albums:${offset + 50}`)] };
        }
        if (kind === "recent") {
            const page = (await sp.recentlyPlayed()) || {};
            const rows = (page.items || []).filter((x) => x && x.track);
            const items = spTracksPage(rows.map((x) => x.track), "recent");
            items.forEach((it, i) => {
                const row = rows[i];
                const c = row.context && row.context.uri;
                spotifyPlayable.set(it.id, c && !c.includes(":collection") ? { context_uri: c, offset: { uri: row.track.uri } } : { uris: [row.track.uri] });
            });
            return { title: "Recently played", items };
        }
        throw httpError(404, "unknown library view");
    }

    async function spotifyLibrary(req) {
        // Work out the new stack first and commit it only once its view has rendered, so a view
        // that fails (a stale id, a Spotify error) doesn't stay on the stack.
        let stack;
        if (req.query.open) stack = [...spotifyStack, String(req.query.open)];
        else if (req.query.back) stack = spotifyStack.length > 1 ? spotifyStack.slice(0, -1) : spotifyStack;
        else stack = ["root"];
        const view = await spotifyView(stack[stack.length - 1]);
        spotifyStack = stack;
        return { ...view, can_back: stack.length > 1 };
    }

    // action(), not read(): this route has always answered {"ok":true, ...}.
    app.get("/library", action(async (req) => {
        if (isSpotify(req.query.zone)) {
            targets.resolveSpotify(); // throws unless linked
            return spotifyLibrary(req);
        }
        return roonLibrary(req, roon.findZone(req.query.zone));
    }));

    app.post("/library/play", action(async (req) => {
        const id = String(req.query.id || "");
        if (isSpotify(req.query.zone)) {
            const spotify = targets.resolveSpotify();
            const body = spotifyPlayable.get(id);
            if (!body) throw httpError(404, "item expired; reopen the list");
            await spotify.play(body);
            return;
        }
        const browse = requireBrowse();
        const zone = roon.findZone(req.query.zone);
        if (!zone) throw httpError(404, "pick a Roon zone first");
        const r = await browseCall(browse, { hierarchy: "browse", item_key: id, multi_session_key: ROON_LIB, zone_or_output_id: zone.zone_id });
        return { message: toDisplayText(r.message || "") };
    }));
}

module.exports = { mount };
