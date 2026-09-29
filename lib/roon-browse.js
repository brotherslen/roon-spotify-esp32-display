// Roon Browse, promise-style. Browse is a stateful list-at-a-time API: each multi_session_key is
// its own cursor, so each consumer here uses a separate key and can't disturb another's position.

const { roonCall } = require("./roon");

const browseCall = (browse, opts) => roonCall((cb) => browse.browse(opts, cb));
const loadCall = (browse, opts) => roonCall((cb) => browse.load(opts, cb));

// All items of the current list (up to 1000), 100 at a time.
async function loadAll(browse, hierarchy, session, total) {
    const items = [];
    const count = Math.min(total || 0, 1000);
    for (let offset = 0; offset < count; offset += 100) {
        const r = await loadCall(browse, { hierarchy, multi_session_key: session, offset, count: 100 });
        items.push(...(r.items || []));
    }
    return items;
}

// Titles at the top of a hierarchy (e.g. "playlists"), for copying exact names into deck.json.
async function listTitles(browse, hierarchy) {
    const session = "deck-list";
    const r = await browseCall(browse, { hierarchy, pop_all: true, multi_session_key: session });
    const items = await loadAll(browse, hierarchy, session, r.list && r.list.count);
    return items.map((i) => i.title);
}

// Finds `title` at the top of `hierarchy` and plays it in `zone`, walking the action menus Roon
// presents ("Play Now", "Play Playlist", ...). Radio stations usually play on the first select.
async function playByTitle(browse, hierarchy, title, zone) {
    if (!browse) throw new Error("browse service unavailable");
    const session = "deck-play";
    const zid = zone.zone_id;
    let r = await browseCall(browse, { hierarchy, pop_all: true, multi_session_key: session, zone_or_output_id: zid });
    const top = await loadAll(browse, hierarchy, session, r.list && r.list.count);
    const want = String(title).toLowerCase();
    let item = top.find((i) => (i.title || "").toLowerCase() === want);
    if (!item) throw new Error(`"${title}" not found in ${hierarchy}`);

    const PREFERRED = ["play now", "play playlist", "play radio", "play", "start radio"];
    for (let depth = 0; depth < 5; depth++) {
        r = await browseCall(browse, { hierarchy, item_key: item.item_key, multi_session_key: session, zone_or_output_id: zid });
        if (r.action !== "list") return; // "message"/"none": Roon performed the action
        const items = await loadAll(browse, hierarchy, session, r.list && r.list.count);
        const actions = items.filter((i) => i.hint === "action");
        if (actions.length) {
            item =
                PREFERRED.map((p) => actions.find((a) => (a.title || "").toLowerCase() === p)).find(Boolean) ||
                actions[0];
            continue;
        }
        const menu = items.find((i) => i.hint === "action_list");
        if (!menu) throw new Error(`no play action for "${title}"`);
        item = menu;
    }
    throw new Error(`gave up looking for a play action for "${title}"`);
}

module.exports = { browseCall, loadCall, listTitles, playByTitle };
