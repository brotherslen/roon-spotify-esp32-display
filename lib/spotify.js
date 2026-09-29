// Spotify Web API client for the bridge: one-time PKCE login, token refresh, a cached player
// state, and the calls the touch panel needs (playback, devices, library).
//
// Setup (on the machine running the bridge):
//   1. Create an app at https://developer.spotify.com/dashboard with redirect URI
//      http://127.0.0.1:<PORT>/spotify/callback and "Web API" enabled.
//   2. Put its Client ID in spotify.json next to server.js: { "client_id": "..." }
//   3. Open http://127.0.0.1:<PORT>/spotify/login in a browser ON THAT MACHINE and approve.
//      Spotify only allows plain-http redirects to a loopback IP, so this can't be done from
//      another PC. The refresh token lands in spotify-token.json (keep it out of copies).
//
// Uses PKCE, so there is no client secret anywhere.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "spotify.json");
const TOKEN_PATH = path.join(ROOT, "spotify-token.json");
const DEVICES_PATH = path.join(ROOT, "spotify-devices.json");

const SCOPES = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-library-read",
].join(" ");

const API = "https://api.spotify.com/v1";

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

// Write-then-rename, so a crash or power cut mid-write leaves the previous file intact rather than
// a truncated one (for the token, that would mean linking Spotify again by hand).
function writeJsonAtomic(file, value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    try {
        fs.renameSync(tmp, file);
    } catch (e) {
        // Windows refuses the replace while another process (e.g. a virus scanner) has the file
        // open. Fall back to writing in place: rarely needed, and no worse than before.
        console.error(`spotify: couldn't replace ${path.basename(file)} (${e.code}); writing it in place`);
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
        fs.rmSync(tmp, { force: true });
    }
}

function createSpotify({ port }) {
    const redirectUri = `http://127.0.0.1:${port}/spotify/callback`;
    let token = readJson(TOKEN_PATH); // { refresh_token, access_token, expires_at }
    let pendingAuth = null; // { state, verifier }
    let backoffUntil = 0; // set on 429

    function clientId() {
        const cfg = readJson(CONFIG_PATH);
        return cfg && cfg.client_id ? String(cfg.client_id).trim() : "";
    }

    function configured() {
        return !!clientId();
    }

    function authorized() {
        return !!(token && token.refresh_token);
    }

    function saveToken() {
        writeJsonAtomic(TOKEN_PATH, token);
    }

    async function tokenRequest(params) {
        const r = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(10000),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            const e = new Error(`token: ${body.error_description || body.error || r.status}`);
            e.oauthError = body.error;
            throw e;
        }
        return body;
    }

    // Concurrent callers share one refresh: refresh tokens can rotate on use, so two parallel
    // refreshes with the same token could leave the second one holding a revoked token.
    let refreshing = null;

    async function accessToken() {
        if (!authorized()) throw new Error("Spotify not linked");
        if (token.access_token && Date.now() < token.expires_at - 60000) return token.access_token;
        if (!refreshing) refreshing = refreshAccessToken().finally(() => { refreshing = null; });
        return refreshing;
    }

    async function refreshAccessToken() {
        let t;
        try {
            t = await tokenRequest({
                grant_type: "refresh_token",
                refresh_token: token.refresh_token,
                client_id: clientId(),
            });
        } catch (e) {
            // The refresh token is dead (access removed in Spotify's account settings, or expired).
            // Drop it, so /spotify/status and the deck say "not linked" instead of reporting a link
            // that fails every call.
            if (e.oauthError === "invalid_grant") {
                console.error(`Spotify refresh token rejected (${e.message}); link again at /spotify/login`);
                token = null;
                fs.rmSync(TOKEN_PATH, { force: true });
                throw new Error("Spotify link expired; link again at /spotify/login");
            }
            throw e;
        }
        token = {
            // PKCE refresh tokens can rotate; keep the newest one.
            refresh_token: t.refresh_token || token.refresh_token,
            access_token: t.access_token,
            expires_at: Date.now() + t.expires_in * 1000,
        };
        saveToken();
        return token.access_token;
    }

    // Returns parsed JSON, or null for 204/empty bodies. Throws with Spotify's reason on errors.
    async function api(method, pathAndQuery, body, retried = false) {
        if (Date.now() < backoffUntil) throw new Error("Spotify rate limit, retrying shortly");
        const r = await fetch(API + pathAndQuery, {
            method,
            headers: {
                Authorization: `Bearer ${await accessToken()}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10000),
        });
        if (r.status === 401 && !retried) {
            if (token) token.access_token = null; // a concurrent refresh may have dropped the link
            return api(method, pathAndQuery, body, true);
        }
        if (r.status === 429) {
            const wait = Number(r.headers.get("retry-after")) || 5;
            backoffUntil = Date.now() + wait * 1000;
            throw new Error(`Spotify rate limit, retry in ${wait}s`);
        }
        const text = await r.text();
        const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
        if (!r.ok) {
            const reason = (json && json.error && (json.error.message || json.error.reason)) || `HTTP ${r.status}`;
            const e = new Error(reason);
            e.status = r.status;
            throw e;
        }
        return json;
    }

    // ---- cached state (the panel polls once a second; Spotify quotas are per 30s window) ----
    //
    // /remote and /deck serve Roon zones too, so a slow or failing Spotify API must not hold them
    // up. Pollers therefore get the cached value at once and a refresh runs in the background.
    // Callers about to act on the state pass maxAgeMs = 0 and wait for a fresh read. Once the
    // cache is older than STALE_LIMIT_MS, or after invalidate(), everyone waits again — so an
    // outage shows up as an error rather than as state frozen at whatever it last was.

    const STALE_LIMIT_MS = 30000;
    // With nothing active on any device, /me/player returns 204 (null here); poll it less often.
    // A session started from a phone then takes up to this long to appear on the panel.
    const IDLE_MAX_AGE_MS = 15000;

    let playerCache = { at: 0, value: null, pending: null };
    let devicesCache = { at: 0, value: [], pending: null };

    function cached(cache, maxAgeMs, loader) {
        const age = Date.now() - cache.at;
        if (age < maxAgeMs) return Promise.resolve(cache.value);
        if (!cache.pending) {
            cache.pending = loader()
                .then((v) => {
                    cache.value = v;
                    cache.at = Date.now();
                    return v;
                })
                .finally(() => {
                    cache.pending = null;
                });
            cache.pending.catch(() => {}); // a background refresh nobody waits on must not go unhandled
        }
        return maxAgeMs === 0 || age > STALE_LIMIT_MS ? cache.pending : Promise.resolve(cache.value);
    }

    function invalidate() {
        playerCache.at = 0;
        devicesCache.at = 0;
    }

    const player = (maxAgeMs = 900) => {
        const idle = maxAgeMs > 0 && playerCache.at > 0 && playerCache.value === null;
        return cached(playerCache, idle ? Math.max(maxAgeMs, IDLE_MAX_AGE_MS) : maxAgeMs, () =>
            api("GET", "/me/player?additional_types=episode")
        );
    };
    // Devices Spotify lists right now. See allDevices() for ones it has listed before.
    const devices = (maxAgeMs = 8000) =>
        cached(devicesCache, maxAgeMs, async () => {
            const list = ((await api("GET", "/me/player/devices")) || {}).devices || [];
            rememberDevices(list);
            return list;
        });

    // ---- remembered devices ----
    //
    // Spotify's device list only has devices connected to the account at that moment: the desktop
    // app while it's running, a speaker while Spotify is playing on it or shortly after. Speakers
    // that phones find on the LAN (Cast, Sonos, WiiM, ...) drop out once idle, and the Web API can't
    // see or wake them. So remember every device Spotify has reported (in spotify-devices.json) and
    // keep offering it: whether a transfer to one that's dropped out works depends on the device.
    // Keyed by type + name, since some devices get a new id each session; the newest id wins.
    // Forgotten after FORGET_DEVICE_AFTER_MS unseen; delete the file to forget them all at once.

    const FORGET_DEVICE_AFTER_MS = 90 * 24 * 3600e3;
    const deviceKey = (d) => `${d.type}|${d.name}`.toLowerCase();
    const known = new Map((readJson(DEVICES_PATH) || []).map((d) => [deviceKey(d), d])); // key -> { id, name, type, last_seen }
    let knownSavedAt = 0;

    function rememberDevices(list) {
        const now = Date.now();
        let changed = false;
        for (const d of list) {
            if (!d.id || !d.name) continue;
            const key = deviceKey(d);
            const prev = known.get(key);
            if (!prev) console.log(`spotify: remembering device "${d.name}" (${d.type})`);
            if (!prev || prev.id !== d.id) changed = true;
            known.set(key, { id: d.id, name: d.name, type: d.type, last_seen: now });
        }
        for (const [key, d] of known) {
            if (now - d.last_seen > FORGET_DEVICE_AFTER_MS) {
                console.log(`spotify: forgetting device "${d.name}" (unseen for 90 days)`);
                known.delete(key);
                changed = true;
            }
        }
        // last_seen alone changes on every poll; that only needs to reach the disk now and then.
        if (changed || now - knownSavedAt > 3600e3) {
            knownSavedAt = now;
            writeJsonAtomic(DEVICES_PATH, [...known.values()]);
        }
    }

    // Every device Spotify has reported: the ones it lists now (with online: true and Spotify's
    // live fields), then remembered ones it doesn't (online: false), by name.
    async function allDevices(maxAgeMs) {
        const online = await devices(maxAgeMs);
        const listed = new Set(online.map(deviceKey));
        const asleep = [...known.values()]
            .filter((d) => !listed.has(deviceKey(d)))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) => ({ id: d.id, name: d.name, type: d.type, is_active: false, online: false }));
        return [...online.map((d) => ({ ...d, online: true })), ...asleep];
    }

    // Playlist tiles look playlists up by name, which means paging through all of them (up to 20
    // requests). Names rarely change, so keep the list for a while.
    const PLAYLISTS_MAX_AGE_MS = 10 * 60000;
    const PLAYLISTS_MIN_REFRESH_MS = 30000;
    let playlistsCache = { at: 0, value: [], pending: null };

    async function loadAllPlaylists() {
        const all = [];
        for (let offset = 0; offset < 1000; offset += 50) {
            const page = (await api("GET", `/me/playlists?limit=50&offset=${offset}`)) || {};
            all.push(...(page.items || []).filter(Boolean));
            if (!page.next) break;
        }
        return all;
    }

    // Spotify's player calls fail with 404 "no active device" when nothing is playing anywhere;
    // fall back to the most recently used device so the panel can start playback.
    let lastDeviceId = null;
    let unmuteLevel = null; // volume to restore on unmute (see mute())

    async function targetDevice() {
        const p = await player();
        if (p && p.device && p.device.id) return p.device.id;
        const devs = await devices(0);
        const pick = devs.find((d) => d.id === lastDeviceId) || devs.find((d) => d.is_active) || devs[0];
        if (!pick) throw new Error("No Spotify devices online. Open Spotify on a device first.");
        return pick.id;
    }

    async function withDevice(fn) {
        const id = await targetDevice();
        await fn(`device_id=${encodeURIComponent(id)}`);
        invalidate();
    }

    return {
        redirectUri,
        configured,
        authorized,
        player,
        devices,
        allDevices,
        invalidate,

        // ---- auth ----
        loginUrl() {
            const verifier = crypto.randomBytes(48).toString("base64url");
            const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
            const state = crypto.randomBytes(12).toString("hex");
            pendingAuth = { state, verifier };
            const q = new URLSearchParams({
                client_id: clientId(),
                response_type: "code",
                redirect_uri: redirectUri,
                code_challenge_method: "S256",
                code_challenge: challenge,
                scope: SCOPES,
                state,
            });
            return `https://accounts.spotify.com/authorize?${q}`;
        },
        async finishLogin(code, state) {
            if (!pendingAuth || state !== pendingAuth.state) throw new Error("login expired; start again");
            const t = await tokenRequest({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: clientId(),
                code_verifier: pendingAuth.verifier,
            });
            pendingAuth = null;
            token = {
                refresh_token: t.refresh_token,
                access_token: t.access_token,
                expires_at: Date.now() + t.expires_in * 1000,
            };
            saveToken();
        },

        // ---- playback ----
        async control(action) {
            const p = await player(0);
            const playing = !!(p && p.is_playing);
            if (action === "playpause") action = playing ? "pause" : "play";
            if (action === "stop") action = "pause";
            await withDevice(async (dev) => {
                if (action === "play") await api("PUT", `/me/player/play?${dev}`);
                else if (action === "pause") await api("PUT", `/me/player/pause?${dev}`);
                else if (action === "next") await api("POST", `/me/player/next?${dev}`);
                else if (action === "previous") await api("POST", `/me/player/previous?${dev}`);
                else throw new Error(`bad action ${action}`);
            });
        },
        async seek(seconds) {
            await withDevice((dev) => api("PUT", `/me/player/seek?position_ms=${Math.round(seconds * 1000)}&${dev}`));
        },
        async volume(mode, value) {
            const p = await player(0);
            const cur = p && p.device ? p.device.volume_percent : null;
            let v = mode === "absolute" ? value : (cur === null ? 50 : cur) + value * 4; // a "step" is 4%
            v = Math.max(0, Math.min(100, Math.round(v)));
            await withDevice((dev) => api("PUT", `/me/player/volume?volume_percent=${v}&${dev}`));
        },
        // Spotify has no mute; emulate it with volume 0 and remember the level to restore.
        async mute(how) {
            const p = await player(0);
            const cur = p && p.device ? p.device.volume_percent : null;
            const muted = cur === 0;
            if (how !== "mute" && how !== "unmute") how = muted ? "unmute" : "mute";
            if (how === "mute") {
                if (cur) unmuteLevel = cur;
                await withDevice((dev) => api("PUT", `/me/player/volume?volume_percent=0&${dev}`));
            } else {
                const level = unmuteLevel || 40;
                await withDevice((dev) => api("PUT", `/me/player/volume?volume_percent=${level}&${dev}`));
            }
            return how === "mute";
        },
        async setShuffle(on) {
            await withDevice((dev) => api("PUT", `/me/player/shuffle?state=${on ? "true" : "false"}&${dev}`));
        },
        async setRepeat(state) {
            await withDevice((dev) => api("PUT", `/me/player/repeat?state=${state}&${dev}`));
        },
        async transfer(deviceId) {
            const p = await player(0);
            try {
                await api("PUT", "/me/player", { device_ids: [deviceId], play: !!(p && p.is_playing) });
            } catch (e) {
                // Typically a remembered device that has since dropped off Spotify's list.
                if (e.status !== 404) throw e;
                const d = [...known.values()].find((k) => k.id === deviceId);
                const name = d ? d.name : "That device";
                throw Object.assign(new Error(`${name} isn't reachable. Play to it once from the Spotify app.`), { status: 404 });
            }
            lastDeviceId = deviceId;
            invalidate();
        },
        // body: { context_uri } or { uris, offset }
        async play(body) {
            await withDevice((dev) => api("PUT", `/me/player/play?${dev}`, body));
        },

        // ---- library (read-only) ----
        async playlists(offset = 0) {
            return api("GET", `/me/playlists?limit=50&offset=${offset}`);
        },
        async likedTracks(offset = 0) {
            return api("GET", `/me/tracks?limit=50&offset=${offset}`);
        },
        async savedAlbums(offset = 0) {
            return api("GET", `/me/albums?limit=50&offset=${offset}`);
        },
        async recentlyPlayed() {
            return api("GET", `/me/player/recently-played?limit=50`);
        },
        // For deck tiles, by exact (case-insensitive) name. Uses the cached playlist list; a name
        // missing from it triggers one re-read, in case the playlist is new or was renamed.
        async findPlaylist(title) {
            const want = String(title).toLowerCase();
            const match = (list) => list.find((p) => (p.name || "").toLowerCase() === want) || null;
            const hit = match(await cached(playlistsCache, PLAYLISTS_MAX_AGE_MS, loadAllPlaylists));
            // ...but not on every press of a tile whose playlist really is gone.
            if (hit || Date.now() - playlistsCache.at < PLAYLISTS_MIN_REFRESH_MS) return hit;
            return match(await cached(playlistsCache, 0, loadAllPlaylists));
        },
    };
}

module.exports = { createSpotify };
