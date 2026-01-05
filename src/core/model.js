// model.js

const path = require("path");
const { parseMidnamFile } = require("../midnam/parseMidnam");
const midiDriver = require("../midi/driver");
const { MachinesStore } = require("./machines");
const { SetlistsStore } = require("./setlists");
const { MidiPortsStore } = require("./midiports");

const ENABLE_FUZZY_SEARCH = false;

function fuzzyMatch(query, text)
{
    query = (query || "").toLowerCase();
    text = (text || "").toLowerCase();

    if (!query) return true;
    if (text.includes(query)) return true;

    let qi = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++)
    {
        if (text[ti] === query[qi]) qi++;
    }
    return qi === query.length;
}

class Model
{
    constructor(options = {})
    {
        this.midnamDir = options.midnamDir;
        this.machines = new MachinesStore(options.machines || {});
        this.setlists = new SetlistsStore(options.setlists || {});
        this.midiports = new MidiPortsStore(options.midiports || {});

        this._midnamNameCache = new Map();

        this.state = {
            currentMidnamFile: null,
            model: null,
            bankIndex: 0,
            patchFilter: "",
            globalSearchResults: null,
            selectedPatchIndex: 0
        };

        // Draft = “cue en cours de construction” (multi-machines)
        this.draft = {
            name: "",
            routes: [] // [{ machineId, midnamFile, deviceName, bankName, msb, lsb, program, patchName }]
        };

        // ensure there is at least one setlist
        this.ensureActiveSetlist();
    }

    // ---------- Machines helpers ----------

    listMachines()
    {
        return this.machines.list();
    }

    getActiveMachine()
    {
        return this.machines.getActive();
    }

    cycleActiveMachine(delta = 1)
    {
        const list = this.machines.list();
        if (!list.length) return null;

        const cur = this.machines.getActive();
        let idx = 0;

        if (cur)
        {
            const i = list.findIndex(m => m.id === cur.id);
            if (i >= 0) idx = i;
        }

        idx = (idx + delta + list.length) % list.length;
        this.machines.setActive(list[idx].id);
        return this.machines.getActive();
    }

    // ---------- Setlists helpers ----------

    ensureActiveSetlist()
    {
        return this.setlists.ensureDefaultSetlist("Default");
    }

    getActiveSetlist()
    {
        return this.setlists.getActive();
    }

    listEntries()
    {
        const s = this.getActiveSetlist();
        if (!s) return [];
        return [...s.entries];
    }

    getEntry(entryId)
    {
        const s = this.getActiveSetlist();
        if (!s) return null;
        return s.entries.find(e => e.id === entryId) || null;
    }


    listSetlists()
    {
        return this.setlists.list();
    }

    setActiveSetlist(id)
    {
        return this.setlists.setActive(id);
    }

    addSetlist(name)
    {
        const s = this.setlists.addSetlist(String(name || "").trim() || "Setlist");
        // Optionnel: rendre active la nouvelle setlist directement
        this.setlists.setActive(s.id);
        return s;
    }

    renameSetlist(id, name)
    {
        return this.setlists.renameSetlist(id, name);
    }

    deleteSetlist(id)
    {
        return this.setlists.removeSetlist(id);
    }

    updateEntryRouteFromDraft(entryId, machineId)
    {
        const s = this.getActiveSetlist();
        if (!s) return { ok: false, message: "No active setlist." };

        const r = this.draft.routes.find(x => x.machineId === machineId);
        if (!r) return { ok: false, message: "Draft has no route for that machine." };

        const ok = this.setlists.upsertRoute(s.id, entryId, r);
        return { ok, message: ok ? "Route updated from draft." : "Route update failed." };
    }

    removeEntryRoute(entryId, machineId)
    {
        const s = this.getActiveSetlist();
        if (!s) return false;
        return this.setlists.removeRoute(s.id, entryId, machineId);
    }


    updateEntryRouteCC(entryId, machineId, ccSlots)
    {
        const s = this.getActiveSetlist();
        if (!s) return { ok: false, message: "No active setlist." };

        const e = this.setlists.getEntry(s.id, entryId);
        if (!e) return { ok: false, message: "Entry not found." };

        const existing = Array.isArray(e.routes) ? e.routes.find(r => r && r.machineId === machineId) : null;
        if (!existing) return { ok: false, message: "Route not found for that machine." };

        const copy = Object.assign({}, existing, { ccSlots: Array.isArray(ccSlots) ? ccSlots : [] });

        const ok = this.setlists.upsertRoute(s.id, entryId, copy);
        return { ok, message: ok ? "CC slots updated." : "CC update failed." };
    }

    getEntryRoute(entryId, machineId)
    {
        const s = this.getActiveSetlist();
        if (!s) return null;
        const e = this.setlists.getEntry(s.id, entryId);
        if (!e) return null;
        return (Array.isArray(e.routes) ? e.routes.find(r => r && r.machineId === machineId) : null) || null;
    }

    _sendRouteCCSlots(machineRun, ccSlots)
    {
        if (!machineRun) return;
        if (!Array.isArray(ccSlots) || !ccSlots.length) return;
        if (typeof midiDriver.sendCC !== "function") return;

        const clamp7 = (n) =>
        {
            n = Number(n);
            if (!Number.isFinite(n)) return null;
            n = n | 0;
            if (n < 0) n = 0;
            if (n > 127) n = 127;
            return n;
        };

        // Tu as dit: 4 CC. On respecte.
        const slots = ccSlots.slice(0, 4);

        for (const s of slots)
        {
            if (!s) continue;

            const cc = clamp7(s.cc);
            const value = clamp7(s.value);

            if (cc == null || value == null) continue;

            try
            {
                midiDriver.sendCC(machineRun, cc, value);

                this.logSend(
                    "SETLIST_CC",
                    machineRun,
                    { name: "CC", msb: null, lsb: null },
                    { program: null, name: `CC${cc}=${value}` }
                );
            }
            catch
            {
                // non-fatal: ne bloque pas le recall
            }
        }
    }



    duplicateEntry(entryId, newName)
    {
        const s = this.getActiveSetlist();
        if (!s) return null;
        return this.setlists.duplicateEntry(s.id, entryId, newName);
    }

    moveEntry(entryId, delta)
    {
        const s = this.getActiveSetlist();
        if (!s) return false;
        return this.setlists.moveEntry(s.id, entryId, delta);
    }


    // ---------- Midnam helpers ----------

    peekMidnamDeviceName(fileName)
    {
        if (this._midnamNameCache.has(fileName))
        {
            return this._midnamNameCache.get(fileName);
        }

        const filePath = path.join(this.midnamDir, fileName);
        const m = parseMidnamFile(filePath);
        const name = m?.deviceName || fileName;

        this._midnamNameCache.set(fileName, name);
        return name;
    }

    loadMidnam(fileName)
    {
        const filePath = path.join(this.midnamDir, fileName);
        const model = parseMidnamFile(filePath);

        this.state.currentMidnamFile = fileName;
        this.state.model = model;
        this.state.bankIndex = 0;
        this.state.patchFilter = "";
        this.state.globalSearchResults = null;
        this.state.selectedPatchIndex = 0;

        return model;
    }

    setBankIndex(i)
    {
        const m = this.state.model;
        if (!m?.banks?.length)
        {
            this.state.bankIndex = 0;
            return 0;
        }

        const clamped = Math.max(0, Math.min(m.banks.length - 1, i));
        this.state.bankIndex = clamped;
        this.state.selectedPatchIndex = 0;
        return clamped;
    }

    setPatchFilter(q)
    {
        this.state.patchFilter = String(q || "");
        this.state.selectedPatchIndex = 0;
    }

    getCurrentBank()
    {
        const m = this.state.model;
        if (!m?.banks?.length) return null;
        return m.banks[this.state.bankIndex] ?? m.banks[0];
    }

    getBanksView()
    {
        const m = this.state.model;
        if (!m?.banks?.length) return { items: ["<no banks>"], count: 0 };

        const items = m.banks.map((b, i) =>
        {
            const msb = b.msb == null ? "-" : b.msb;
            const lsb = b.lsb == null ? "-" : b.lsb;
            return `${i + 1}. ${b.name}  [MSB ${msb} / LSB ${lsb}]  (${b.patches.length})`;
        });

        return { items, count: items.length };
    }

    getPatchesView()
    {
        const m = this.state.model;
        if (!m?.banks?.length)
        {
            this.state.globalSearchResults = null;
            return { items: ["<no patches>"], list: [], mode: "none" };
        }

        const q = this.state.patchFilter.trim().toLowerCase();

        // Recherche globale
        if (q)
        {
            const results = [];

            m.banks.forEach((bank, bankIndex) =>
            {
                bank.patches.forEach((patch, patchIndex) =>
                {
                    const hay = `${patch.name} ${patch.program}`.toLowerCase();

                    const match = ENABLE_FUZZY_SEARCH
                        ? fuzzyMatch(q, hay)
                        : hay.includes(q);

                    if (match)
                    {
                        results.push({ bankIndex, patchIndex, bank, patch });
                    }
                });
            });

            this.state.globalSearchResults = results;

            const items = results.map(r =>
                `[${r.bank.name}] ${String(r.patch.program).padStart(3, " ")}  ${r.patch.name}`
            );

            return {
                items: items.length ? items : ["<no match>"],
                list: results,
                mode: "global"
            };
        }

        // Mode banque courante
        this.state.globalSearchResults = null;

        const bank = this.getCurrentBank();
        if (!bank)
        {
            return { items: ["<no patches>"], list: [], mode: "none" };
        }

        const items = bank.patches.map(p =>
            `${String(p.program).padStart(3, " ")}  ${p.name}`
        );

        return {
            items: items.length ? items : ["<no patches>"],
            list: bank.patches,
            mode: "bank",
            bank
        };
    }

resolveMachineOut(machine)
{
    if (!machine) return null;

    // New way: outSlot -> midiports.json -> physical port name
    if (machine.outSlot != null && this.midiports && typeof this.midiports.getPort === "function")
    {
        const p = this.midiports.getPort(machine.outSlot);
        if (p) return p;
    }

    // Legacy: direct physical port name in machines.json
    return machine.out || null;
}

sendSelectedPatch(view, selectedIndex)
    {
        const machine = this.machines.getActive() || { id: "default", name: "Machine", out: null, channel: 1 };
        const m = this.state.model;

        if (!m)
        {
            return { ok: false, message: "Aucun instrument chargé." };
        }

        if (!view || !Array.isArray(view.list))
        {
            return { ok: false, message: "Vue patches invalide." };
        }

        const idx = selectedIndex | 0;
        const entry = view.list[idx];

        if (!entry)
        {
            return { ok: false, message: "Sélection invalide." };
        }

        let bank, patch;

        if (view.mode === "global")
        {
            bank = entry.bank;
            patch = entry.patch;
            this.setBankIndex(entry.bankIndex);
        }
        else
        {
            bank = this.getCurrentBank();
            patch = entry;
        }

        if (!patch || patch.program == null)
        {
            return { ok: false, message: "Patch invalide (program manquant)." };
        }

        try
        {

const out = this.resolveMachineOut(machine);
if (!out)
{
    return { ok: false, message: "Aucune sortie MIDI assignée (Machines/Ports)." };
}

const machineRun = Object.assign({}, machine, { out });

const msg = midiDriver.sendPatch(machineRun, bank, patch);
            this.logSend("BROWSE_SEND", machineRun, bank, patch);
            return { ok: true, message: `Device: ${m.deviceName}\n${msg}` };
        }
        catch (e)
        {
            console.log("SendPatch FAILED", {
                machine,
                bank,
                patchProgram: patch?.program,
                patch,
                err: e?.stack || e
            });
            
            return { ok: false, message: `Send error:\n${e.message}` };
        }
    }

    // ---------- Draft (cue building) ----------

    draftClear()
    {
        this.draft.name = "";
        this.draft.routes = [];
    }

    draftGetSummary()
    {
        const n = this.draft.routes.length;
        if (!n) return "Draft: <vide>";
        const names = this.draft.routes
            .map(r => r.machineId || "?")
            .slice(0, 4)
            .join(", ");
        return `Draft: ${n} route(s) [${names}${n > 4 ? ", ..." : ""}]`;
    }

    snapshotSelectionForSetlist(view, selectedIndex)
    {
        const m = this.state.model;
        if (!m) return null;

        if (!view || !Array.isArray(view.list)) return null;

        const idx = selectedIndex | 0;
        const entry = view.list[idx];
        if (!entry) return null;

        let bank, patch;


        if (view.mode === "global")
        {
            bank = entry.bank;
            patch = entry.patch;
        }
        else
        {
            bank = this.getCurrentBank();
            patch = entry;
        }

        const machine = this.machines.getActive() || { id: "default" };

        if (patch?.program == null) return null;

        return {
            machineId: machine.id || "default",
            midnamFile: this.state.currentMidnamFile,
            deviceName: m.deviceName,
            bankName: bank?.name || null,
            msb: bank?.msb ?? null,
            lsb: bank?.lsb ?? null,
            program: patch?.program ?? null,
            patchName: patch?.name || null
        };
    }

    draftUpsertFromCurrentSelection(view, selectedIndex)
    {
        const snap = this.snapshotSelectionForSetlist(view, selectedIndex);

        if (!snap) return { ok: false, message: "Impossible: sélection invalide ou instrument non chargé." };
        if (!snap.machineId) return { ok: false, message: "Aucune machine active." };
        if (snap.program == null)
        {
            return { ok: false, message: "Ce patch n'a pas de Program Change (program=undefined). Impossible de l'ajouter au draft." };
        }


        

        const idx = this.draft.routes.findIndex(r => r.machineId === snap.machineId);
        if (idx >= 0)
        {
            this.draft.routes[idx] = snap;
        }
        else
        {
            this.draft.routes.push(snap);
        }

        return { ok: true, message: `Draft: route mise à jour pour machine ${snap.machineId}.` };
    }
    // ---------- Commit / Recall ----------

    pasteDraftIntoEntry(entryId, options = {})
    {
        const s = this.getActiveSetlist();
        if (!s) return { ok: false, message: "No active setlist." };

        const e = this.setlists.getEntry(s.id, entryId);
        if (!e) return { ok: false, message: "Entry not found." };

        const draftRoutes = Array.isArray(this.draft.routes) ? this.draft.routes : [];
        if (!draftRoutes.length)
        {
            return { ok: false, message: "Draft is empty: nothing to paste." };
        }

        const existing = Array.isArray(e.routes) ? e.routes : [];
        const existingByMachine = new Map();
        for (const r of existing)
        {
            if (r && r.machineId) existingByMachine.set(r.machineId, r);
        }

        // Conflicts = same machineId already present in the entry.
        const conflicts = [];
        for (const r of draftRoutes)
        {
            if (!r || !r.machineId) continue;
            if (existingByMachine.has(r.machineId)) conflicts.push(r.machineId);
        }

        const force = !!(options && (options.force === true));
        if (conflicts.length && !force)
        {
            const unique = [...new Set(conflicts)];
            const names = unique.map(id =>
            {
                const m = (this.machines && typeof this.machines.getById === "function") ? this.machines.getById(id) : null;
                return (m && m.name) ? m.name : id;
            });

            return {
                ok: false,
                confirm: true,
                conflicts: unique,
                message: `Overwrite existing route(s) for: ${names.join(", ")} ?`
            };
        }

        // Merge behavior:
        // - If machineId does not exist => add new route.
        // - If machineId exists => overwrite (when force=true).
        let added = 0;
        let overwritten = 0;

        for (const r of draftRoutes)
        {
            if (!r || !r.machineId) continue;

            const copy = Object.assign({}, r);
            const had = existingByMachine.has(copy.machineId);

            const ok = this.setlists.upsertRoute(s.id, entryId, copy);
            if (ok)
            {
                if (had) overwritten++;
                else added++;
            }
        }

        if (options && options.clearDraft) this.draftClear();

        return { ok: true, message: `Pasted from draft: +${added} route(s), overwritten ${overwritten}.` };
    }

    commitDraftAsEntry(entryName)
    {
        const s = this.ensureActiveSetlist();

        if (!this.draft.routes.length)
        {
            return { ok: false, message: "Draft vide: rien à enregistrer." };
        }

        const name = String(entryName || "").trim() || "Entry";

        const e = this.setlists.addEntry(s.id, name, this.draft.routes);

        if (!e)
        {
            return { ok: false, message: "Erreur: impossible de créer l’entrée." };
        }

        this.draftClear();
        return { ok: true, message: `Entrée créée: ${e.name} (${e.routes.length} route(s))` };
    }

    renameEntry(entryId, name)
    {
        const s = this.getActiveSetlist();
        if (!s) return false;
        return this.setlists.renameEntry(s.id, entryId, name);
    }

    deleteEntry(entryId)
    {
        const s = this.getActiveSetlist();
        if (!s) return false;
        return this.setlists.removeEntry(s.id, entryId);
    }

    recallEntry(entryId)
    {
        const s = this.getActiveSetlist();
        if (!s) return { ok: false, message: "Aucune setlist active." };

        const e = this.setlists.getEntry(s.id, entryId);
        if (!e) return { ok: false, message: "Entrée introuvable." };

        const lines = [];
        const errors = [];

        e.routes.forEach((r) =>
        {
            const machine = this.machines.getById(r.machineId) || this.machines.getActive();

            if (!machine)
            {
                errors.push(`Machine inconnue: ${r.machineId}`);
                return;
            }

            // On fabrique un "bank" et "patch" minimal compatibles driver
            const bank = {
                name: r.bankName || "Bank",
                msb: (r.msb == null ? null : r.msb),
                lsb: (r.lsb == null ? null : r.lsb)
            };

            const patch = {
                name: r.patchName || "Patch",
                program: r.program
            };

            if (patch.program == null)
            {
                errors.push(`Program manquant pour machine ${machine.name || machine.id}`);
                return;
            }

            try
            {
const out = this.resolveMachineOut(machine);
if (!out)
{
    lines.push(`WARN: pas de sortie MIDI pour ${machine.name || machine.id}`);
    return;
}

const machineRun = Object.assign({}, machine, { out });
midiDriver.sendPatch(machineRun, bank, patch);
                this._sendRouteCCSlots(machineRun, r.ccSlots);
                this.logSend("SETLIST_RECALL", machineRun, bank, patch);
                lines.push(`${machine.name || machine.id} -> ${bank.name} ${patch.program} ${patch.name}`);
            }
            catch (ex)
            {
                errors.push(`${machine.name || machine.id}: ${ex.message}`);
            }
        });

        if (errors.length)
        {
            return { ok: false, message: `Recall partiel.\n${lines.join("\n")}\n\nErreurs:\n${errors.join("\n")}` };
        }

        return { ok: true, message: `Recall OK: ${e.name}\n${lines.join("\n")}` };
    }

    getMachinesInstrumentsView()
    {
        const list = this.machines.list();

        const items = list.map((m) =>
        {
            const out = m.out ? m.out : "default";
            const ch = m.channel ? `CH${m.channel}` : "CH?";

            let dev = "";
            if (m.midnamFile)
            {
                try
                {
                    dev = this.peekMidnamDeviceName(m.midnamFile);
                }
                catch
                {
                    dev = "?";
                }
            }
            else
            {
                dev = "<no midnam>";
            }

            // Exemple d’affichage:
            // Korg T1  [USB MIDI 1 / CH3]  TR-Rack
            return `${m.name}  {gray-fg}[${out} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}`;
        });

        return { items, list };
    }

    selectMachineAsInstrument(machineId)
    {
        const m = this.machines.getById(machineId);
        if (!m) return { ok: false, message: "Machine introuvable." };

        this.machines.setActive(m.id);

        if (!m.midnamFile)
        {
            this.state.currentMidnamFile = null;
            this.state.model = null;
            this.state.bankIndex = 0;
            this.state.patchFilter = "";
            this.state.globalSearchResults = null;
            return { ok: true, message: `Machine active: ${m.name}\n(midnam: none)` };
        }

        try
        {
            const model = this.loadMidnam(m.midnamFile);
            return { ok: true, message: `Machine active: ${m.name}\nDevice: ${model.deviceName}` };
        }
        catch (e)
        {
            return { ok: false, message: `Erreur midnam (${m.midnamFile}):\n${e.message}` };
        }
    }

    // Logging helpers
    _nowStamp()
    {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    logSend(action, machine, bank, patch)
    {
        const out = machine?.out || "default";
        const ch  = machine?.channel || "?";
        const mname = machine?.name || machine?.id || "?";

        const bname = bank?.name || "Bank";
        const msb = (bank?.msb == null) ? "-" : bank.msb;
        const lsb = (bank?.lsb == null) ? "-" : bank.lsb;

        const pc = (patch?.program == null) ? "?" : patch.program;
        const pname = patch?.name || "Patch";

        console.log(
        `[MIDISTAGE] ${this._nowStamp()} | ${action} | ${mname} | out=${out} ch=${ch} | ${bname} msb=${msb} lsb=${lsb} | pc=${pc} | ${pname}`
        );
    }


}

module.exports = { Model };
