// Spotify account linking — one-time, from a browser on the bridge machine (setup steps are at the
// top of lib/spotify.js). Spotify only allows plain-http redirects to a loopback IP, so the login
// refuses any other client.

const { toDisplayText, escapeHtml } = require("../lib/text");

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Anything from the request that lands in a page must go through escapeHtml.
const page = (title, body) =>
    `<!doctype html><meta charset=utf-8><title>${title}</title>` +
    `<body style="font-family:system-ui;max-width:560px;margin:40px auto;line-height:1.5"><h2>${title}</h2>${body}</body>`;

function mount(app, { sp }) {
    app.get("/spotify/status", (req, res) => {
        res.json({ configured: sp.configured(), linked: sp.authorized(), redirect_uri: sp.redirectUri });
    });

    app.get("/spotify/login", (req, res) => {
        if (!LOOPBACK.has(req.ip)) {
            return res.status(403).send(page("Open this on the bridge machine",
                `<p>Spotify only accepts this login from the machine running the bridge. Open
                 <code>http://127.0.0.1:${req.socket.localPort}/spotify/login</code> there.</p>`));
        }
        if (!sp.configured()) {
            return res.status(400).send(page("Spotify client ID missing",
                `<p>Create <code>spotify.json</code> next to <code>server.js</code> containing
                 <code>{ "client_id": "..." }</code>, then reload this page.</p>`));
        }
        res.redirect(sp.loginUrl());
    });

    app.get("/spotify/callback", async (req, res) => {
        if (req.query.error) return res.status(400).send(page("Spotify login cancelled", `<p>${escapeHtml(toDisplayText(req.query.error))}</p>`));
        try {
            await sp.finishLogin(String(req.query.code || ""), String(req.query.state || ""));
            res.send(page("Spotify linked", "<p>The deck can now control Spotify. You can close this tab.</p>"));
        } catch (e) {
            res.status(400).send(page("Spotify login failed", `<p>${escapeHtml(toDisplayText(e.message))}</p>`));
        }
    });
}

module.exports = { mount };
