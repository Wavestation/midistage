// settings.js

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const DEFAULT_SETTINGS_PATH = path.join(__dirname, "..", "..", "data", "settings.json");
const DEFAULT_SETTINGS = { ui: { autorecallOnScroll: false }, remote: {vfdBrightness: 3 } };

class Settings extends EventEmitter
{
    settings = null;
    SETTINGS_PATH = DEFAULT_SETTINGS_PATH;

    constructor(settings_path)
    {
        super();
        this.SETTINGS_PATH = settings_path || DEFAULT_SETTINGS_PATH;
        this.settings = this.loadSettings();

        console.log("[SETTINGS] Class inited with path: " + settings_path + " \napplied " + this.SETTINGS_PATH);
        console.log("Settings contents: " + JSON.stringify(this.settings));
    }

    deepMerge(dst, src)
    {
        if (!src || typeof src !== "object") return dst;
        for (const k of Object.keys(src))
        {
            const v = src[k];
            if (v && typeof v === "object" && !Array.isArray(v))
            {
            if (!dst[k] || typeof dst[k] !== "object") dst[k] = {};
            this.deepMerge(dst[k], v);
            }
            else dst[k] = v;
        }
        return dst;
    }

    atomicWriteJson(filePath, obj)
    {
        const dir = path.dirname(filePath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, filePath);
    }

    loadSettings()
    {
        try
        {
            if (!fs.existsSync(this.SETTINGS_PATH))
            {
                console.warn("[LOADSETTINGS] Path doesn't exists, goto fb:\n" + this.SETTINGS_PATH);
                this.atomicWriteJson(this.SETTINGS_PATH, DEFAULT_SETTINGS);
                return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            }

            const raw = JSON.parse(fs.readFileSync(this.SETTINGS_PATH, "utf8"));
            const s = this.deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), raw);
            try { this.atomicWriteJson(this.SETTINGS_PATH, s); } catch { }
            return s;
        }
        catch(er)
        {
            console.warn("[LOADSETTINGS] ERROR: " + er);
            return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
    }

    getSetting(pathStr, fallback)
    {
        try
        {
            const parts = String(pathStr || "").split(".").filter(Boolean);
            let cur = this.settings;
            for (const p of parts) cur = cur[p];
            return (cur === undefined) ? fallback : cur;
        }
        catch(er) { console.warn("[GETSETTING] ERROR: " + er); return fallback; }
    }

    setSetting(pathStr, value)
    {
        const parts = String(pathStr || "").split(".").filter(Boolean);
        if (!parts.length) return;

        let cur = this.settings;
        for (let i = 0; i < parts.length - 1; i++)
        {
            const p = parts[i];
            if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
            cur = cur[p];
        }
        cur[parts[parts.length - 1]] = value;

        try { atomicWriteJson(this.SETTINGS_PATH , this.settings); } catch(er) { console.warn("[SETSETTING] ERROR: " + er); }
    }

}

module.exports = { Settings };