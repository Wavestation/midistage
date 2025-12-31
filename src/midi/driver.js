const MOCK = process.env.MIDI_MOCK === "1";

function sendPatch(machine, bank, patch) {
  const msb = bank?.msb ?? null;
  const lsb = bank?.lsb ?? null;

  // garde-fou
  if (patch?.program == null) {
    throw new Error(`Patch invalide: program absent. Patch=${JSON.stringify(patch)}`);
  }

  const msg =
    `${machine.name} ch=${machine.channel} -> ` +
    `MSB=${msb ?? "-"} LSB=${lsb ?? "-"} PC=${patch.program} "${patch.name}"`;

  if (MOCK) return `[MOCK MIDI] ${msg}`;

  throw new Error("MIDI réel non implémenté. Lance avec MIDI_MOCK=1.");
}

module.exports = { sendPatch };
