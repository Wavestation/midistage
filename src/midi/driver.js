"use strict";

const MOCK = process.env.MIDI_MOCK === "1";

let midi;
function requireMidi() {
  if (midi) return midi;
  try {
    midi = require("midi");
    return midi;
  } catch (e) {
    throw new Error(
      "Module 'midi' introuvable. Fais: npm i midi (et sur Linux: libasound2-dev)."
    );
  }
}

// Cache des outputs ouverts par nom (un par port)
const outCache = new Map();

function listOutputs() {
  if (MOCK) {
    return ["[MOCK] Virtual Output 1", "[MOCK] Virtual Output 2"];
  }

  const midiLib = requireMidi();
  const output = new midiLib.Output();

  const n = output.getPortCount();
  const ports = [];
  for (let i = 0; i < n; i++) {
    ports.push(output.getPortName(i));
  }

  // On ne garde pas cet objet (évite fuite). RtMidi tolère.
  try { output.closePort(); } catch {}
  return ports;
}

function findPortIndexByName(name) {
  const midiLib = requireMidi();
  const output = new midiLib.Output();
  const n = output.getPortCount();

  for (let i = 0; i < n; i++) {
    const pn = output.getPortName(i);
    if (pn === name) {
      try { output.closePort(); } catch {}
      return i;
    }
  }

  try { output.closePort(); } catch {}
  return -1;
}

function getOrOpenOutputByName(name) {
  if (outCache.has(name)) return outCache.get(name);

  const idx = findPortIndexByName(name);
  if (idx < 0) {
    const ports = listOutputs();
    throw new Error(
      `Port MIDI introuvable: "${name}". Ports dispo:\n- ${ports.join("\n- ")}`
    );
  }

  const midiLib = requireMidi();
  const out = new midiLib.Output();

  // Important: évite d’envoyer l’“active sensing” / timing si tu en ajoutes plus tard
  try { out.ignoreTypes(false, false, false); } catch {}

  out.openPort(idx);
  outCache.set(name, out);
  return out;
}

function closeAll() {
  for (const [name, out] of outCache.entries()) {
    try { out.closePort(); } catch {}
    outCache.delete(name);
  }
}

// Envoie Bank Select + Program Change
function sendPatch(machine, bank, patch) {
  const msb = bank?.msb ?? null;
  const lsb = bank?.lsb ?? null;

  if (patch?.program == null) {
    throw new Error(`Patch invalide: program absent. Patch=${JSON.stringify(patch)}`);
  }

  const ch = Math.max(1, Math.min(16, Number(machine?.channel || 1))) - 1;

  const msg =
    `${machine?.name || "Machine"} ch=${ch + 1} -> ` +
    `MSB=${msb ?? "-"} LSB=${lsb ?? "-"} PC=${patch.program} "${patch?.name || ""}"`;

  if (MOCK) return `[MOCK MIDI] ${msg}`;

  const outName = machine?.out;
  if (!outName) {
    throw new Error(`Machine "${machine?.name || machine?.id}" n'a pas de sortie MIDI (out=null). Assigne un port.`);
  }

  const out = getOrOpenOutputByName(outName);

  // Helpers
  const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));

  // Bank Select (CC0 / CC32) si présents
  if (msb != null) out.sendMessage([0xB0 | ch, 0, clamp7(msb)]);
  if (lsb != null) out.sendMessage([0xB0 | ch, 32, clamp7(lsb)]);

  // Program Change (0..127). Attention: certains humains pensent en 1..128.
  out.sendMessage([0xC0 | ch, clamp7(patch.program)]);

  return msg;
}

process.on("exit", closeAll);
process.on("SIGINT", () => { closeAll(); process.exit(0); });
process.on("SIGTERM", () => { closeAll(); process.exit(0); });

module.exports = {
  listOutputs,
  sendPatch,
  closeAll
};
