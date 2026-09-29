// Optional overrides - edit as needed, or set the matching environment variable.
module.exports = {
    // HTTP port the ESP32 firmware talks to (enter this in the WiFiManager setup portal).
    PORT: process.env.PORT || 8080,

    // If set, always show this zone's now-playing (exact Roon zone display name).
    // If left empty, the bridge auto-picks the first zone that is currently playing,
    // falling back to the first known zone.
    ZONE_NAME: process.env.ZONE_NAME || "",

    // Square art size in pixels - must match ART_PX in the firmware's ui.h.
    ART_PX: 300,
};
