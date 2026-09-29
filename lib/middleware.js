const os = require("os");

// The touch panel polls these about once a second; logging every successful poll would grow
// bridge.log by megabytes a day. Failures and slow responses are still logged.
const QUIET_POLLS = new Set(["/remote", "/deck", "/zones"]);

function requestLog(req, res, next) {
    const start = Date.now();
    if (req.method === "GET" && QUIET_POLLS.has(req.path)) {
        res.on("finish", () => {
            const ms = Date.now() - start;
            if (res.statusCode >= 400 || ms > 1000) console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} in ${ms}ms`);
        });
        return next();
    }
    console.log(`--> ${req.method} ${req.originalUrl} from ${req.ip}`);
    res.on("finish", () => console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} in ${Date.now() - start}ms`));
    res.on("close", () => {
        if (!res.writableEnded) console.log(`xx  ${req.method} ${req.originalUrl} client closed connection after ${Date.now() - start}ms`);
    });
    next();
}

// Nothing here is authenticated; the bridge trusts the LAN. These two checks stop a web page
// open in some browser on that LAN from using the bridge, without any change to the firmware:
//  - Host: a DNS-rebinding page reaches us under its own domain name, which would let it read
//    responses. The panels and a browser on this machine use an IP literal, localhost or this
//    machine's own name, so any other Host is refused.
//  - Origin: browsers attach it to cross-site POSTs (which they send without a preflight when
//    they carry no body, i.e. every control here). The ESP32 firmware never sends one.
const OWN_NAMES = new Set(["localhost", os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
function hostAllowed(hostHeader) {
    const host = String(hostHeader || "").toLowerCase().replace(/:\d+$/, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host) || OWN_NAMES.has(host);
}

function requestGuard(req, res, next) {
    if (!hostAllowed(req.headers.host)) {
        console.log(`refused ${req.method} ${req.originalUrl} from ${req.ip}: Host "${req.headers.host}"`);
        return res.status(421).end();
    }
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
        let sameOrigin = false;
        try {
            sameOrigin = new URL(origin).host === req.headers.host;
        } catch {}
        if (!sameOrigin) {
            console.log(`refused ${req.method} ${req.originalUrl} from ${req.ip}: Origin "${origin}"`);
            return res.status(403).end();
        }
    }
    next();
}

module.exports = { requestLog, requestGuard };
