const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function makeId(prefix = "m")
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
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function normalizeMachine(m)
{
    // Note: machines can target either a physical MIDI output (legacy `out`)
    // or an abstract MIDI port slot (`outSlot`) defined in midiports.json.
    return {
        id: String(m.id || makeId()),
        name: String(m.name || "Machine"),
        midnamFile: m.midnamFile == null ? null : String(m.midnamFile), // MIDNAM filename or null
        // Legacy: physical port name. Kept for backward compatibility.
        out: m.out == null ? null : String(m.out),
        // Preferred: slot id (1..256). Stored as a number, or null.
        outSlot: (() =>
        {
            const v = (m && m.outSlot != null) ? parseInt(String(m.outSlot), 10) : NaN;
            return Number.isFinite(v) ? Math.min(256, Math.max(1, v)) : null;
        })(),
        channel: Number.isFinite(m.channel) ? Math.min(16, Math.max(1, m.channel)) : 1
    };
}


class MachinesStore
{
    constructor(options = {})
    {
        this.filePath = options.filePath || path.join(process.cwd(), "data", "machines.json");
        this.data = { machines: [], activeId: null };
        this.load();
        if (!this.data.machines.length)
        {
            const d = normalizeMachine({ id: "default", name: "Machine", midnamFile: null, out: null, channel: 1 });
            this.data.machines.push(d);
            this.data.activeId = d.id;
            this.save();
        }
        if (!this.getActive())
        {
            this.data.activeId = this.data.machines[0].id;
            this.save();
        }
    }

    load()
    {
        this.data = safeReadJson(this.filePath, { machines: [], activeId: null });
        if (!Array.isArray(this.data.machines)) this.data.machines = [];
        this.data.machines = this.data.machines.map(normalizeMachine);
    }

    save()
    {
        safeWriteJson(this.filePath, this.data);
    }

    list()
    {
        return [...this.data.machines];
    }

    getById(id)
    {
        return this.data.machines.find(m => m.id === id) || null;
    }

    getActive()
    {
        return this.getById(this.data.activeId) || null;
    }

    setActive(id)
    {
        if (!this.getById(id)) return false;
        this.data.activeId = id;
        this.save();
        return true;
    }

    add(machine)
    {
        const m = normalizeMachine(machine);
        this.data.machines.push(m);
        if (!this.data.activeId) this.data.activeId = m.id;
        this.save();
        return m;
    }

    update(id, patch)
    {
        const idx = this.data.machines.findIndex(m => m.id === id);
        if (idx < 0) return null;

        const m0 = this.data.machines[idx];
        const m1 = normalizeMachine({ ...m0, ...patch, id: m0.id });
        this.data.machines[idx] = m1;
        this.save();
        return m1;
    }

    remove(id)
    {
        const idx = this.data.machines.findIndex(m => m.id === id);
        if (idx < 0) return false;

        const wasActive = (this.data.activeId === id);
        this.data.machines.splice(idx, 1);

        if (!this.data.machines.length)
        {
            const d = normalizeMachine({ id: "default", name: "Machine", out: null, channel: 1 });
            this.data.machines.push(d);
            this.data.activeId = d.id;
        }
        else if (wasActive)
        {
            this.data.activeId = this.data.machines[0].id;
        }

        this.save();
        return true;
    }
}

module.exports = { MachinesStore };
