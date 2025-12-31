const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");

/**
 * Parse un fichier .midnam (CoreMIDI) et retourne une structure normalisée:
 * {
 *   deviceName: string,
 *   banks: [
 *     { name, msb, lsb, patches: [ { name, program } ] }
 *   ]
 * }
 *
 * Compatible avec les midnam où:
 * - les patches sont des <Patch ...> (cas Essence FM / K2600 / TR-Rack)
 * - MSB/LSB sont définis via <MIDICommands><ControlChange Control="0|32" Value="..."/>
 * - PatchNameList peut être imbriquée dans PatchBank OU déclarée ailleurs (nom identique)
 */
function parseMidnamFile(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    trimValues: true,
    parseTagValue: true,
    parseAttributeValue: true,
  });

  const doc = parser.parse(xml);

  const manufacturer = findFirstText(doc, ["Manufacturer"]) || "";
  const model = findFirstText(doc, ["Model"]) || "";
  const deviceName = (manufacturer && model) ? `${manufacturer} ${model}` : (model || manufacturer || "Unknown MIDNAM");

  // Collecte des PatchBank et PatchNameList
  const patchBanks = [];
  collectNodesByName(doc, "PatchBank", patchBanks);

  const patchNameLists = [];
  collectNodesByName(doc, "PatchNameList", patchNameLists);

  const banks = [];

  for (const bankNode of patchBanks) {
    const bankName = bankNode?.["@_Name"] ?? bankNode?.["@_name"] ?? "Bank";

    // MSB/LSB: via MIDICommands/ControlChange
    const { msb, lsb } = extractBankSelectFromMidiCommands(bankNode);

    // Patches: d'abord PatchNameList imbriquée, sinon PatchNameList globale de même nom
    let patches = extractPatchesFromEmbeddedPatchNameLists(bankNode);

    if (!patches.length) {
      const pl = findPatchNameListByName(patchNameLists, bankName);
      if (pl) patches = extractPatchesFromPatchNameList(pl);
    }

    // Fallback: si le bankNode contient directement des Patch (rare)
    if (!patches.length) patches = extractPatchesFromPatchContainer(bankNode);

    if (patches.length) {
      banks.push({
        name: bankName,
        msb,
        lsb,
        patches: dedupeAndSortPatches(patches),
      });
    }
  }

  // Fallback si aucun PatchBank n’a produit de banques, mais on a des PatchNameList
  if (!banks.length && patchNameLists.length) {
    for (const pl of patchNameLists) {
      const name = pl?.["@_Name"] ?? pl?.["@_name"] ?? "Patches";
      const patches = extractPatchesFromPatchNameList(pl);
      if (patches.length) {
        banks.push({
          name,
          msb: null,
          lsb: null,
          patches: dedupeAndSortPatches(patches),
        });
      }
    }
  }

  return { deviceName, banks };
}

// ---------- Extraction helpers ----------

function extractBankSelectFromMidiCommands(bankNode) {
  // Cherche ControlChange Control="0" (MSB) et Control="32" (LSB)
  const ccNodes = [];
  collectNodesByName(bankNode, "ControlChange", ccNodes);

  let msb = null;
  let lsb = null;

  for (const cc of ccNodes) {
    const ctrl = numberOrNull(cc?.["@_Control"] ?? cc?.["@_control"]);
    const val = numberOrNull(cc?.["@_Value"] ?? cc?.["@_value"]);
    if (ctrl === 0 && msb == null) msb = val;
    if (ctrl === 32 && lsb == null) lsb = val;
  }

  return { msb, lsb };
}

function extractPatchesFromEmbeddedPatchNameLists(bankNode) {
  const embeddedLists = [];
  collectNodesByName(bankNode, "PatchNameList", embeddedLists);

  let patches = [];
  for (const pl of embeddedLists) patches = patches.concat(extractPatchesFromPatchNameList(pl));
  return patches;
}

function findPatchNameListByName(allLists, name) {
  return allLists.find(pl => (pl?.["@_Name"] ?? pl?.["@_name"]) === name);
}

function extractPatchesFromPatchNameList(patchNameListNode) {
  // Dans tes fichiers, c’est <Patch ...>
  const patchNodes = [];
  collectNodesByName(patchNameListNode, "Patch", patchNodes);

  // Certains .midnam utilisent <PatchName ...> (autres fabricants), on supporte aussi
  const patchNameNodes = [];
  collectNodesByName(patchNameListNode, "PatchName", patchNameNodes);

  const patchesFromPatch = patchNodes.map(patchNodeToPatch).filter(Boolean);
  const patchesFromPatchName = patchNameNodes.map(patchNameNodeToPatch).filter(Boolean);

  return patchesFromPatch.length ? patchesFromPatch : patchesFromPatchName;
}

function extractPatchesFromPatchContainer(node) {
  const patchNodes = [];
  collectNodesByName(node, "Patch", patchNodes);
  return patchNodes.map(patchNodeToPatch).filter(Boolean);
}

function patchNodeToPatch(n) {
  // <Patch Number="A00" Name="Acoustic Piano" ProgramChange="1" />
  const name = n?.["@_Name"] ?? n?.["@_name"] ?? null;

  let program =
    n?.["@_ProgramChange"] ??
    n?.["@_programChange"] ??
    n?.["@_Program"] ??
    n?.["@_program"] ??
    n?.["@_PatchNumber"] ??
    n?.["@_patchNumber"];

  if (program == null) return null;
  program = Number(program);
  if (!Number.isFinite(program)) return null;

  return { name: String(name ?? `Program ${program}`), program };
}

function patchNameNodeToPatch(n) {
  // Support legacy: <PatchName Name="Warm Pad" ProgramChange="12"/>
  const name = n?.["@_Name"] ?? n?.["@_name"] ?? n?.["#text"] ?? null;

  let program =
    n?.["@_ProgramChange"] ??
    n?.["@_programChange"] ??
    n?.["@_Program"] ??
    n?.["@_program"];

  if (program == null) return null;
  program = Number(program);
  if (!Number.isFinite(program)) return null;

  return { name: String(name ?? `Program ${program}`), program };
}

// ---------- Generic helpers ----------

function dedupeAndSortPatches(patches) {
  const seen = new Set();
  const out = [];
  for (const p of patches) {
    const key = `${p.program}::${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => a.program - b.program);
  return out;
}

function numberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function collectNodesByName(obj, targetName, out) {
  if (obj == null) return;

  if (Array.isArray(obj)) {
    for (const it of obj) collectNodesByName(it, targetName, out);
    return;
  }
  if (typeof obj !== "object") return;

  for (const [k, v] of Object.entries(obj)) {
    if (k === targetName) {
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } else {
      collectNodesByName(v, targetName, out);
    }
  }
}

function findFirstText(obj, keys) {
  let found = null;
  (function walk(x) {
    if (found) return;
    if (x == null) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x !== "object") return;

    for (const k of keys) {
      const v = x[k];
      if (typeof v === "string" && v.trim()) {
        found = v.trim();
        return;
      }
    }
    for (const v of Object.values(x)) walk(v);
  })(obj);
  return found;
}

module.exports = { parseMidnamFile };
