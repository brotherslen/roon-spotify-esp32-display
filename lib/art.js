// Cover art as the panels draw it: raw RGB565, size x size, little-endian. Keys starting "sp:" are
// Spotify cover ids (see spotifyArtKey in lib/targets.js); anything else is a Roon image key.

const sharp = require("sharp");

const MAX_ART_CACHE = 16;
const ROON_IMAGE_TIMEOUT_MS = 10000;

function rgb888ToRgb565(rgbBuf) {
    const out = Buffer.alloc((rgbBuf.length / 3) * 2);
    let p = 0;
    for (let i = 0; i < rgbBuf.length; i += 3) {
        const r = rgbBuf[i], g = rgbBuf[i + 1], b = rgbBuf[i + 2];
        const val = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        out.writeUInt16LE(val, p);
        p += 2;
    }
    return out;
}

// Any image buffer (JPEG/PNG/SVG — sharp rasterizes SVG too) -> raw RGB565, width x height.
async function imageBufferToRgb565(imageBuf, width, height = width) {
    const rgbBuf = await sharp(imageBuf).resize(width, height, { fit: "cover" }).removeAlpha().raw().toBuffer();
    return rgb888ToRgb565(rgbBuf);
}

async function getSpotifyArt(id, size) {
    if (!/^[0-9a-f]{16,64}$/i.test(id)) throw new Error("bad spotify image id");
    const res = await fetch(`https://i.scdn.co/image/${id}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`spotify image: ${res.status}`);
    return imageBufferToRgb565(Buffer.from(await res.arrayBuffer()), size);
}

// getImageService: () => Roon's RoonApiImage, or undefined while unpaired.
function createArt({ getImageService }) {
    // "image_key@size" -> Promise<Buffer>. Caching the promise rather than the buffer means the bar
    // display and the deck asking for the same cover at once share one fetch and one resize.
    // Least-recently-used first: a hit moves its entry to the end, so the art on screen, which
    // gets re-requested, isn't the one evicted.
    const cache = new Map();

    function getRoonArt(imageKey, size) {
        return new Promise((resolve, reject) => {
            const imageSvc = getImageService();
            if (!imageSvc) return reject(new Error("no core"));
            // Roon never answers a request for an unknown image key, which would leave the panel
            // waiting forever and (since promises are cached) every later request for that key too.
            const timer = setTimeout(() => reject(new Error("roon image timeout")), ROON_IMAGE_TIMEOUT_MS);
            const settle = (fn) => (value) => {
                clearTimeout(timer);
                fn(value);
            };
            resolve = settle(resolve);
            reject = settle(reject);

            imageSvc.get_image(
                imageKey,
                { scale: "fit", width: size, height: size, format: "image/jpeg" },
                (err, content_type, image) => {
                    if (err || !image) return reject(err || new Error("no image"));
                    imageBufferToRgb565(image, size).then(resolve, reject);
                }
            );
        });
    }

    function getArt(imageKey, size) {
        const cacheKey = `${imageKey}@${size}`;
        let art = cache.get(cacheKey);
        if (art) {
            cache.delete(cacheKey);
            cache.set(cacheKey, art);
            return art;
        }
        art = imageKey.startsWith("sp:") ? getSpotifyArt(imageKey.slice(3), size) : getRoonArt(imageKey, size);
        if (cache.size >= MAX_ART_CACHE) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, art);
        // Don't keep failures: the next request should try again (e.g. once Roon has re-paired).
        art.catch(() => {
            if (cache.get(cacheKey) === art) cache.delete(cacheKey);
        });
        return art;
    }

    return { getArt };
}

module.exports = { createArt };
