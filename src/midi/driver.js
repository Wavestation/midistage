"use strict";

const MOCK = process.env.MIDI_MOCK === "1";
const DEBUG_VPORT = process.env.MIDI_DEBUG_VPORT === "1";

let midi;

function normalizePortLabel(s) 
{
  // enlève le suffixe " 128:3" ou " 14:0"
  return String(s || "")
    .replace(/\s+\d+:\d+\s*$/, "")
    .trim();
}

function requireMidi() 
{
  if (midi) return midi;
  try 
  {
    midi = require("midi");

    // Si tu veux garder un port virtuel de debug, fais-le sur demande seulement.
    if (DEBUG_VPORT) 
    {
      const out = new midi.Output();
      // out.openVirtualPort("MIDISTAGE_TEST");
      // ne pas closePort ici sinon tu le tues; c'est juste un port de debug
    }

    return midi;
  } catch (e) {
    throw new Error(
      "Module 'midi' introuvable. Fais: npm i midi (et sur Linux: libasound2-dev)."
    );
  }
}

// Cache des outputs ouverts (clé normalisée)
const outCache = new Map();

function listOutputs() 
{
  if (MOCK) 
  {
    return ["[MOCK] Virtual Output 1", "[MOCK] Virtual Output 2"];
  }

  const midiLib = requireMidi();
  const output = new midiLib.Output();

  const n = output.getPortCount();
  const ports = [];
  for (let i = 0; i < n; i++) 
  {
    ports.push(output.getPortName(i));
  }

  try { output.closePort(); } catch {}
  return ports;
}

function findPortIndexByName(wantedName) 
{
  const midiLib = requireMidi();
  const output = new midiLib.Output();
  const n = output.getPortCount();

  const wantedNorm = normalizePortLabel(wantedName).toLowerCase();

  for (let i = 0; i < n; i++) 
  {
    const pn = output.getPortName(i);
    const pnNorm = normalizePortLabel(pn).toLowerCase();

    // Match robuste:
    // - égalité sur nom normalisé
    // - ou égalité complète (au cas où)
    if (pn === wantedName || pnNorm === wantedNorm) 
    {
      try { output.closePort(); } catch {}
      return i;
    }
  }

  try { output.closePort(); } catch {}
  return -1;
}

function getOrOpenOutputByName(name) 
{
  const cacheKey = normalizePortLabel(name).toLowerCase();
  if (outCache.has(cacheKey)) return outCache.get(cacheKey);

  const idx = findPortIndexByName(name);
  if (idx < 0) 
  {
    const ports = listOutputs();
    throw new Error(
      `Port MIDI introuvable: "${name}". Ports dispo:\n- ${ports.join("\n- ")}`
    );
  }

  const midiLib = requireMidi();
  const out = new midiLib.Output();

  try { out.ignoreTypes(false, false, false); } catch {}

  out.openPort(idx);
  outCache.set(cacheKey, out);
  return out;
}

function closeAll() 
{
  for (const [key, out] of outCache.entries()) 
  {
    try { out.closePort(); } catch {}
    outCache.delete(key);
  }
}

// Envoie Bank Select + Program Change
function sendPatch(machine, bank, patch) 
{
  const msb = bank?.msb ?? null;
  const lsb = bank?.lsb ?? null;

  if (patch?.program == null) 
  {
    throw new Error(`Patch invalide: program absent. Patch=${JSON.stringify(patch)}`);
  }

  const ch = Math.max(1, Math.min(16, Number(machine?.channel || 1))) - 1;

  const msg =
    `${machine?.name || "Machine"} ch=${ch + 1} -> ` +
    `MSB=${msb ?? "-"} LSB=${lsb ?? "-"} PC=${patch.program} "${patch?.name || ""}"`;

  if (MOCK) return `[MOCK MIDI] ${msg}`;

  const outName = machine?.out;
  if (!outName) 
  {
    throw new Error(`Machine "${machine?.name || machine?.id}" n'a pas de sortie MIDI (out=null). Assigne un port.`);
  }

  const out = getOrOpenOutputByName(outName);

  const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));

  if (msb != null) out.sendMessage([0xB0 | ch, 0, clamp7(msb)]);
  if (lsb != null) out.sendMessage([0xB0 | ch, 32, clamp7(lsb)]);
  out.sendMessage([0xC0 | ch, clamp7(patch.program)]);

  return msg;
}

function sendCC(machine, cc, value) 
{
  const ch = Math.max(1, Math.min(16, Number(machine?.channel || 1))) - 1;

  const outName = machine?.out;
  if (!outName) 
  {
    throw new Error(`Machine "${machine?.name || machine?.id}" n'a pas de sortie MIDI (out=null). Assigne un port.`);
  }

  if (MOCK) 
  {
    return `[MOCK MIDI] ${machine?.name || "Machine"} ch=${ch + 1} CC${cc}=${value}`;
  }

  const out = getOrOpenOutputByName(outName);

  const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));

  const cc7 = clamp7(cc);
  const val7 = clamp7(value);

  out.sendMessage([0xB0 | ch, cc7, val7]);
  return `${machine?.name || "Machine"} ch=${ch + 1} CC${cc7}=${val7}`;
}


process.on("exit", closeAll);
process.on("SIGINT", () => { closeAll(); process.exit(0); });
process.on("SIGTERM", () => { closeAll(); process.exit(0); });

module.exports = { listOutputs, sendPatch, sendCC, closeAll };
