"use strict";

const fs = require("fs");
const path = require("path");

// Simple 1..N slot abstraction over physical MIDI output names.
// Stored in data/midiports.json by default.

function safeReadJson(file)
{
  try
  {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  }
  catch { return null; }
}

function safeWriteJson(file, obj)
{
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function pad3(n)
{
  return String(n).padStart(3, "0");
}

class MidiPortsStore
{
  constructor(opts)
  {
    opts = opts || {};
    this.path = opts.path || "data/midiports.json";
    this.slotsCount = Number.isFinite(opts.slotsCount) ? opts.slotsCount : 256;

    this._slots = []; // [{slot:number, label:string|null, port:string|null}]
    this.load();
  }

  // Ensure file exists and structure is valid
  load()
  {
    const fs = require("fs");

    let raw = null;
    try { raw = fs.readFileSync(this.path, "utf8"); } catch { raw = null; }

    let data = null;
    if (raw)
    {
      try { data = JSON.parse(raw); } catch { data = null; }
    }

    const slots = Array.isArray(data?.slots) ? data.slots : [];

    const norm = [];
    for (let i = 1; i <= this.slotsCount; i++)
    {
      const s = slots.find(x => Number(x.slot) === i) || { slot: i };
      const label = (s.label == null) ? null : String(s.label);
      const port = (s.port == null) ? null : String(s.port);
      norm.push({ slot: i, label, port });
    }

    this._slots = norm;

    // If file was missing or malformed, rewrite it.
    if (!raw || !data || !Array.isArray(data.slots))
    {
      try { this.save(); } catch { }
    }
  }

  save()
  {
    const fs = require("fs");
    const path = require("path");

    // ensure dir exists
    const dir = path.dirname(this.path);
    if (dir && dir !== "." && !fs.existsSync(dir))
    {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = {
      version: 1,
      slotsCount: this.slotsCount,
      slots: this._slots.map(s => ({
        slot: s.slot,
        label: s.label || null,
        port: s.port || null
      }))
    };

    fs.writeFileSync(this.path, JSON.stringify(payload, null, 2), "utf8");
  }

  listSlots()
  {
    return this._slots.slice();
  }

  getSlot(slot)
  {
    const n = Number(slot);
    if (!Number.isFinite(n)) return null;
    return this._slots.find(s => s.slot === n) || null;
  }

  getPort(slot)
  {
    const s = this.getSlot(slot);
    return s ? (s.port || null) : null;
  }

  setPort(slot, portName)
  {
    const s = this.getSlot(slot);
    if (!s) return false;

    const v = portName ? String(portName) : null;
    s.port = v;
    this.save();
    return true;
  }

  setLabel(slot, label)
  {
    const s = this.getSlot(slot);
    if (!s) return false;

    const v = String(label || "").trim();
    s.label = v ? v : null;
    this.save();
    return true;
  }

  slotToLabel(slot)
  {
    const s = this.getSlot(slot);
    const n = Number(slot);
    const num = String(Number.isFinite(n) ? n : 0).padStart(3, "0");
    if (!s) return `Slot ${num}`;
    return s.label ? s.label : `Slot ${num}`;
  }
}

module.exports = { MidiPortsStore };
