// Roon Now Playing bridge: serves an ESP32-S3 touch panel (now playing, remote, library, tiles)
// from a Roon Core and Spotify. See README.md.
//
// This file only wires things together:
//   lib/      roon (pairing + zones), spotify (Web API client), targets (Roon/Spotify behind one
//             interface), art, http/middleware/text
//   routes/   one module per screen or feature, each exporting mount(app, deps)

const express = require("express");
const config = require("./config");
const { createRoon } = require("./lib/roon");
const { createSpotify } = require("./lib/spotify");
const { createTargets } = require("./lib/targets");
const { createArt } = require("./lib/art");
const { requestLog, requestGuard } = require("./lib/middleware");

// A bug in one request must not take the whole bridge down - Now Playing would go "Bridge
// unreachable" until someone logged in again. Log it and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", (e && e.stack) || e));

const roon = createRoon({ zoneName: config.ZONE_NAME });
const sp = createSpotify({ port: config.PORT });
const targets = createTargets({ roon, sp });

const app = express();
app.use(requestLog);
app.use(requestGuard);

require("./routes/nowplaying").mount(app, { config, roon, art: createArt({ getImageService: roon.image }) });
require("./routes/remote").mount(app, { roon, sp, targets });
require("./routes/library").mount(app, { roon, sp, targets });
require("./routes/deck").mount(app, { roon, sp, targets });
require("./routes/spotify-auth").mount(app, { sp });

roon.start();

// During a restart the previous instance can still hold the port for a second or two while it
// exits (see EXIT_WITH_PARENT below). Wait for it rather than crashing straight into the
// supervisor's restart loop.
const LISTEN_RETRIES = 20;
function listen(attempt = 1) {
    const server = app.listen(config.PORT, () => {
        console.log(`roon-now-playing-bridge listening on http://0.0.0.0:${config.PORT}`);
        console.log("Approve this extension in Roon under Settings > Extensions once it appears.");
    });
    server.on("error", (e) => {
        if (e.code === "EADDRINUSE" && attempt < LISTEN_RETRIES) {
            if (attempt === 1) console.log(`port ${config.PORT} in use (previous instance still exiting?); retrying for ${LISTEN_RETRIES}s`);
            setTimeout(() => listen(attempt + 1), 1000);
            return;
        }
        console.error(`cannot listen on port ${config.PORT}:`, e.message);
        process.exit(1);
    });
}
listen();

// run-bridge.cmd sets EXIT_WITH_PARENT. Stopping the scheduled task ends that cmd.exe but not this
// process, which then kept serving the old code on PORT, running in session 0 where only an
// elevated shell could kill it. Instead, notice the supervisor is gone and shut down cleanly.
if (process.env.EXIT_WITH_PARENT) {
    const parent = process.ppid;
    const watchdog = setInterval(() => {
        try {
            process.kill(parent, 0); // signal 0: existence check only
        } catch (e) {
            if (e.code !== "ESRCH") return; // e.g. EPERM: it exists, we just can't signal it
            clearInterval(watchdog);
            console.log(`supervisor (pid ${parent}) has exited; shutting down`);
            process.exit(0);
        }
    }, 2000);
}
