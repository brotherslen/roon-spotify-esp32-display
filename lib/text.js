// The firmware's Montserrat fonts only cover printable ASCII; anything else draws as a box.
// Roon metadata is full of typographic punctuation (U+2010 hyphens, curly quotes) and accented
// names, so fold those to their ASCII look-alikes here rather than shipping bigger fonts.
const ASCII_LOOKALIKES = [
    [/[\u2010-\u2015\u2212]/g, "-"],
    [/[\u2018\u2019\u201A\u2032]/g, "'"],
    [/[\u201C\u201D\u201E\u2033]/g, '"'],
    [/\u2026/g, "..."],
    [/[\u00A0\u2000-\u200A\u202F]/g, " "],
    [/\u00DF/g, "ss"], [/\u00E6/g, "ae"], [/\u00C6/g, "AE"], [/\u0153/g, "oe"], [/\u0152/g, "OE"],
    [/\u00F8/g, "o"], [/\u00D8/g, "O"], [/\u0142/g, "l"], [/\u0141/g, "L"], [/\u0111/g, "d"], [/\u0110/g, "D"],
];
function toDisplayText(text) {
    let out = String(text || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); // strip accents
    for (const [pattern, replacement] of ASCII_LOOKALIKES) out = out.replace(pattern, replacement);
    return out.replace(/[^\x20-\x7E]/g, "?");
}

// For the few HTML pages the bridge serves. toDisplayText keeps < and >, so anything taken from a
// request must also go through this or it reflects markup (and script) back to the browser.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

module.exports = { toDisplayText, escapeHtml };
