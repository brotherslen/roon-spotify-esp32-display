// Route wrappers shared by every JSON endpoint. Express 4 doesn't catch a rejected async handler
// (the request just hangs until the device times out), so all async routes go through one of these.
//
// Status codes: httpError() sets ours (httpStatus) and it is sent as is. A Spotify API error
// carries Spotify's own `status`: 4xx passes through (e.g. 404 "no active device"), but 5xx
// becomes 502, since the failure is upstream. Anything else is 502 too — it almost always means
// Roon failed underneath us. The body is {"ok":false,"error"}, folded to ASCII for the panels.

const { toDisplayText } = require("./text");

const httpError = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });

function sendError(res, e) {
    if (res.headersSent) return;
    const status = e.httpStatus || (e.status && e.status < 500 ? e.status : 502);
    res.status(status).json({ ok: false, error: toDisplayText(e.message) });
}

// Actions: the handler's return value (if any) is merged into {"ok":true}.
const action = (fn) => async (req, res) => {
    try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json({ ok: true, ...(out || {}) });
    } catch (e) {
        sendError(res, e);
    }
};

// Reads: the handler's return value is the whole response body.
const read = (fn) => async (req, res) => {
    try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out);
    } catch (e) {
        sendError(res, e);
    }
};

module.exports = { httpError, action, read };
