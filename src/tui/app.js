// app.js
"use strict";

const fs = require("fs");
const blessed = require("blessed");

const { Model } = require("../core/model");

module.exports = function startApp(midnamDir, io)
{
  const screen = blessed.screen({
    smartCSR: true,
    title: "MIDISTAGE 26+",
    // blessed varie selon versions. On force un comportement stable.
    unicode: (io && typeof io.unicode === "boolean") ? io.unicode : true,
    fullUnicode: (io && typeof io.unicode === "boolean") ? io.unicode : true,

    input: io ? io.input : undefined,
    output: io ? io.output : undefined,
    terminal: io && io.terminal ? io.terminal : "xterm-256color",
    cols: (io && Number.isFinite(io.cols)) ? io.cols : undefined,
    rows: (io && Number.isFinite(io.rows)) ? io.rows : undefined
  });

  if (io && Number.isFinite(io.cols) && Number.isFinite(io.rows))
  {
    try
    {
      if (screen.program && typeof screen.program.resize === "function")
        screen.program.resize(io.cols, io.rows);
      else
      {
        screen.cols = io.cols;
        screen.rows = io.rows;
      }
    }
    catch { }
  }

  if (io && typeof io.onResize === "function")
  {
    io.onResize((cols, rows) =>
    {
      try
      {
        if (screen.program && typeof screen.program.resize === "function")
          screen.program.resize(cols, rows);
        screen.render();
      }
      catch { }
    });
  }

  const model = new Model({ midnamDir });

  // -------------------- Key binding helpers (CRITICAL) --------------------
  function makeKeyBinder()
  {
    const bindings = []; // [{ keys, handler }]

    function bindKey(keys, handler)
    {
      screen.key(keys, handler);
      bindings.push({ keys, handler });
    }

    function unbindAllKeys()
    {
      for (const b of bindings)
      {
        try { screen.unkey(b.keys, b.handler); } catch { }
      }
      bindings.length = 0;
    }

    return { bindKey, unbindAllKeys };
  }

  // Page switching
  let currentCleanup = null;

  function clearScreen()
  {
    try { screen.children.forEach(c => c.destroy()); } catch { }
  }

  function switchPage(name)
  {
    if (currentCleanup)
    {
      try { currentCleanup(); } catch { }
      currentCleanup = null;
    }

    clearScreen();

    if (name === "setlist") currentCleanup = buildSetlistPage();
    else if (name === "machines") currentCleanup = buildMachinesPage();
    else currentCleanup = buildBrowsePage();

    screen.render();
  }

  function quit()
  {
    try { screen.destroy(); } catch { }
    process.exit(0);
  }

  // -------------------- Browse Page --------------------

  function buildBrowsePage()
  {
    const midiDriver = require("../midi/driver");
    const kb = makeKeyBinder();

    const FOCUS_MARK = "◆";
    const THEME = {
      border: { fg: "white" },
      borderFocus: { fg: "cyan" }
    };

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE -- (C) DEC 2025 MASAMI KOMURO ~ FELONIA SOFTWARE ",
      style: { border: THEME.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 1,
      height: 3,
      width: "100%-2",
      tags: true,
      content:
        "{bold}Tab{/bold} focus | {bold}Enter{/bold} send | {bold}s{/bold} search | {bold}a{/bold} add->draft | {bold}m{/bold} machines | {bold}o{/bold} MIDI out | {bold}l{/bold} setlist | {bold}Ctrl-Q{/bold} quit"
    });

    // “Instruments” = machines.json
    const filesList = blessed.list({
      parent: frame,
      top: 3,
      left: 1,
      width: "33%-2",
      height: "100%-6",
      border: "line",
      label: " Instruments ",
      keys: true,
      vi: true,
      tags: true,
      style: { border: THEME.border, selected: { inverse: true } }
    });

    const banksList = blessed.list({
      parent: frame,
      top: 3,
      left: "33%",
      width: "34%-1",
      height: "100%-6",
      border: "line",
      label: " Banks ",
      keys: true,
      vi: true,
      style: { border: THEME.border, selected: { inverse: true } }
    });

    const patchesList = blessed.list({
      parent: frame,
      top: 3,
      left: "67%",
      width: "33%-2",
      height: "100%-10",
      border: "line",
      label: " Patches ",
      keys: true,
      vi: true,
      style: { border: THEME.border, selected: { inverse: true } }
    });

    const search = blessed.textbox({
      parent: frame,
      bottom: 4,
      left: "67%",
      height: 3,
      width: "33%-2",
      border: "line",
      label: " Search ",
      inputOnFocus: true,
      style: { border: THEME.border }
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      height: 3,
      width: "100%-2",
      border: "line",
      label: " Status ",
      content: "Sélectionne une machine (machines.json).",
      padding: { left: 1, right: 1 },
      tags: true,
      style: { border: THEME.border }
    });

    function setLabelWithFocus(widget, baseLabel, focused)
    {
      widget.setLabel(` ${focused ? FOCUS_MARK + " " : ""}${baseLabel} `);
      const borderStyle = focused ? THEME.borderFocus : THEME.border;
      if (widget.style && widget.style.border) widget.style.border = borderStyle;
    }

    function refreshFocusMarkers()
    {
      setLabelWithFocus(filesList, "Instruments", screen.focused === filesList);
      setLabelWithFocus(banksList, "Banks", screen.focused === banksList);
      setLabelWithFocus(patchesList, "Patches", screen.focused === patchesList);
      setLabelWithFocus(search, "Search", screen.focused === search);
      setLabelWithFocus(status, "Status", screen.focused === status);

      if (!midiModal.hidden) midiModal.setLabel(` ${FOCUS_MARK} MIDI Outputs `);
      else midiModal.setLabel(" MIDI Outputs ");
    }

    function setStatus(text, level)
    {
      let prefix = "";
      if (level === "ok") prefix = "{green-fg}[OK]{/green-fg} ";
      else if (level === "warn") prefix = "{yellow-fg}[WARN]{/yellow-fg} ";
      else if (level === "err") prefix = "{red-fg}[ERR]{/red-fg} ";
      status.setContent(prefix + text);
      screen.render();
    }

    function tryPeekDeviceName(midnamFile)
    {
      if (!midnamFile) return "<no midnam>";
      try { return model.peekMidnamDeviceName(midnamFile); } catch { return "?"; }
    }

    function machineToLine(m)
    {
      const out = m.out ? m.out : "default";
      const ch = m.channel ? `CH${m.channel}` : "CH?";
      const mid = m.midnamFile ? m.midnamFile : "<no midnam>";
      const dev = tryPeekDeviceName(m.midnamFile);
      return `${m.name}  {gray-fg}[${out} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}  {gray-fg}(${mid}){/gray-fg}`;
    }

    // -------- MIDI port picker modal --------

    const midiModal = blessed.box({
      parent: frame,
      top: "center",
      left: "center",
      width: "70%",
      height: "60%",
      border: "line",
      label: " MIDI Outputs ",
      hidden: true,
      tags: true,
      style: { border: THEME.borderFocus },
      padding: { left: 1, right: 1 }
    });

    const midiList = blessed.list({
      parent: midiModal,
      top: 1,
      left: 1,
      width: "100%-2",
      height: "100%-4",
      keys: true,
      vi: true,
      style: { selected: { inverse: true } }
    });

    blessed.box({
      parent: midiModal,
      bottom: 0,
      left: 1,
      height: 2,
      width: "100%-2",
      tags: true,
      content: "{bold}↑↓{/bold} choisir | {bold}Enter{/bold} assigner | {bold}Esc{/bold} annuler"
    });

    function openMidiPicker()
    {
      const active = model.getActiveMachine();
      if (!active)
      {
        setStatus("Aucune machine active.", "warn");
        return;
      }

      const ports = midiDriver.listOutputs();
      if (!ports.length)
      {
        setStatus("Aucun port MIDI détecté.", "warn");
        return;
      }

      midiList.setItems(ports);
      midiList._ports = ports;

      let idx = 0;
      if (active.out)
      {
        const i = ports.findIndex(p => p === active.out);
        if (i >= 0) idx = i;
      }
      midiList.select(idx);

      midiModal.show();
      midiList.focus();
      refreshFocusMarkers();
      screen.render();
    }

    function closeMidiPicker(focusBackTo)
    {
      midiModal.hide();
      (focusBackTo || patchesList).focus();
      refreshFocusMarkers();
      screen.render();
    }

    midiList.key(["escape"], () => closeMidiPicker(patchesList));

    midiList.key(["enter"], function ()
    {
      const active = model.getActiveMachine();
      const ports = midiList._ports || [];
      const p = ports[midiList.selected];

      if (!active || !p)
      {
        closeMidiPicker(patchesList);
        return;
      }

      model.machines.update(active.id, { out: p });
      const m2 = model.getActiveMachine();
      setStatus(`Port assigné.\nMachine: ${m2.name}\nMIDI out: ${m2.out}`, "ok");

      closeMidiPicker(patchesList);
      refreshMachinesList();
    });

    // -------------------- Instruments list = machines.json --------------------

    function refreshMachinesList()
    {
      const list = model.listMachines();
      filesList._machines = list;

      if (!list.length)
      {
        filesList.setItems(["<no machines>"]);
        filesList.select(0);
        return;
      }

      filesList.setItems(list.map(machineToLine));

      const active = model.getActiveMachine();
      let idx = 0;
      if (active)
      {
        const found = list.findIndex(x => x.id === active.id);
        if (found >= 0) idx = found;
      }
      filesList.select(Math.max(0, idx));
    }

    function clearLoadedInstrumentUI(msg)
    {
      banksList.setItems(["<no banks>"]);
      banksList.select(0);
      patchesList.setItems(["<no patches>"]);
      patchesList.select(0);
      patchesList._midistageView = { items: ["<no patches>"], list: [], mode: "none" };

      search.setValue("");
      model.setPatchFilter("");
      setStatus(msg || "Aucun instrument chargé.", "warn");
      screen.render();
    }

    function loadSelectedMachineInstrument()
    {
      const list = filesList._machines || [];
      const m = list[filesList.selected];

      if (!m)
      {
        clearLoadedInstrumentUI("Aucune machine sélectionnée.");
        return;
      }

      try { model.machines.setActive(m.id); } catch { }

      if (!m.midnamFile)
      {
        clearLoadedInstrumentUI(`Machine active: ${m.name}\n(midnam: none) | ${model.draftGetSummary()}`);
        return;
      }

      try
      {
        const parsed = model.loadMidnam(m.midnamFile);
        search.setValue("");
        setStatus(`OK: ${parsed.deviceName}\nMachine: ${m.name} | ${model.draftGetSummary()}`, "ok");
        refreshAll();
      }
      catch (e)
      {
        banksList.setItems(["<parse error>"]);
        patchesList.setItems(["<parse error>"]);
        setStatus(`Parse error (${m.midnamFile}):\n${e.message}`, "err");
        screen.render();
      }
    }

    // -------------------- Banks/Patches --------------------

    function refreshBanks()
    {
      const b = model.getBanksView();
      banksList.setItems(b.items);
      if (b.count > 0) banksList.select(Math.min(model.state.bankIndex || 0, b.count - 1));
      else banksList.select(0);
    }

    function refreshPatches()
    {
      const p = model.getPatchesView();
      patchesList.setItems(p.items);
      patchesList._midistageView = p;
      patchesList.select(0);
    }

    function refreshAll()
    {
      refreshBanks();
      refreshPatches();
      refreshFocusMarkers();
      screen.render();
    }

    function sendSelectedPatch()
    {
      const view = patchesList._midistageView;
      const r = model.sendSelectedPatch(view, patchesList.selected);

      if (r.ok)
      {
        setStatus(`${r.message}\n${model.draftGetSummary()}`, "ok");
        refreshBanks();
        screen.render();
      }
      else setStatus(r.message, "err");
    }

    function addToDraft()
    {
      const view = patchesList._midistageView;
      const r = model.draftUpsertFromCurrentSelection(view, patchesList.selected);

      if (r.ok)
      {
        const m = model.getActiveMachine();
        setStatus(`Draft update.\nMachine: ${(m && m.name) ? m.name : "?"}\n${model.draftGetSummary()}`, "ok");
      }
      else setStatus(r.message, "err");
    }

    function clearSearchAndReturn()
    {
      model.setPatchFilter("");
      search.setValue("");
      refreshPatches();
      patchesList.focus();
      refreshFocusMarkers();
      screen.render();
    }

    function moveSelection(delta)
    {
      const count = patchesList.items?.length || 0;
      if (count <= 0) return;

      const first = patchesList.getItem(0)?.getText();
      if (first && first.startsWith("<")) return;

      let next = patchesList.selected + delta;
      if (next < 0) next = count - 1;
      if (next >= count) next = 0;
      patchesList.select(next);
      screen.render();
    }

    // -------------------- Events --------------------

    filesList.on("select", () => loadSelectedMachineInstrument());

    banksList.on("select", () =>
    {
      model.setBankIndex(banksList.selected);
      refreshPatches();
      screen.render();
    });

    patchesList.key(["enter"], () => sendSelectedPatch());

    // Focus management
    const focusables = [filesList, banksList, patchesList];
    let focusIndex = 0;

    function focusNext()
    {
      focusIndex = (focusIndex + 1) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    }

    function focusPrev()
    {
      focusIndex = (focusIndex - 1 + focusables.length) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    }

    kb.bindKey(["tab"], () =>
    {
      if (!midiModal.hidden) return;

      if (screen.focused === search)
      {
        patchesList.focus();
        refreshFocusMarkers();
        screen.render();
        return;
      }
      focusNext();
    });

    kb.bindKey(["S-tab"], () =>
    {
      if (!midiModal.hidden) return;

      if (screen.focused === search)
      {
        patchesList.focus();
        refreshFocusMarkers();
        screen.render();
        return;
      }
      focusPrev();
    });

    [filesList, banksList, patchesList, search, status].forEach(w =>
    {
      w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
      w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
    });

    kb.bindKey(["s"], () =>
    {
      if (!midiModal.hidden) return;
      search.focus();
      refreshFocusMarkers();
      screen.render();
    });

    search.on("submit", (value) =>
    {
      model.setPatchFilter(value || "");
      refreshPatches();
      patchesList.focus();
      refreshFocusMarkers();
      screen.render();
    });

    kb.bindKey(["escape"], () =>
    {
      if (!midiModal.hidden) { closeMidiPicker(patchesList); return; }

      if (screen.focused === search) { clearSearchAndReturn(); return; }

      if (model.state.patchFilter && model.state.patchFilter.trim())
        clearSearchAndReturn();
    });

    kb.bindKey(["C-n"], () => moveSelection(+1));
    kb.bindKey(["C-p"], () => moveSelection(-1));
    kb.bindKey(["a"], () => addToDraft());

    // Go to Machines page
    kb.bindKey(["m"], () => switchPage("machines"));

    // MIDI out picker
    kb.bindKey(["o"], () => openMidiPicker());

    // Go to Setlist page
    kb.bindKey(["l"], () => switchPage("setlist"));

    // Quit
    kb.bindKey(["C-q", "C-c"], () => quit());

    // Init
    refreshMachinesList();
    filesList.focus();
    refreshFocusMarkers();
    screen.render();

    if ((filesList._machines || []).length) loadSelectedMachineInstrument();
    else clearLoadedInstrumentUI("Aucune machine dans machines.json.");

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { midiModal.hide(); } catch { }
    };
  }

  // -------------------- Machines Page --------------------

  function buildMachinesPage()
  {
    const midiDriver = require("../midi/driver");
    const kb = makeKeyBinder();

    const FOCUS_MARK = "◆";
    const THEME = {
      border: { fg: "white" },
      borderFocus: { fg: "cyan" }
    };

    const MIDNAM_NONE = "<none>";
    const OUT_NONE = "<none>";

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE — MACHINES ",
      style: { border: THEME.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 1,
      height: 3,
      width: "100%-2",
      tags: true,
      content:
        "{bold}↑↓{/bold} select | {bold}n{/bold} new | {bold}e{/bold} edit | {bold}x{/bold} delete | {bold}Ctrl+S{/bold} save | {bold}Esc{/bold} cancel edit | {bold}q{/bold} back"
    });

    const machinesList = blessed.list({
      parent: frame,
      top: 3,
      left: 1,
      width: "45%-2",
      height: "100%-6",
      border: "line",
      label: " Machines ",
      keys: true,
      vi: true,
      tags: true,
      style: { border: THEME.border, selected: { inverse: true } }
    });

    const editor = blessed.box({
      parent: frame,
      top: 3,
      left: "45%",
      width: "55%-2",
      height: "100%-6",
      border: "line",
      label: " Editor ",
      tags: true,
      style: { border: THEME.border },
      padding: { left: 1, right: 1 }
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      height: 3,
      width: "100%-2",
      border: "line",
      label: " Status ",
      padding: { left: 1, right: 1 },
      tags: true,
      style: { border: THEME.border },
      content: "Machines."
    });

    // ---- Confirm modal (reusable) ----
    const confirmModal = blessed.box({
      parent: frame,
      top: "center",
      left: "center",
      width: "60%",
      height: 9,
      border: "line",
      label: " Confirm ",
      tags: true,
      hidden: true,
      style: { border: THEME.borderFocus },
      padding: { left: 1, right: 1 }
    });

    const confirmQuestion = blessed.box({
      parent: confirmModal,
      top: 0,
      left: 0,
      height: 3,
      width: "100%",
      tags: true,
      content: ""
    });

    const confirmInput = blessed.textbox({
      parent: confirmModal,
      top: 3,
      left: 0,
      height: 3,
      width: "100%",
      border: "line",
      inputOnFocus: true,
      keys: true,
      vi: true
    });

    blessed.box({
      parent: confirmModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}Enter{/bold} valider | {bold}Esc{/bold} annuler"
    });

    let _confirmCb = null;

    function askConfirm(question, cb)
    {
      _confirmCb = cb;
      confirmQuestion.setContent(question || 'Tape "oui" pour confirmer');
      confirmInput.setValue("");

      confirmModal.show();
      confirmInput.focus();
      confirmInput.readInput();
      refreshFocusMarkers();
      screen.render();
    }

    function closeConfirm(cancelled, value)
    {
      try { confirmModal.hide(); } catch { }
      const cb = _confirmCb;
      _confirmCb = null;

      try { machinesList.focus(); } catch { }
      refreshFocusMarkers();
      screen.render();

      if (cb) cb(cancelled ? new Error("cancelled") : null, value);
    }

    confirmInput.on("submit", (value) => closeConfirm(false, value));
    confirmInput.key(["escape"], () => closeConfirm(true, null));

    // ---- Editor widgets ----

    const nameLabel = blessed.box({
      parent: editor,
      top: 0,
      left: 0,
      height: 1,
      width: "100%",
      tags: true,
      content: "{bold}Nom convivial{/bold}"
    });

    const nameBox = blessed.textbox({
      parent: editor,
      top: 1,
      left: 0,
      height: 3,
      width: "100%",
      border: "line",
      inputOnFocus: true,
      keys: true,
      vi: true
    });

    const midnamLabel = blessed.box({
      parent: editor,
      top: 4,
      left: 0,
      height: 1,
      width: "50%-1",
      tags: true,
      content: "{bold}MIDNAM{/bold}"
    });

    const midnamList = blessed.list({
      parent: editor,
      top: 5,
      left: 0,
      width: "50%-1",
      height: "60%-7",
      border: "line",
      keys: true,
      vi: true,
      tags: true,
      style: { selected: { inverse: true } }
    });

    const outLabel = blessed.box({
      parent: editor,
      top: 4,
      left: "50%",
      height: 1,
      width: "50%-1",
      tags: true,
      content: "{bold}MIDI Output{/bold}"
    });

    const outList = blessed.list({
      parent: editor,
      top: 5,
      left: "50%",
      width: "50%-1",
      height: "60%-7",
      border: "line",
      keys: true,
      vi: true,
      tags: true,
      style: { selected: { inverse: true } }
    });

    const chLabel = blessed.box({
      parent: editor,
      bottom: 6,
      left: 0,
      height: 1,
      width: "100%",
      tags: true,
      content: "{bold}Canal MIDI (1..16){/bold}"
    });

    const chBox = blessed.textbox({
      parent: editor,
      bottom: 3,
      left: 0,
      height: 3,
      width: "50%-1",
      border: "line",
      inputOnFocus: true,
      keys: true,
      vi: true
    });

    const help = blessed.box({
      parent: editor,
      bottom: 0,
      left: 0,
      height: 3,
      width: "100%",
      tags: true,
      content:
        "{bold}Tab{/bold} suivant | {bold}Ctrl+S{/bold} sauver | {bold}Esc{/bold} annuler edit | {bold}n{/bold} new | {bold}e{/bold} edit | {bold}x{/bold} delete"
    });

    // ---- Mode ----
    // view = consultation, edit = modifie existant, create = nouvelle machine
    let _editMode = "view";
    let _editId = null;

    function setStatus(text, level)
    {
      let prefix = "";
      if (level === "ok") prefix = "{green-fg}[OK]{/green-fg} ";
      else if (level === "warn") prefix = "{yellow-fg}[WARN]{/yellow-fg} ";
      else if (level === "err") prefix = "{red-fg}[ERR]{/red-fg} ";
      status.setContent(prefix + text);
      screen.render();
    }

    function shouldAutofillName(currentName)
    {
      const n = String(currentName || "").trim().toLowerCase();
      return !n || n === "nouvelle machine" || n === "machine" || n === "new machine";
    }

    function listMidnamFiles()
    {
      try
      {
        return fs.readdirSync(midnamDir)
          .filter(f => f.toLowerCase().endsWith(".midnam"))
          .sort((a, b) => a.localeCompare(b));
      }
      catch { return []; }
    }

    function refreshMidnamAndOutLists()
    {
      const midnams = [MIDNAM_NONE].concat(listMidnamFiles());
      midnamList.setItems(midnams);
      midnamList._midnams = midnams;

      const outs = [OUT_NONE].concat((midiDriver.listOutputs ? midiDriver.listOutputs() : []));
      outList.setItems(outs);
      outList._outs = outs;
    }

    function machineToLine(m, withId)
    {
      const out = m.out ? m.out : "default";
      const ch = m.channel ? `CH${m.channel}` : "CH?";
      const mid = m.midnamFile ? m.midnamFile : "<no midnam>";
      let dev = "?";
      try { dev = model.peekMidnamDeviceName(m.midnamFile); } catch { dev = "?"; }

      const idPart = withId ? `  {gray-fg}(${m.id}){/gray-fg}` : "";
      return `${m.name}  {gray-fg}[${out} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}  {gray-fg}(${mid}){/gray-fg}${idPart}`;
    }

    function refreshMachinesList(keepId)
    {
      const list = model.listMachines();
      machinesList._machines = list;

      if (!list.length)
      {
        machinesList.setItems(["<no machines>"]);
        machinesList.select(0);
        return;
      }

      machinesList.setItems(list.map(m => machineToLine(m, true)));

      let idx = 0;

      if (keepId)
      {
        const found = list.findIndex(x => x.id === keepId);
        if (found >= 0) idx = found;
      }
      else
      {
        const active = model.getActiveMachine();
        if (active)
        {
          const found = list.findIndex(x => x.id === active.id);
          if (found >= 0) idx = found;
        }
      }

      machinesList.select(Math.max(0, idx));
    }

    function getSelectedMachine()
    {
      const list = machinesList._machines || [];
      return list[machinesList.selected] || null;
    }

    function clearEditor(msg)
    {
      nameBox.setValue("");
      chBox.setValue("1");
      midnamList.select(0);
      outList.select(0);
      _editId = null;
      _editMode = "view";
      setStatus(msg || "Editor reset.", "warn");
      screen.render();
    }

    // IMPORTANT: ne pas toucher _editMode ici (sinon tu t’auto-sabotes).
    function fillEditorFromMachine(m)
    {
      if (!m) { clearEditor("Machine invalide."); return; }

      nameBox.setValue(m.name || "");
      chBox.setValue(String(m.channel || 1));

      const midnams = midnamList._midnams || [MIDNAM_NONE];
      const outs = outList._outs || [OUT_NONE];

      const mid = m.midnamFile || MIDNAM_NONE;
      let mi = midnams.findIndex(x => x === mid);
      if (mi < 0) mi = 0;
      midnamList.select(mi);

      const out = m.out || OUT_NONE;
      let oi = outs.findIndex(x => x === out);
      if (oi < 0) oi = 0;
      outList.select(oi);

      _editId = m.id;
      screen.render();
    }

    function setActiveFromSelection()
    {
      const m = getSelectedMachine();
      if (!m)
      {
        setStatus("Aucune machine.", "warn");
        return;
      }

      try { model.machines.setActive(m.id); } catch { }
      _editMode = "view";
      _editId = m.id;
      fillEditorFromMachine(m);
      setStatus(`Machine active: ${m.name}`, "ok");
    }

    function beginCreate()
    {
      refreshMidnamAndOutLists();

      _editMode = "create";
      _editId = null;

      nameBox.setValue("Nouvelle machine");
      chBox.setValue("1");
      midnamList.select(0);
      outList.select(0);

      nameBox.focus();
      setStatus("Création: renseigne puis Ctrl+S.", "ok");
      screen.render();
    }

    function beginEdit()
    {
      refreshMidnamAndOutLists();

      const m = getSelectedMachine() || model.getActiveMachine();
      if (!m)
      {
        setStatus("Aucune machine à éditer.", "warn");
        return;
      }

      _editId = m.id;
      fillEditorFromMachine(m);

      // IMPORTANT: après fill, sinon fill te flingue tout si tu remets des trucs plus tard
      _editMode = "edit";
      nameBox.focus();
      setStatus(`Édition: ${m.name} (Ctrl+S pour sauver).`, "ok");
      screen.render();
    }

    function maybeAutofillNameFromMidnam()
    {
      if (_editMode !== "edit" && _editMode !== "create") return;

      const midnams = midnamList._midnams || [];
      const sel = midnams[midnamList.selected] || MIDNAM_NONE;
      if (sel === MIDNAM_NONE) return;

      const current = nameBox.getValue();
      if (!shouldAutofillName(current)) return;

      let dev = null;
      try { dev = model.peekMidnamDeviceName(sel); } catch { dev = null; }
      if (!dev) return;

      nameBox.setValue(dev);
      screen.render();
    }

    midnamList.on("highlight", maybeAutofillNameFromMidnam);
    midnamList.on("select", maybeAutofillNameFromMidnam);

    function saveEditor()
    {
      if (_editMode !== "edit" && _editMode !== "create")
      {
        setStatus("Rien à sauver (mode view).", "warn");
        return;
      }

      const midnams = midnamList._midnams || [MIDNAM_NONE];
      const outs = outList._outs || [OUT_NONE];

      const midSel = midnams[midnamList.selected] || MIDNAM_NONE;
      const outSel = outs[outList.selected] || OUT_NONE;

      let ch = parseInt(String(chBox.getValue() || "1").trim(), 10);
      if (!Number.isFinite(ch)) ch = 1;
      ch = Math.max(1, Math.min(16, ch));

      let name = String(nameBox.getValue() || "").trim() || "Machine";

      // Si le nom est générique, et qu’on a un MIDNAM, on “sauve” un nom propre.
      if (shouldAutofillName(name) && midSel !== MIDNAM_NONE)
      {
        try
        {
          const dev = model.peekMidnamDeviceName(midSel);
          if (dev) name = dev;
        }
        catch { }
      }

      const payload = {
        name,
        midnamFile: (midSel === MIDNAM_NONE ? null : midSel),
        out: (outSel === OUT_NONE ? null : outSel),
        channel: ch
      };

      let saved = null;

      if (_editMode === "edit" && _editId)
      {
        saved = model.machines.update(_editId, payload);
        if (!saved)
        {
          setStatus("Erreur: update machine impossible.", "err");
          return;
        }
        model.machines.setActive(saved.id);
      }
      else
      {
        saved = model.machines.add(payload);
        if (!saved)
        {
          setStatus("Erreur: create machine impossible.", "err");
          return;
        }
        model.machines.setActive(saved.id);
      }

      _editMode = "view";
      _editId = saved.id;

      refreshMachinesList(saved.id);
      fillEditorFromMachine(saved);

      setStatus(
        `Machine sauvée: ${saved.name}\nMIDNAM=${saved.midnamFile || "-"} | OUT=${saved.out || "-"} | CH=${saved.channel}`,
        "ok"
      );

      machinesList.focus();
      screen.render();
    }

    function deleteSelectedMachine()
    {
      const m = getSelectedMachine();
      if (!m)
      {
        setStatus("Aucune machine à supprimer.", "warn");
        return;
      }

      askConfirm(`Supprimer la machine {bold}${m.name}{/bold} ?\nTape "oui" pour confirmer.`, function (err, value)
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "oui")
        {
          setStatus("Annulé.", "warn");
          return;
        }

        const ok = model.machines.remove(m.id);
        if (!ok)
        {
          setStatus("Erreur suppression machine.", "err");
          return;
        }

        refreshMachinesList(null);

        const list = model.listMachines();
        if (list.length)
        {
          // réactive la sélection
          setActiveFromSelection();
        }
        else
        {
          clearEditor("Plus aucune machine.");
        }

        setStatus("Machine supprimée.", "ok");
      });
    }

    function cancelEdit()
    {
      if (_editMode === "create")
      {
        const active = model.getActiveMachine();
        if (active)
        {
          _editMode = "view";
          _editId = active.id;
          fillEditorFromMachine(active);
        }
        else clearEditor("Aucune machine.");
      }
      else if (_editMode === "edit")
      {
        const m = _editId ? model.machines.getById(_editId) : model.getActiveMachine();
        if (m)
        {
          _editMode = "view";
          _editId = m.id;
          fillEditorFromMachine(m);
        }
        else clearEditor("Machine introuvable.");
      }

      machinesList.focus();
      setStatus("Édition annulée.", "warn");
      screen.render();
    }

    function setLabelWithFocus(widget, baseLabel, focused)
    {
      widget.setLabel(` ${focused ? FOCUS_MARK + " " : ""}${baseLabel} `);
      const borderStyle = focused ? THEME.borderFocus : THEME.border;
      if (widget.style && widget.style.border) widget.style.border = borderStyle;
    }

    function refreshFocusMarkers()
    {
      setLabelWithFocus(machinesList, "Machines", screen.focused === machinesList);
      setLabelWithFocus(editor, `Editor (${_editMode})`, screen.focused === editor);
      setLabelWithFocus(status, "Status", screen.focused === status);

      if (!confirmModal.hidden) confirmModal.setLabel(` ${FOCUS_MARK} Confirm `);
      else confirmModal.setLabel(" Confirm ");
    }

    [machinesList, nameBox, midnamList, outList, chBox, status].forEach(w =>
    {
      w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
      w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
    });

    // Navigation TAB dans l’éditeur
    const edFocusables = [nameBox, midnamList, outList, chBox];
    let edFocusIndex = 0;

    function edFocusNext()
    {
      edFocusIndex = (edFocusIndex + 1) % edFocusables.length;
      edFocusables[edFocusIndex].focus();
      screen.render();
    }

    // Events list
    machinesList.on("select", () =>
    {
      if (_editMode === "edit" || _editMode === "create") return; // en plein edit, on ne touche pas
      setActiveFromSelection();
    });

    machinesList.on("highlight", () =>
    {
      if (_editMode === "edit" || _editMode === "create") return;
      setActiveFromSelection();
    });

    // Keys page
    kb.bindKey(["q"], () =>
    {
      if (!confirmModal.hidden) return;
      // Retour au browse (pas de drama)
      switchPage("browse");
    });

    kb.bindKey(["n"], () =>
    {
      if (!confirmModal.hidden) return;
      beginCreate();
    });

    kb.bindKey(["e"], () =>
    {
      if (!confirmModal.hidden) return;
      beginEdit();
    });

    kb.bindKey(["x", "delete"], () =>
    {
      if (!confirmModal.hidden) return;
      if (_editMode === "edit" || _editMode === "create")
      {
        setStatus("Tu édites. Annule (Esc) ou sauve (Ctrl+S) d’abord.", "warn");
        return;
      }
      deleteSelectedMachine();
    });

    kb.bindKey(["C-s"], () =>
    {
      if (!confirmModal.hidden) return;
      saveEditor();
    });

    // TAB: si focus est dans l’éditeur, on tourne; sinon on bascule list/editor
    kb.bindKey(["tab"], () =>
    {
      if (!confirmModal.hidden) return;

      if (screen.focused === machinesList)
      {
        nameBox.focus();
        edFocusIndex = 0;
      }
      else if (edFocusables.includes(screen.focused))
      {
        edFocusNext();
      }
      else
      {
        machinesList.focus();
      }
      refreshFocusMarkers();
      screen.render();
    });

    // Enter: valide juste le champ (pas save)
    nameBox.on("submit", () => edFocusNext());
    chBox.on("submit", () => edFocusNext());
    midnamList.key(["enter"], () => edFocusNext());
    outList.key(["enter"], () => edFocusNext());

    // ESC = annuler edit seulement (+ confirmation)
    kb.bindKey(["escape"], () =>
    {
      if (!confirmModal.hidden) { closeConfirm(true, null); return; }

      if (_editMode === "view")
      {
        setStatus('Rien à annuler. Utilise "q" pour revenir.', "warn");
        return;
      }

      askConfirm('Annuler les modifications ?\nTape "oui" pour confirmer.', function (err, value)
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "oui")
        {
          setStatus("Annulé.", "warn");
          return;
        }

        cancelEdit();
      });
    });

    // Quit hard
    kb.bindKey(["C-c"], () => quit());

    // Init
    refreshMidnamAndOutLists();
    refreshMachinesList(null);

    // Active machine => editor view
    if ((model.listMachines() || []).length)
    {
      const active = model.getActiveMachine() || getSelectedMachine();
      if (active)
      {
        _editMode = "view";
        _editId = active.id;
        fillEditorFromMachine(active);
      }
    }
    else clearEditor("Aucune machine.");

    machinesList.focus();
    refreshFocusMarkers();
    screen.render();

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { confirmModal.hide(); } catch { }
    };
  }

  // -------------------- Setlist Page --------------------

  function buildSetlistPage()
  {
    const kb = makeKeyBinder();

    const THEME = {
      border: { fg: "white" },
      borderFocus: { fg: "cyan" }
    };

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE — SETLIST ",
      style: { border: THEME.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 1,
      height: 3,
      width: "100%-2",
      tags: true,
      content:
        "{bold}↑↓{/bold} select | {bold}Enter{/bold} recall | {bold}a{/bold} save draft | {bold}r{/bold} rename | {bold}d{/bold} delete | {bold}q{/bold} back"
    });

    const setlistInfo = blessed.box({
      parent: frame,
      top: 3,
      left: 1,
      height: 3,
      width: "100%-2",
      tags: true,
      border: "line",
      label: " Setlist ",
      style: { border: THEME.border }
    });

    const entriesList = blessed.list({
      parent: frame,
      top: 6,
      left: 1,
      width: "50%-1",
      height: "100%-10",
      border: "line",
      label: " Entries ",
      keys: true,
      vi: true,
      tags: true,
      style: { border: THEME.border, selected: { inverse: true } }
    });

    const preview = blessed.box({
      parent: frame,
      top: 6,
      left: "50%",
      width: "50%-2",
      height: "100%-10",
      border: "line",
      label: " Preview ",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: THEME.border },
      padding: { left: 1, right: 1 }
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      height: 3,
      width: "100%-2",
      border: "line",
      label: " Status ",
      tags: true,
      style: { border: THEME.border },
      padding: { left: 1, right: 1 },
      content: "Setlist mode."
    });

    const inputModal = blessed.box({
      parent: frame,
      top: "center",
      left: "center",
      width: "70%",
      height: 9,
      border: "line",
      label: " Input ",
      tags: true,
      hidden: true,
      style: { border: THEME.borderFocus },
      padding: { left: 1, right: 1 }
    });

    const inputQuestion = blessed.box({
      parent: inputModal,
      top: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: ""
    });

    const inputBox = blessed.textbox({
      parent: inputModal,
      top: 2,
      left: 0,
      height: 3,
      width: "100%",
      border: "line",
      inputOnFocus: true,
      keys: true,
      vi: true
    });

    blessed.box({
      parent: inputModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}Enter{/bold} valider | {bold}Esc{/bold} annuler"
    });

    let _inputCallback = null;

    function askInput(question, initialValue, cb)
    {
      if (!inputModal || !inputModal.parent)
      {
        try { cb && cb(new Error("input modal not available"), null); } catch { }
        return;
      }

      _inputCallback = cb;
      inputQuestion.setContent(question || "Input:");
      inputBox.setValue(initialValue || "");

      inputModal.show();
      inputBox.focus();
      inputBox.readInput();
      screen.render();
    }

    function closeInputModal(cancelled, value)
    {
      try { inputModal.hide(); } catch { }

      const cb = _inputCallback;
      _inputCallback = null;

      try { entriesList.focus(); } catch { }
      screen.render();

      if (cb) cb(cancelled ? new Error("cancelled") : null, value);
    }

    inputBox.on("submit", (value) => closeInputModal(false, value));
    inputBox.key(["escape"], () => closeInputModal(true, null));

    function setStatus(text, level)
    {
      let prefix = "";
      if (level === "ok") prefix = "{green-fg}[OK]{/green-fg} ";
      else if (level === "warn") prefix = "{yellow-fg}[WARN]{/yellow-fg} ";
      else if (level === "err") prefix = "{red-fg}[ERR]{/red-fg} ";
      status.setContent(prefix + text);
      screen.render();
    }

    function refreshSetlistHeader()
    {
      const s = model.getActiveSetlist();
      const name = s ? s.name : "<none>";
      setlistInfo.setContent(`Active: {bold}${name}{/bold}\n${model.draftGetSummary()}`);
    }

    function entryToLine(e, idx)
    {
      const n = e.routes ? e.routes.length : 0;
      return `${String(idx + 1).padStart(2, "0")} - ${e.name}  {gray-fg}[${n} route(s)]{/gray-fg}`;
    }

    function refreshPreview()
    {
      const entries = entriesList._entries || [];
      const e = entries[entriesList.selected];

      if (!e)
      {
        preview.setContent("<no entry>");
        screen.render();
        return;
      }

      const lines = [];
      lines.push(`{bold}${e.name}{/bold}`);
      lines.push("");

      if (!e.routes || !e.routes.length)
      {
        lines.push("<no routes>");
        preview.setContent(lines.join("\n"));
        screen.render();
        return;
      }

      e.routes.forEach((r) =>
      {
        const m = model.machines.getById(r.machineId);
        const mName = (m && m.name) ? m.name : r.machineId;

        const b = r.bankName || "Bank";
        const pc = (r.program == null) ? "?" : String(r.program);
        const p = r.patchName || "Patch";

        lines.push(`${mName}  ->  ${b}  ${pc}  ${p}`);
      });

      preview.setContent(lines.join("\n"));
      screen.render();
    }

    function refreshEntries()
    {
      const prevEntries = entriesList._entries || [];
      const prev = prevEntries[entriesList.selected];
      const prevId = prev ? prev.id : null;

      const entries = model.listEntries();
      const items = entries.map((e, i) => entryToLine(e, i));

      entriesList.setItems(items.length ? items : ["<no entries>"]);
      entriesList._entries = entries;

      let idx = 0;
      if (prevId)
      {
        const found = entries.findIndex(e => e.id === prevId);
        if (found >= 0) idx = found;
      }

      entriesList.select(entries.length ? idx : 0);

      refreshPreview();
      refreshSetlistHeader();
    }

    function getSelectedEntry()
    {
      const entries = entriesList._entries || [];
      return entries[entriesList.selected] || null;
    }

    // Events
    entriesList.on("highlight", () => refreshPreview());
    entriesList.key(["up", "down", "k", "j", "pageup", "pagedown"], () => refreshPreview());

    entriesList.key(["enter"], () =>
    {
      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("Aucune entrée.", "warn");
        return;
      }

      const r = model.recallEntry(e.id);
      setStatus(r.message, r.ok ? "ok" : "err");
      refreshEntries();
    });

    kb.bindKey(["a"], () =>
    {
      if (!model.draft.routes.length)
      {
        setStatus("Draft vide: utilise Browse + a pour ajouter des routes.", "warn");
        return;
      }

      askInput("Nom de l'entrée (cue) ?", "", (err, value) =>
      {
        if (err) return;

        const r = model.commitDraftAsEntry(String(value || "").trim() || "Entry");
        setStatus(r.message, r.ok ? "ok" : "err");
        refreshEntries();
      });
    });

    kb.bindKey(["r"], () =>
    {
      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("Aucune entrée.", "warn");
        return;
      }

      askInput("Nouveau nom ?", e.name, (err, value) =>
      {
        if (err) return;

        const name = String(value || "").trim();
        if (!name)
        {
          setStatus("Nom vide: annulé.", "warn");
          return;
        }

        const ok = model.renameEntry(e.id, name);
        setStatus(ok ? "Renommé." : "Erreur rename.", ok ? "ok" : "err");
        refreshEntries();
      });
    });

    kb.bindKey(["d"], () =>
    {
      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("Aucune entrée.", "warn");
        return;
      }

      askInput(`Supprimer "${e.name}" ? Tape "oui"`, "", (err, value) =>
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "oui")
        {
          setStatus("Annulé.", "warn");
          return;
        }

        const ok = model.deleteEntry(e.id);
        setStatus(ok ? "Supprimé." : "Erreur delete.", ok ? "ok" : "err");
        refreshEntries();
      });
    });

    kb.bindKey(["q", "escape"], () => switchPage("browse"));
    kb.bindKey(["C-c"], () => quit());

    refreshSetlistHeader();
    refreshEntries();

    entriesList.focus();
    screen.render();

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { inputModal.hide(); } catch { }
    };
  }

  // Start on browse
  switchPage("browse");
};
