// setlists.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function makeId(prefix = "s")
{
    return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function safeReadJson(filePath, fallback)
{
    try
    {
        if (!fs.existsSync(filePath)) return fallback;
        const txt = fs.readFileSync(filePath, "utf8");
        return JSON.parse(txt);
    }
    catch
    {
        return fallback;
    }
}

function safeWriteJson(filePath, obj)
{
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
}

function normalizeCCSlots(src)
{
    if (src == null) return null;

    let arr = [];

    if (Array.isArray(src))
    {
        arr = src.map((it) =>
        {
            if (it == null) return null;

            if (Array.isArray(it) && it.length >= 2)
            {
                const cc = Number(it[0]);
                const value = Number(it[1]);
                if (!Number.isFinite(cc) || !Number.isFinite(value)) return null;
                return { cc: Math.max(0, Math.min(127, cc|0)), value: Math.max(0, Math.min(127, value|0)) };
            }

            if (typeof it === "object")
            {
                const cc = Number(it.cc);
                const value = Number(it.value);
                if (!Number.isFinite(cc) || !Number.isFinite(value)) return null;
                return { cc: Math.max(0, Math.min(127, cc|0)), value: Math.max(0, Math.min(127, value|0)) };
            }

            return null;
        }).filter(Boolean);
    }
    else if (typeof src === "object")
    {
        for (const k of Object.keys(src))
        {
            const cc = Number(k);
            const value = Number(src[k]);
            if (!Number.isFinite(cc) || !Number.isFinite(value)) continue;
            arr.push({ cc: Math.max(0, Math.min(127, cc|0)), value: Math.max(0, Math.min(127, value|0)) });
        }
    }

    return arr.slice(0, 4);
}

function normalizeRoute(r)
{
    return {
        machineId: r && r.machineId ? String(r.machineId) : null,
        midnamFile: r && r.midnamFile ? String(r.midnamFile) : null,
        deviceName: r && r.deviceName ? String(r.deviceName) : null,
        bankName: r && r.bankName ? String(r.bankName) : null,
        msb: (r && r.msb != null) ? Number(r.msb) : null,
        lsb: (r && r.lsb != null) ? Number(r.lsb) : null,
        program: (r && r.program != null) ? Number(r.program) : null,
        patchName: r && r.patchName ? String(r.patchName) : null,
        ccSlots: (r && (r.ccSlots != null || r.cc != null || r.ccs != null))
            ? normalizeCCSlots(r.ccSlots != null ? r.ccSlots : (r.cc != null ? r.cc : r.ccs))
            : null
    };
}

function normalizeEntry(e)
{
    return {
        id: String((e && e.id) || makeId("e")),
        name: String((e && e.name) || "Entry"),
        routes: Array.isArray(e && e.routes) ? e.routes.map(normalizeRoute) : []
    };
}

function normalizeSetlist(s)
{
    return {
        id: String((s && s.id) || makeId("sl")),
        name: String((s && s.name) || "Setlist"),
        entries: Array.isArray(s && s.entries) ? s.entries.map(normalizeEntry) : [],
        hotkeys: (s && typeof s.hotkeys === "object" && s.hotkeys) ? Object.assign({}, s.hotkeys) : {}
    };
}

function normalizeHotkey(k)
{
    if (!k) return null;
    const key = String(k).trim().toUpperCase();
    if (key.length !== 1) return null;
    const c = key.charCodeAt(0);
    if (c < 65 || c > 72) return null; // A..H
    return key;
}

class SetlistsStore
{
    constructor(options = {})
    {
        this.filePath = options.filePath || path.join(process.cwd(), "data", "setlists.json");
        this.data = { setlists: [], activeId: null };
        this.load();
    }

    load()
    {
        const raw = safeReadJson(this.filePath, { setlists: [], activeId: null });

        if (Array.isArray(raw.setlists))
        {
            raw.setlists = raw.setlists.map(normalizeSetlist);
        }
        else
        {
            raw.setlists = [];
        }

        this.data = {
            setlists: raw.setlists,
            activeId: raw.activeId || null
        };

        if (this.data.activeId && !this.getById(this.data.activeId))
        {
            this.data.activeId = this.data.setlists[0]?.id || null;
        }
    }

    save()
    {
        safeWriteJson(this.filePath, this.data);
    }

    list() { return [...this.data.setlists]; }
    getById(id) { return this.data.setlists.find(s => s.id === id) || null; }
    getActive() { return this.getById(this.data.activeId) || null; }

    setActive(id)
    {
        if (!this.getById(id)) return false;
        this.data.activeId = id;
        this.save();
        return true;
    }

    ensureDefaultSetlist(name = "Default")
    {
        let s = this.getActive();
        if (s) return s;

        s = normalizeSetlist({ name });
        this.data.setlists.push(s);
        this.data.activeId = s.id;
        this.save();
        return s;
    }

    addSetlist(name)
    {
        const s = normalizeSetlist({ name });
        this.data.setlists.push(s);
        if (!this.data.activeId) this.data.activeId = s.id;
        this.save();
        return s;
    }

    removeSetlist(id)
    {
        const idx = this.data.setlists.findIndex(s => s.id === id);
        if (idx < 0) return false;

        const wasActive = this.data.activeId === id;
        this.data.setlists.splice(idx, 1);

        if (wasActive)
        {
            this.data.activeId = this.data.setlists[0]?.id || null;
        }

        this.save();
        return true;
    }

    renameSetlist(id, name)
    {
        const s = this.getById(id);
        if (!s) return false;

        const n = String(name || "").trim();
        if (!n) return false;

        s.name = n;
        this.save();
        return true;
    }

    // ----- Entries -----

    listEntries(setlistId)
    {
        const s = this.getById(setlistId);
        return s ? [...s.entries] : [];
    }

    getEntry(setlistId, entryId)
    {
        const s = this.getById(setlistId);
        return s ? s.entries.find(e => e.id === entryId) || null : null;
    }

    addEntry(setlistId, name, routes = [])
    {
        const s = this.getById(setlistId);
        if (!s) return null;

        const e = normalizeEntry({ name, routes });
        s.entries.push(e);
        this.save();
        return e;
    }

    removeEntry(setlistId, entryId)
    {
        const s = this.getById(setlistId);
        if (!s) return false;

        const idx = s.entries.findIndex(e => e.id === entryId);
        if (idx < 0) return false;

        s.entries.splice(idx, 1);

        // nettoyage hotkeys
        for (const k of Object.keys(s.hotkeys))
        {
            if (s.hotkeys[k] === entryId) delete s.hotkeys[k];
        }

        this.save();
        return true;
    }

    renameEntry(setlistId, entryId, name)
    {
        const e = this.getEntry(setlistId, entryId);
        if (!e) return false;

        e.name = String(name || "Entry");
        this.save();
        return true;
    }

    moveEntry(setlistId, entryId, delta)
    {
        const s = this.getById(setlistId);
        if (!s) return false;

        const idx = s.entries.findIndex(e => e.id === entryId);
        if (idx < 0) return false;

        const next = Math.max(0, Math.min(s.entries.length - 1, idx + delta));
        if (next === idx) return true;

        const [e] = s.entries.splice(idx, 1);
        s.entries.splice(next, 0, e);
        this.save();
        return true;
    }

    duplicateEntry(setlistId, entryId, newName)
    {
        const s = this.getById(setlistId);
        if (!s) return null;

        const src = s.entries.find(e => e.id === entryId);
        if (!src) return null;

        const copy = normalizeEntry({
        name: newName || (src.name + " (copy)"),
        routes: (src.routes || []).map(r => ({ ...r })) // shallow OK ici (valeurs primitives)
        });

        s.entries.push(copy);
        this.save();
        return copy;
    }
    
    // ----- Routes -----

    upsertRoute(setlistId, entryId, route)
    {
        const e = this.getEntry(setlistId, entryId);
        if (!e) return false;

        const r = normalizeRoute(route);
        if (!r.machineId) return false;

        const idx = e.routes.findIndex(x => x.machineId === r.machineId);
        if (idx >= 0)
        {
            // Preserve existing CC slots unless the new route explicitly provides them
            if (r.ccSlots == null && e.routes[idx] && e.routes[idx].ccSlots != null)
            {
                r.ccSlots = e.routes[idx].ccSlots;
            }

            e.routes[idx] = r;
        }
        else
        {
            e.routes.push(r);
        }

        this.save();
        return true;
    }

    removeRoute(setlistId, entryId, machineId)
    {
        const e = this.getEntry(setlistId, entryId);
        if (!e) return false;

        const idx = e.routes.findIndex(x => x.machineId === machineId);
        if (idx < 0) return false;

        e.routes.splice(idx, 1);
        this.save();
        return true;
    }
    // ----- HOTKEYS -----

    assignHotkey(setlistId, key, entryId) 
    {
        const s = this.getById(setlistId);
        if (!s) return false;
    
        const hk = normalizeHotkey(key);
        if (!hk) return false;
    
        if (!s.entries.find(e => e.id === entryId)) return false;
    
        // check if already assigned
        const alreadyAssigned = Object.entries(s.hotkeys).some(([k, id]) => id === entryId && k !== hk);
    
        if (alreadyAssigned) return false;
    
        s.hotkeys[hk] = entryId;
        this.save();
        return true;
    }
    

    removeHotkey(setlistId, key)
    {
        const s = this.getById(setlistId);
        if (!s) return false;

        const hk = normalizeHotkey(key);
        if (!hk) return false;

        if (!s.hotkeys[hk]) return false;

        delete s.hotkeys[hk];
        this.save();
        return true;
    }

    clearHotkeys(setlistId)
    {
        const s = this.getById(setlistId);
        if (!s) return false;

        s.hotkeys = {};
        this.save();
        return true;
    }

    getHotkeyForEntry(setlistId, entryId)
    {
        const s = this.getById(setlistId);
        if (!s) return null;

        for (const [k, v] of Object.entries(s.hotkeys))
        {
            if (v === entryId) return k;
        }
        return null;
    }

    listHotkeys(setlistId)
    {
        const s = this.getById(setlistId);
        return s ? Object.assign({}, s.hotkeys) : {};
    }
}

module.exports = { SetlistsStore };
