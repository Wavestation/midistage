// app.js
"use strict";

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const blessed = require("blessed");

const { Model } = require("../core/model");

module.exports = function startApp(midnamDir, io)
{
  const screen = blessed.screen({
    smartCSR: true,
    title: "MIDISTAGE :)",
    // blessed varies by version. Force stable behavior.
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


// -------------------- Settings store (data/settings.json) --------------------
// Option A: outside Model. Persistent UI/ergonomics settings.
const SETTINGS_PATH = path.join(__dirname, "..", "data", "settings.json");
const DEFAULT_SETTINGS = { ui: { autorecallOnScroll: false } };

function deepMerge(dst, src)
{
  if (!src || typeof src !== "object") return dst;
  for (const k of Object.keys(src))
  {
    const v = src[k];
    if (v && typeof v === "object" && !Array.isArray(v))
    {
      if (!dst[k] || typeof dst[k] !== "object") dst[k] = {};
      deepMerge(dst[k], v);
    }
    else dst[k] = v;
  }
  return dst;
}

function atomicWriteJson(filePath, obj)
{
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function loadSettings()
{
  try
  {
    if (!fs.existsSync(SETTINGS_PATH))
    {
      atomicWriteJson(SETTINGS_PATH, DEFAULT_SETTINGS);
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const s = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), raw);
    try { atomicWriteJson(SETTINGS_PATH, s); } catch { }
    return s;
  }
  catch
  {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

let settings = loadSettings();

function getSetting(pathStr, fallback)
{
  try
  {
    const parts = String(pathStr || "").split(".").filter(Boolean);
    let cur = settings;
    for (const p of parts) cur = cur[p];
    return (cur === undefined) ? fallback : cur;
  }
  catch { return fallback; }
}

function setSetting(pathStr, value)
{
  const parts = String(pathStr || "").split(".").filter(Boolean);
  if (!parts.length) return;

  let cur = settings;
  for (let i = 0; i < parts.length - 1; i++)
  {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;

  try { atomicWriteJson(SETTINGS_PATH, settings); } catch { }
}

function runSystemctl(action)
{
  try
  {
    const p = child_process.spawn("sudo", ["/bin/systemctl", action], {
      stdio: "ignore",
      detached: true
    });
    p.unref();
    return true;
  }
  catch
  {
    return false;
  }
}

  // -------------------- UI Theme (global) --------------------
  const FOCUS_MARK = "◆";

  const THEME = {
    // Frames (main page border)
    frame: { border: { fg: "gray" } },
    frameFocus: { border: { fg: "cyan" } },

    // Panels / generic boxes
    panel: { border: { fg: "gray" } },
    panelFocus: { border: { fg: "cyan" } },

    // Header strip (“menu bar”)
    header: { fg: "white", bg: "blue" },

    // Lists
    list: {
      border: { fg: "gray" },
      item: { fg: "white" },
      selected: { fg: "black", bg: "cyan" },
      hover: { bg: "gray" }
    },

    // Inputs
    input: {
      border: { fg: "gray" },
      fg: "white",
      bg: "black"
    },

    // Modals
    modal: {
      border: { fg: "cyan" },
      fg: "white",
      bg: "black"
    }
  };

  function setLabelWithFocus(widget, baseLabel, focused)
  {
    widget.setLabel(` ${focused ? FOCUS_MARK + " " : ""}${baseLabel} `);
    const borderStyle = focused ? THEME.panelFocus.border : THEME.panel.border;
    if (widget.style && widget.style.border) widget.style.border = borderStyle;
  }

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
    else if (name === "ports") currentCleanup = buildMidiPortsPage();
    else if (name === "system") currentCleanup = buildSystemPage();
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

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE -- 2025~2026 MASAMI KOMURO @ FELONIA SOFTWARE ",
      style: { border: THEME.frame.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 0,              // FIX
      right: 0,
      height: 1,
      tags: true,
      style: THEME.header,
      content:
        "{bold}Tab{/bold} focus | {bold}Enter{/bold} send prog. change | {bold}s{/bold} search | {bold}l{/bold} setlist page | {bold}a{/bold} add->draft | {bold}m{/bold} machines mgmt menu | {bold}t{/bold} system menu"
    });

    // “Instruments” = machines.json
    const filesList = blessed.list({
      parent: frame,
      top: 3,
      left: 1,
      width: "33%-2",
      height: "100%-9",
      border: "line",
      label: " Instruments ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const banksList = blessed.list({
      parent: frame,
      top: 3,
      left: "33%",
      width: "34%-1",
      height: "100%-9",
      border: "line",
      label: " Banks ",
      keys: true,
      vi: true,
      style: THEME.list
    });

    const patchesList = blessed.list({
      parent: frame,
      top: 3,
      left: "67%",
      width: "33%-2",
      height: "100%-12",
      border: "line",
      label: " Patches ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
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
      style: THEME.input
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      right: 1,
      height: 3,
      border: "line",
      label: " Status ",
      content: "Select a machine (machines.json).",
      padding: { left: 1, right: 1 },
      tags: true,
      style: { border: THEME.panel.border }
    });

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
      const ch = m.channel ? `CH${m.channel}` : "CH?";

      let outTxt = "default";
      if (m.outSlot != null && model.midiports && typeof model.midiports.getSlot === "function")
      {
        const s = model.midiports.getSlot(m.outSlot);
        const n = String(m.outSlot).padStart(3, "0");
        const label = (s && s.label) ? String(s.label).trim() : `Slot ${n}`;
        const port = (s && s.port) ? String(s.port).trim() : "<unassigned>";
        outTxt = `S${n} ${label} -> ${port}`;
      }
      else if (m.out)
      {
        outTxt = m.out; // legacy
      }

      const mid = m.midnamFile ? m.midnamFile : "<no midnam>";
      const dev = tryPeekDeviceName(m.midnamFile);
      return `${m.name}  {gray-fg}[${outTxt} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}  {gray-fg}(${mid}){/gray-fg}`;
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
      style: THEME.modal,
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
      style: THEME.list
    });

    blessed.box({
      parent: midiModal,
      bottom: 0,
      left: 1,
      height: 2,
      width: "100%-2",
      tags: true,
      content: "{bold}↑↓{/bold} select | {bold}Enter{/bold} assign | {bold}Esc{/bold} cancel"
    });

    function openMidiPicker()
    {
      const active = model.getActiveMachine();
      if (!active)
      {
        setStatus("No active machine.", "warn");
        return;
      }

      const ports = midiDriver.listOutputs();
      if (!ports.length)
      {
        setStatus("No MIDI output detected.", "warn");
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
      setStatus(`Port assigned.\nMachine: ${m2.name}\nMIDI out: ${m2.out}`, "ok");

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
      setStatus(msg || "No instrument loaded.", "warn");
      screen.render();
    }

    function loadSelectedMachineInstrument()
    {
      const list = filesList._machines || [];
      const m = list[filesList.selected];

      if (!m)
      {
        clearLoadedInstrumentUI("No machine selected.");
        return;
      }

      try { model.machines.setActive(m.id); } catch { }

      if (!m.midnamFile)
      {
        clearLoadedInstrumentUI(`Active machine: ${m.name}\n(midnam: none) | ${model.draftGetSummary()}`);
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
        setStatus(`Draft updated.\nMachine: ${(m && m.name) ? m.name : "?"}\n${model.draftGetSummary()}`, "ok");
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

    // System settings
    kb.bindKey(["t"], () => switchPage("system"));
    // Go to Machines page
    kb.bindKey(["m"], () => switchPage("machines"));

    // MIDI out picker -- disabled
    // kb.bindKey(["o"], () => openMidiPicker());

    // Go to Setlist page
    kb.bindKey(["l"], () => switchPage("setlist"));

    // Go to MIDI Ports page -- not accessible from the main page
    // kb.bindKey(["p"], () => switchPage("ports"));

    // Quit -- not accessible ... TODO make it accessible only when launched in local terminal (no telnet, no serial)
    // kb.bindKey(["C-q", "C-c"], () => quit());

    // Init
    refreshMachinesList();
    filesList.focus();
    refreshFocusMarkers();
    screen.render();

    if ((filesList._machines || []).length) loadSelectedMachineInstrument();
    else clearLoadedInstrumentUI("No machines in machines.json.");

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
      style: { border: THEME.frame.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 0,              // FIX
      right: 0,
      height: 1,
      tags: true,
      style: THEME.header,
      content:
        "{bold}↑↓{/bold} select | {bold}n{/bold} new | {bold}e{/bold} edit | {bold}x{/bold} delete | {bold}Ctrl+S{/bold} save | {bold}Esc{/bold} cancel edit | {bold}p{/bold} ports | {bold}t{/bold} system | {bold}q{/bold} back"
    });

    const machinesList = blessed.list({
      parent: frame,
      top: 3,
      left: 1,
      width: "45%-2",
      height: "100%-9",
      border: "line",
      label: " Machines ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const editor = blessed.box({
      parent: frame,
      top: 3,
      left: "45%",
      width: "55%-2",
      height: "100%-9",
      border: "line",
      label: " Editor ",
      tags: true,
      style: { border: THEME.panel.border },
      padding: { left: 1, right: 1 }
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      right: 1,
      height: 3,
      border: "line",
      label: " Status ",
      padding: { left: 1, right: 1 },
      tags: true,
      style: { border: THEME.panel.border },
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
      style: THEME.modal,
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
      vi: true,
      style: THEME.input
    });

    blessed.box({
      parent: confirmModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}Enter{/bold} validate | {bold}Esc{/bold} cancel"
    });

    let _confirmCb = null;

    function askConfirm(question, cb)
    {
      _confirmCb = cb;
      confirmQuestion.setContent(question || 'Type "yes" to confirm');
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
      width: "100%-3",
      tags: true,
      content: "{bold}Display name{/bold}"
    });

    const nameBox = blessed.textbox({
      parent: editor,
      top: 1,
      left: 0,
      height: 3,
      width: "100%-3",
      border: "line",
      inputOnFocus: true,
      keys: true,
      vi: true,
      style: THEME.input
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
      width: "50%-10",
      height: "60%-3",
      border: "line",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const outLabel = blessed.box({
      parent: editor,
      top: 4,
      left: "50%-9",
      height: 1,
      width: "50%-1",
      tags: true,
      content: "{bold}MIDI Slot{/bold}"
    });

    const outList = blessed.list({
      parent: editor,
      top: 5,
      left: "50%-9",
      width: "50%+6",
      height: "60%-3",
      border: "line",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const chLabel = blessed.box({
      parent: editor,
      bottom: 6,
      left: 0,
      height: 1,
      width: "100%-3",
      tags: true,
      content: "{bold}MIDI channel (1..16){/bold}"
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
      vi: true,
      style: THEME.input
    });

    const help = blessed.box({
      parent: editor,
      bottom: 0,
      left: 0,
      height: 3,
      width: "100%-3",
      tags: true,
      content:
        "{bold}Tab{/bold} next | {bold}Ctrl+S{/bold} save | {bold}Esc{/bold} cancel edit"
    });

    // ---- Field focus: diamond + border highlight (editor) ----
    function setFieldLabel(labelBox, title, focused)
    {
      const mark = focused ? "{cyan-fg}◆{/cyan-fg} " : "  ";
      labelBox.setContent(`${mark}{bold}${title}{/bold}`);
    }

    function setBorderFocus(widget, focused)
    {
      if (!widget || !widget.style) return;
      if (!widget.style.border) widget.style.border = {};
      widget.style.border = focused ? THEME.panelFocus.border : THEME.panel.border;
    }

    function refreshEditorFieldFocus()
    {
      const f = screen.focused;

      const nameFocused   = (f === nameBox);
      const midnamFocused = (f === midnamList);
      const outFocused    = (f === outList);
      const chFocused     = (f === chBox);

      setFieldLabel(nameLabel,  "Display name",          nameFocused);
      setFieldLabel(midnamLabel,"MIDNAM",                midnamFocused);
      setFieldLabel(outLabel,   "MIDI Output",           outFocused);
      setFieldLabel(chLabel,    "MIDI channel (1..16)",  chFocused);

      setBorderFocus(nameBox,    nameFocused);
      setBorderFocus(midnamList, midnamFocused);
      setBorderFocus(outList,    outFocused);
      setBorderFocus(chBox,      chFocused);
    }

    // ---- Mode ----
    // view = consultation, edit = modify existing, create = new machine
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
      return !n || n === "new machine" || n === "machine";
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

      // MIDI OUT abstraction: choose a SLOT (midiports.json), not a physical port name.
      // Slot numbers are stored in machines.json as "outSlot".
      const slots = (model.midiports && typeof model.midiports.listSlots === "function")
        ? model.midiports.listSlots()
        : [];

      // First line = none
      const items = [OUT_NONE].concat(slots.map(s =>
      {
        const n = String(s.slot).padStart(3, "0");
        const label = (s.label && String(s.label).trim()) ? String(s.label).trim() : `Slot ${n}`;
        const port = (s.port && String(s.port).trim()) ? String(s.port).trim() : "<unassigned>";
        return `S${n}  ${label}  {gray-fg}-> ${port}{/gray-fg}`;
      }));

      outList.setItems(items);
      outList._slots = [null].concat(slots); // index-aligned with items
    }

    function machineToLine(m, withId)
    {
      const ch = m.channel ? `CH${m.channel}` : "CH?";

      // Prefer slot abstraction (outSlot) when present.
      let outTxt = "default";
      if (m.outSlot != null && model.midiports && typeof model.midiports.getSlot === "function")
      {
        const s = model.midiports.getSlot(m.outSlot);
        const n = String(m.outSlot).padStart(3, "0");
        const label = (s && s.label) ? String(s.label).trim() : `Slot ${n}`;
        const port = (s && s.port) ? String(s.port).trim() : "<unassigned>";
        outTxt = `S${n} ${label} -> ${port}`;
      }
      else if (m.out)
      {
        // Backward-compat: older machines.json stored the physical port name in "out".
        outTxt = m.out;
      }

      const mid = m.midnamFile ? m.midnamFile : "<no midnam>";
      let dev = "?";
      try { dev = model.peekMidnamDeviceName(m.midnamFile); } catch { dev = "?"; }

      const idPart = withId ? `  {gray-fg}(${m.id}){/gray-fg}` : "";
      return `${m.name}  {gray-fg}[${outTxt} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}  {gray-fg}(${mid}){/gray-fg}${idPart}`;
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

    // IMPORTANT: do not touch _editMode here (or you sabotage yourself).
    function fillEditorFromMachine(m)
    {
      if (!m) { clearEditor("Invalid machine."); return; }

      nameBox.setValue(m.name || "");
      chBox.setValue(String(m.channel || 1));

      const midnams = midnamList._midnams || [MIDNAM_NONE];
      const slots = outList._slots || [null];

      const mid = m.midnamFile || MIDNAM_NONE;
      let mi = midnams.findIndex(x => x === mid);
      if (mi < 0) mi = 0;
      midnamList.select(mi);

      // Slot selection (preferred). Fallback to legacy "out" if no outSlot.
      let oi = 0;

      if (m.outSlot != null)
      {
        const idx = slots.findIndex(s => s && s.slot === m.outSlot);
        if (idx >= 0) oi = idx;
      }
      else if (m.out)
      {
        // Try to match legacy out (physical port) by finding a slot pointing to it.
        const idx = slots.findIndex(s => s && s.port === m.out);
        if (idx >= 0) oi = idx;
      }

      outList.select(Math.max(0, oi));

      _editId = m.id;
      screen.render();
    }

    function setActiveFromSelection()
    {
      const m = getSelectedMachine();
      if (!m)
      {
        setStatus("No machine.", "warn");
        return;
      }

      try { model.machines.setActive(m.id); } catch { }
      _editMode = "view";
      _editId = m.id;
      fillEditorFromMachine(m);
      setStatus(`Active machine: ${m.name}`, "ok");
    }

    function beginCreate()
    {
      refreshMidnamAndOutLists();

      _editMode = "create";
      _editId = null;

      nameBox.setValue("New machine");
      chBox.setValue("1");
      midnamList.select(0);
      outList.select(0);

      nameBox.focus();
      setStatus("Create mode: fill fields, then Ctrl+S to save.", "ok");
      screen.render();
    }

    function beginEdit()
    {
      refreshMidnamAndOutLists();

      const m = getSelectedMachine() || model.getActiveMachine();
      if (!m)
      {
        setStatus("No machine to edit.", "warn");
        return;
      }

      _editId = m.id;
      fillEditorFromMachine(m);

      // IMPORTANT: after fill
      _editMode = "edit";
      nameBox.focus();
      setStatus(`Edit mode: ${m.name} (Ctrl+S to save).`, "ok");
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
        setStatus("Nothing to save (view mode).", "warn");
        return;
      }

      const midnams = midnamList._midnams || [MIDNAM_NONE];
      const slots = outList._slots || [null];

      const midSel = midnams[midnamList.selected] || MIDNAM_NONE;
      const slotSel = slots[outList.selected] || null;
let ch = parseInt(String(chBox.getValue() || "1").trim(), 10);
      if (!Number.isFinite(ch)) ch = 1;
      ch = Math.max(1, Math.min(16, ch));

      let name = String(nameBox.getValue() || "").trim() || "Machine";

      // If the name is generic and we have a MIDNAM, “save” a proper name.
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
        outSlot: (slotSel ? slotSel.slot : null),
        out: null, // legacy field cleared; actual routing is via outSlot
        channel: ch
      };

      let saved = null;

      if (_editMode === "edit" && _editId)
      {
        saved = model.machines.update(_editId, payload);
        if (!saved)
        {
          setStatus("Error: cannot update machine.", "err");
          return;
        }
        model.machines.setActive(saved.id);
      }
      else
      {
        saved = model.machines.add(payload);
        if (!saved)
        {
          setStatus("Error: cannot create machine.", "err");
          return;
        }
        model.machines.setActive(saved.id);
      }

      _editMode = "view";
      _editId = saved.id;

      refreshMachinesList(saved.id);
      fillEditorFromMachine(saved);

      setStatus(
        `Machine saved: ${saved.name}\nMIDNAM=${saved.midnamFile || "-"} | OUT=${saved.out || "-"} | CH=${saved.channel}`,
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
        setStatus("No machine to delete.", "warn");
        return;
      }

      askConfirm(`Delete machine {bold}${m.name}{/bold}?\nType "yes" to confirm.`, function (err, value)
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "yes")
        {
          setStatus("Cancelled.", "warn");
          return;
        }

        const ok = model.machines.remove(m.id);
        if (!ok)
        {
          setStatus("Error deleting machine.", "err");
          return;
        }

        refreshMachinesList(null);

        const list = model.listMachines();
        if (list.length)
        {
          // re-activate selection
          setActiveFromSelection();
        }
        else
        {
          clearEditor("No machines left.");
        }

        setStatus("Machine deleted.", "ok");
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
        else clearEditor("No machine.");
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
        else clearEditor("Machine not found.");
      }

      machinesList.focus();
      setStatus("Edit cancelled.", "warn");
      screen.render();
    }

    function refreshFocusMarkers()
    {
      setLabelWithFocus(machinesList, "Machines", screen.focused === machinesList);
      setLabelWithFocus(editor, `Editor (${_editMode})`, screen.focused === editor);
      setLabelWithFocus(status, "Status", screen.focused === status);

      if (!confirmModal.hidden) confirmModal.setLabel(` ${FOCUS_MARK} Confirm `);
      else confirmModal.setLabel(" Confirm ");

      // NEW: editor field highlight (diamond + borders)
      refreshEditorFieldFocus();
    }

    [machinesList, nameBox, midnamList, outList, chBox, status].forEach(w =>
    {
      w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
      w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
    });

    // Also listen directly on editor widgets (more reliable)
    [nameBox, midnamList, outList, chBox].forEach(w =>
    {
      w.on("focus", () => { refreshEditorFieldFocus(); screen.render(); });
      w.on("blur", () => { refreshEditorFieldFocus(); screen.render(); });
    });

    // TAB navigation inside editor
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
      if (_editMode === "edit" || _editMode === "create") return;
      setActiveFromSelection();
    });

    machinesList.on("highlight", () =>
    {
      if (_editMode === "edit" || _editMode === "create") return;
      setActiveFromSelection();
    });

    // System settings
    kb.bindKey(["t"], () =>
    {
      if (!confirmModal.hidden) return;
      switchPage("system");
    });

    // Keys page
    kb.bindKey(["p"], () =>
    {
      if (!confirmModal.hidden) return;
      if (_editMode !== "view")
      {
        setStatus("You are editing. Cancel (Esc) or save (Ctrl+S) first.", "warn");
        return;
      }
      switchPage("ports");
    });

    // System settings
    kb.bindKey(["t"], () =>
    {
      if (!routesModal.hidden) return;
      if (!inputModal.hidden) return;
      switchPage("system");
    });


    kb.bindKey(["q"], () =>
    {
      if (!confirmModal.hidden) return;
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
        setStatus("You are editing. Cancel (Esc) or save (Ctrl+S) first.", "warn");
        return;
      }
      deleteSelectedMachine();
    });

    kb.bindKey(["C-s"], () =>
    {
      if (!confirmModal.hidden) return;
      saveEditor();
    });

    // TAB: if focus is in editor, rotate; otherwise switch list/editor
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

    // Enter: validate field (not save)
    nameBox.on("submit", () => edFocusNext());
    chBox.on("submit", () => edFocusNext());
    midnamList.key(["enter"], () => edFocusNext());
    outList.key(["enter"], () => edFocusNext());

    // ESC = cancel edit only (+ confirmation)
    kb.bindKey(["escape"], () =>
    {
      if (!confirmModal.hidden) { closeConfirm(true, null); return; }

      if (_editMode === "view")
      {
        setStatus('Nothing to cancel. Use "q" to go back.', "warn");
        return;
      }

      askConfirm('Cancel changes?\nType "yes" to confirm.', function (err, value)
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "yes")
        {
          setStatus("Cancelled.", "warn");
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
    else clearEditor("No machine.");

    machinesList.focus();
    refreshFocusMarkers();
    refreshEditorFieldFocus();
    screen.render();

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { confirmModal.hide(); } catch { }
    };
  }


  // -------------------- MIDI Ports Page --------------------

  function buildMidiPortsPage()
  {
    const midiDriver = require("../midi/driver");
    const kb = makeKeyBinder();

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE — MIDI PORTS ",
      style: { border: THEME.frame.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 0,
      right: 0,
      height: 2,
      tags: true,
      style: THEME.header,
      content:
        "{bold}Tab{/bold} focus | {bold}Enter{/bold} assign output -> slot | {bold}r{/bold} rename slot | {bold}c{/bold} clear | {bold}s{/bold} save | {bold}t{/bold} system | {bold}q{/bold} back"
    });

    const slotsList = blessed.list({
      parent: frame,
      top: 3,
      left: 1,
      width: "45%-2",
      height: "100%-9",
      border: "line",
      label: " Slots ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const outsList = blessed.list({
      parent: frame,
      top: 3,
      left: "45%",
      width: "55%-2",
      height: "100%-13",
      border: "line",
      label: " Physical outputs ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const info = blessed.box({
      parent: frame,
      bottom: 4,
      left: "45%",
      width: "55%-2",
      height: 4,
      border: "line",
      label: " Slot info ",
      tags: true,
      padding: { left: 1, right: 1 },
      style: { border: THEME.panel.border },
      content: ""
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
      style: { border: THEME.panel.border },
      padding: { left: 1, right: 1 },
      content: "MIDI ports."
    });

    // ------- Input modal (rename) -------

    const inputModal = blessed.box({
      parent: frame,
      top: "center",
      left: "center",
      width: "70%",
      height: 9,
      border: "line",
      label: " Rename ",
      tags: true,
      hidden: true,
      style: THEME.modal,
      padding: { left: 1, right: 1 }
    });

    const inputQuestion = blessed.box({
      parent: inputModal,
      top: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "Slot label:"
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
      vi: true,
      style: THEME.input
    });

    blessed.box({
      parent: inputModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}Enter{/bold} validate | {bold}Esc{/bold} cancel"
    });

    let _inputCb = null;

    function askLabel(initial, cb)
    {
      _inputCb = cb;
      inputBox.setValue(initial || "");
      inputModal.show();
      inputBox.focus();
      inputBox.readInput();
      refreshFocusMarkers();
      screen.render();
    }

    function closeLabel(cancelled, value)
    {
      try { inputModal.hide(); } catch { }

      const cb = _inputCb;
      _inputCb = null;

      try { slotsList.focus(); } catch { }
      refreshFocusMarkers();
      screen.render();

      if (cb) cb(cancelled ? new Error("cancelled") : null, value);
    }

    inputBox.on("submit", (value) => closeLabel(false, value));
    inputBox.key(["escape"], () => closeLabel(true, null));

    // ------- Helpers -------

    function setStatus(text, level)
    {
      let prefix = "";
      if (level === "ok") prefix = "{green-fg}[OK]{/green-fg} ";
      else if (level === "warn") prefix = "{yellow-fg}[WARN]{/yellow-fg} ";
      else if (level === "err") prefix = "{red-fg}[ERR]{/red-fg} ";
      status.setContent(prefix + text);
      screen.render();
    }

    function slotToLine(s)
    {
      const num = String(s.slot).padStart(3, "0");
      const label = s.label ? s.label : `Slot ${num}`;
      const port = s.port ? s.port : "-";
      return `${num}  {cyan-fg}${label}{/cyan-fg}  {gray-fg}=> ${port}{/gray-fg}`;
    }

    function refreshSlots(keepSlot)
    {
      const slots = model.midiports ? model.midiports.listSlots() : [];
      slotsList._slots = slots;

      if (!slots.length)
      {
        slotsList.setItems(["<no slots>"]);
        slotsList.select(0);
        return;
      }

      slotsList.setItems(slots.map(slotToLine));

      let idx = 0;
      if (keepSlot != null)
      {
        const found = slots.findIndex(x => x.slot === keepSlot);
        if (found >= 0) idx = found;
      }
      slotsList.select(idx);
    }

    function refreshOuts()
    {
      const ports = midiDriver.listOutputs ? midiDriver.listOutputs() : [];
      const items = ["<none>"].concat(ports);
      outsList._ports = items;
      outsList.setItems(items);
      outsList.select(0);
    }

    function getSelectedSlot()
    {
      const slots = slotsList._slots || [];
      return slots[slotsList.selected] || null;
    }

    function refreshInfo()
    {
      const s = getSelectedSlot();
      if (!s)
      {
        info.setContent("<no slot>");
        return;
      }

      const num = String(s.slot).padStart(3, "0");
      const label = s.label ? s.label : `Slot ${num}`;
      const port = s.port ? s.port : "-";

      info.setContent(
        `{bold}${num} - ${label}{/bold}\n` +
        `{gray-fg}Assigned port:{/gray-fg} ${port}\n` +
        `{gray-fg}Tip:{/gray-fg} Enter on right list to assign`
      );

      // try to auto-select the assigned port
      const ports = outsList._ports || [];
      const idx = s.port ? ports.findIndex(x => x === s.port) : 0;
      outsList.select(idx >= 0 ? idx : 0);
    }

    function refreshFocusMarkers()
    {
      setLabelWithFocus(slotsList, "Slots", screen.focused === slotsList);
      setLabelWithFocus(outsList, "Physical outputs", screen.focused === outsList);

      if (!inputModal.hidden) inputModal.setLabel(` ${FOCUS_MARK} Rename `);
      else inputModal.setLabel(" Rename ");
    }

    // ------- Actions -------

    function assignSelectedPort()
    {
      const s = getSelectedSlot();
      if (!s) return;

      const ports = outsList._ports || ["<none>"];
      const p = ports[outsList.selected];

      const slotNum = s.slot;

      if (!model.midiports || !model.midiports.setPort)
      {
        setStatus("Missing model.midiports.setPort().", "err");
        return;
      }

      const val = (p === "<none>") ? null : p;
      model.midiports.setPort(slotNum, val);

      setStatus(`Slot ${String(slotNum).padStart(3,"0")} assigned to: ${val || "-"}`, "ok");
      refreshSlots(slotNum);
      refreshInfo();
      refreshFocusMarkers();
      screen.render();
    }

    function clearSelectedPort()
    {
      const s = getSelectedSlot();
      if (!s) return;

      model.midiports.setPort(s.slot, null);
      setStatus("Cleared.", "ok");
      refreshSlots(s.slot);
      refreshInfo();
      refreshFocusMarkers();
      screen.render();
    }

    function renameSelectedSlot()
    {
      const s = getSelectedSlot();
      if (!s) return;

      const num = String(s.slot).padStart(3, "0");
      const current = s.label ? s.label : `Slot ${num}`;

      askLabel(current, (err, value) =>
      {
        if (err) return;
        const name = String(value || "").trim();
        model.midiports.setLabel(s.slot, name);
        setStatus("Renamed.", "ok");
        refreshSlots(s.slot);
        refreshInfo();
        refreshFocusMarkers();
        screen.render();
      });
    }

    function save()
    {
      if (!model.midiports || !model.midiports.save)
      {
        setStatus("Missing model.midiports.save().", "err");
        return;
      }
      try
      {
        model.midiports.save();
        setStatus("Saved midiports.json.", "ok");
      }
      catch (e)
      {
        setStatus(`Save error: ${e.message}`, "err");
      }
    }

    // ------- Focus management -------

    const focusables = [slotsList, outsList];
    let focusIndex = 0;

    kb.bindKey(["tab"], () =>
    {
      if (!inputModal.hidden) return;

      focusIndex = (focusIndex + 1) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    });

    kb.bindKey(["S-tab"], () =>
    {
      if (!inputModal.hidden) return;

      focusIndex = (focusIndex - 1 + focusables.length) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    });

    [slotsList, outsList].forEach(w =>
    {
      w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
      w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
    });

    // Selection changes
    slotsList.on("highlight", () => { refreshInfo(); screen.render(); });
    slotsList.on("select", () => { refreshInfo(); screen.render(); });

    outsList.key(["enter"], () =>
    {
      if (!inputModal.hidden) return;
      assignSelectedPort();
    });

    kb.bindKey(["r"], () =>
    {
      if (!inputModal.hidden) return;
      renameSelectedSlot();
    });

    kb.bindKey(["c"], () =>
    {
      if (!inputModal.hidden) return;
      clearSelectedPort();
    });

    kb.bindKey(["s"], () =>
    {
      if (!inputModal.hidden) return;
      save();
    });

    kb.bindKey(["q", "escape"], () =>
    {
      if (!inputModal.hidden) { closeLabel(true, null); return; }
      switchPage("machines"); // aller aux machines
      //switchPage("browse");   // ou au browser
    });

    kb.bindKey(["C-c"], () => quit());

    // System settings
    kb.bindKey(["t"], () =>
    {
      if (!inputModal.hidden) return;
      switchPage("system");
    });

    // Init
    refreshOuts();
    refreshSlots(1);
    slotsList.focus();
    refreshInfo();
    refreshFocusMarkers();
    screen.render();

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { inputModal.hide(); } catch { }
    };
  }

  // -------------------- Setlist Page --------------------

  function buildSetlistPage()
  {
    const kb = makeKeyBinder();

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      border: "line",
      label: " MIDISTAGE — SETLIST ",
      style: { border: THEME.frame.border }
    });

    const header = blessed.box({
      parent: frame,
      top: 0,
      left: 0,              // FIX
      right: 0,
      height: 3,
      tags: true,
      style: THEME.header,
      content:
        "{bold}Tab{/bold} focus | {bold}Enter{/bold} recall | {bold}t{/bold} system menu | {bold}Esc / q{/bold} back \n" + 
        "{bold}{yellow-fg}ENTRY CMDS   :{/yellow-fg} a{/bold} save draft | {bold}p{/bold} paste draft | {bold}e{/bold} edit routes | {bold}c{/bold} copy entry | {bold}r{/bold} rename entry | {bold}d{/bold} delete entry | {bold}v/b{/bold} move entry up/down\n" +
        "{bold}{yellow-fg}SETLIST CMDS :{/yellow-fg} n{/bold} new setlist | {bold}x{/bold} rename setlist | {bold}w{/bold} delete setlist"
    });

    const setlistInfo = blessed.box({
      parent: frame,
      top: 3,
      left: 1,
      right: 0,
      height: 3,
      tags: true,
      border: "line",
      label: " Setlist ",
      style: { border: THEME.panel.border }
    });

    const setlistsList = blessed.list({
      parent: frame,
      top: 6,
      left: 1,
      width: "25%-1",
      height: "100%-12",
      border: "line",
      label: " Setlists ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const entriesList = blessed.list({
      parent: frame,
      top: 6,
      left: "25%",
      width: "35%-1",
      height: "100%-12",
      border: "line",
      label: " Entries ",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    const preview = blessed.box({
      parent: frame,
      top: 6,
      left: "60%",
      width: "40%-1",
      height: "100%-12",
      border: "line",
      label: " Preview ",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: THEME.panel.border },
      padding: { left: 1, right: 1 }
    });

    const status = blessed.box({
      parent: frame,
      bottom: 1,
      left: 1,
      right: 0,
      height: 3,
      border: "line",
      label: " Status ",
      tags: true,
      style: { border: THEME.panel.border },
      padding: { left: 1, right: 1 },
      content: "Setlist mode."
    });

    // ------- Input modal (generic) -------

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
      style: THEME.modal,
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
      vi: true,
      style: THEME.input
    });

    blessed.box({
      parent: inputModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}Enter{/bold} validate | {bold}Esc{/bold} cancel"
    });

    let _inputCallback = null;

    // ------- Routes editor modal -------

    const routesModal = blessed.box({
      parent: frame,
      top: "center",
      left: "center",
      width: "80%",
      height: "70%",
      border: "line",
      label: " Routes ",
      tags: true,
      hidden: true,
      style: THEME.modal,
      padding: { left: 1, right: 1 }
    });

    const routesTitle = blessed.box({
      parent: routesModal,
      top: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: ""
    });

    const routesList = blessed.list({
      parent: routesModal,
      top: 2,
      left: 0,
      width: "100%",
      height: "100%-4",
      border: "line",
      keys: true,
      vi: true,
      tags: true,
      style: THEME.list
    });

    blessed.box({
      parent: routesModal,
      bottom: 0,
      left: 0,
      height: 2,
      width: "100%",
      tags: true,
      content: "{bold}↑↓{/bold} select | {bold}Enter{/bold} replace from Draft | {bold}Del{/bold} remove route | {bold}Esc{/bold} close"
    });



function refreshFocusMarkers()
{
  setLabelWithFocus(setlistsList, "Setlists", screen.focused === setlistsList);
  setLabelWithFocus(entriesList, "Entries", screen.focused === entriesList);

  if (!inputModal.hidden) inputModal.setLabel(` ${FOCUS_MARK} Input `);
  else inputModal.setLabel(" Input ");

  if (!routesModal.hidden) routesModal.setLabel(` ${FOCUS_MARK} Routes `);
  else routesModal.setLabel(" Routes ");
}
    let _routesEntryId = null;

    // ------- Focus markers (NEW for Setlists/Entries) -------
    function refreshFocusMarkers()
    {
      setLabelWithFocus(setlistsList, "Setlists", screen.focused === setlistsList);
      setLabelWithFocus(entriesList, "Entries", screen.focused === entriesList);

      // optionnel (mais cohérent)
      setLabelWithFocus(preview, "Preview", screen.focused === preview);
      setLabelWithFocus(status, "Status", screen.focused === status);

      if (!inputModal.hidden) inputModal.setLabel(` ${FOCUS_MARK} Input `);
      else inputModal.setLabel(" Input ");

      if (!routesModal.hidden) routesModal.setLabel(` ${FOCUS_MARK} Routes `);
      // sinon on garde le label dynamique déjà posé ailleurs (Routes (n))
    }

    [setlistsList, entriesList, preview, status].forEach(w =>
    {
      w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
      w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
    });

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
      refreshFocusMarkers();
      screen.render();
    }

    function closeInputModal(cancelled, value)
    {
      try { inputModal.hide(); } catch { }

      const cb = _inputCallback;
      _inputCallback = null;

      try { entriesList.focus(); } catch { }
      refreshFocusMarkers();
      screen.render();

      if (cb) cb(cancelled ? new Error("cancelled") : null, value);
    }

    inputBox.on("submit", (value) => closeInputModal(false, value));
    inputBox.key(["escape"], () => closeInputModal(true, null));

    function formatRouteLine(r)
    {
      const m = model.machines.getById(r.machineId);
      const mName = (m && m.name) ? m.name : r.machineId;

      const out = (m && m.out) ? m.out : "default";
      const ch = (m && m.channel) ? `CH${m.channel}` : "CH?";

      const bank = r.bankName || "Bank";
      const msb = (r.msb == null) ? "-" : String(r.msb);
      const lsb = (r.lsb == null) ? "-" : String(r.lsb);
      const pc  = (r.program == null) ? "?" : String(r.program);
      const p   = r.patchName || "Patch";

      return (
        `{cyan-fg}${mName}{/cyan-fg} {gray-fg}[${out} ${ch}]{/gray-fg}  ` +
        `{yellow-fg}${bank}{/yellow-fg} {gray-fg}(MSB ${msb} / LSB ${lsb}){/gray-fg}  ` +
        `{magenta-fg}PC ${pc}{/magenta-fg}  ` +
        `{white-fg}${p}{/white-fg}`
      );
    }

    function openRoutesEditor(entryId)
    {
      const e = (entriesList._entries || []).find(x => x.id === entryId) || getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      _routesEntryId = e.id;

      routesTitle.setContent(
        `{bold}${e.name}{/bold}\n` +
        `{gray-fg}Tip: build Draft in Browse (a), then Enter here to apply per machine.{/gray-fg}`
      );

      const routes = Array.isArray(e.routes) ? e.routes : [];
      routesList._routes = routes;

      const items = routes.length ? routes.map(formatRouteLine) : ["<no routes>"];
      routesList.setItems(items);
      routesList.select(0);

      routesModal.setLabel(` Routes {gray-fg}(${routes.length}){/gray-fg} `);
      routesModal.show();
      routesList.focus();
      refreshFocusMarkers();
      screen.render();
    }

    function closeRoutesEditor()
    {
      _routesEntryId = null;
      try { routesModal.hide(); } catch { }
      try { entriesList.focus(); } catch { }
      refreshFocusMarkers();
      screen.render();
    }

    routesList.key(["escape"], () => closeRoutesEditor());

    routesList.key(["enter"], () =>
    {
      const entryId = _routesEntryId;
      const routes = routesList._routes || [];
      const r = routes[routesList.selected];

      if (!entryId || !r)
      {
        setStatus("No route selected.", "warn");
        return;
      }

      if (!model.updateEntryRouteFromDraft)
      {
        setStatus("Missing model.updateEntryRouteFromDraft().", "err");
        return;
      }

      const res = model.updateEntryRouteFromDraft(entryId, r.machineId);
      setStatus(res && res.message ? res.message : (res?.ok ? "Route updated." : "Route update failed."), res?.ok ? "ok" : "err");

      // refresh entry list & preview and reopen modal on same entry
      refreshEntries(entryId);
      openRoutesEditor(entryId);
    });

    routesList.key(["delete", "backspace"], () =>
    {
      const entryId = _routesEntryId;
      const routes = routesList._routes || [];
      const r = routes[routesList.selected];

      if (!entryId || !r)
      {
        setStatus("No route selected.", "warn");
        return;
      }

      if (!model.removeEntryRoute)
      {
        setStatus("Missing model.removeEntryRoute().", "err");
        return;
      }

      const ok = model.removeEntryRoute(entryId, r.machineId);
      setStatus(ok ? "Route removed." : "Route remove failed.", ok ? "ok" : "err");

      refreshEntries(entryId);
      openRoutesEditor(entryId);
    });

    // ------- Common helpers -------

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

    function setlistToLine(s)
    {
      const n = s.entries ? s.entries.length : 0;
      const active = model.getActiveSetlist();
      const isActive = active && active.id === s.id;
      const mark = isActive ? "{cyan-fg}◆{/cyan-fg} " : "  ";
      return `${mark}${s.name}  {gray-fg}[${n} entries]{/gray-fg}`;
    }

    function refreshSetlists()
    {
      const list = model.listSetlists ? model.listSetlists() : [];
      setlistsList._setlists = list;

      if (!list.length)
      {
        setlistsList.setItems(["<no setlists>"]);
        setlistsList.select(0);
        return;
      }

      setlistsList.setItems(list.map(setlistToLine));

      const active = model.getActiveSetlist();
      let idx = 0;
      if (active)
      {
        const found = list.findIndex(x => x.id === active.id);
        if (found >= 0) idx = found;
      }
      setlistsList.select(idx);
    }

    function getSelectedSetlist()
    {
      const list = setlistsList._setlists || [];
      return list[setlistsList.selected] || null;
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
      // Uncomment to write entry name in the preview box
      // lines.push(`{bold}${e.name}{/bold}`);
      // lines.push("");

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

        const out = (m && m.out) ? m.out : "default";
        const ch  = (m && m.channel) ? `CH${m.channel}` : "CH?";

        const b = r.bankName || "Bank";
        const msb = (r.msb == null) ? "-" : String(r.msb);
        const lsb = (r.lsb == null) ? "-" : String(r.lsb);

        const pc = (r.program == null) ? "?" : String(r.program);
        const p = r.patchName || "Patch";

        lines.push(
          `{cyan-fg}${mName}{/cyan-fg} {gray-fg}[${out} ${ch}]{/gray-fg}  \n` +
          `{yellow-fg}${b}{/yellow-fg} {gray-fg}(MSB ${msb} / LSB ${lsb}){/gray-fg}  \n` +
          `{magenta-fg}PC ${pc}{/magenta-fg}  ` +
          `{white-fg}${p}{/white-fg}` +
          `\n`
        );
      });

      preview.setContent(lines.join("\n"));
      preview.setLabel(` Preview - ${e.name} `);
      screen.render();
    }

    function refreshEntries(keepEntryId)
    {
      const prevEntries = entriesList._entries || [];
      const prev = prevEntries[entriesList.selected];
      const prevId = keepEntryId || (prev ? prev.id : null);

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
      refreshSetlists();
    }

    function getSelectedEntry()
    {
      const entries = entriesList._entries || [];
      return entries[entriesList.selected] || null;
    }

    // Focus management for Setlist page
    const focusables = [setlistsList, entriesList];
    let focusIndex = 0;

    kb.bindKey(["tab"], () =>
    {
      if (!routesModal.hidden) return;
      if (!inputModal.hidden) return;

      focusIndex = (focusIndex + 1) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    });

    kb.bindKey(["S-tab"], () =>
    {
      if (!routesModal.hidden) return;
      if (!inputModal.hidden) return;

      focusIndex = (focusIndex - 1 + focusables.length) % focusables.length;
      focusables[focusIndex].focus();
      refreshFocusMarkers();
      screen.render();
    });


[setlistsList, entriesList].forEach(w =>
{
  w.on("focus", () => { refreshFocusMarkers(); screen.render(); });
  w.on("blur", () => { refreshFocusMarkers(); screen.render(); });
});

    // Events: setlists
    setlistsList.key(["enter"], () =>
    {
      if (!routesModal.hidden) return;

      const s = getSelectedSetlist();
      if (!s)
      {
        setStatus("No setlist.", "warn");
        return;
      }

      const ok = model.setActiveSetlist ? model.setActiveSetlist(s.id) : false;
      if (!ok)
      {
        setStatus("Cannot activate setlist (missing model.setActiveSetlist?).", "err");
        return;
      }

      setStatus(`Active setlist: ${s.name}`, "ok");
      refreshEntries(null);
      entriesList.focus();
      refreshFocusMarkers();
    });

    // Events: entries
    entriesList.on("highlight", () => refreshPreview());
    entriesList.key(["up", "down", "k", "j", "pageup", "pagedown"], () => {
      refreshPreview()

      // auto recall on scroll
      const aros = !!getSetting("ui.autorecallOnScroll", false);
      if (aros)
      {
        if (!routesModal.hidden) return;

        const e = getSelectedEntry();
        if (!e)
        {
          setStatus("No entry.", "warn");
          return;
        }

        const r = model.recallEntry(e.id);
        setStatus(r.message, r.ok ? "ok" : "err");
        refreshEntries(e.id);
      }
    });

    entriesList.key(["enter"], () =>
    {
      if (!routesModal.hidden) return;

      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      const r = model.recallEntry(e.id);
      setStatus(r.message, r.ok ? "ok" : "err");
      refreshEntries(e.id);
    });

    // Entry: add from draft
    kb.bindKey(["a"], () =>
    {
      if (!routesModal.hidden) return;

      if (!model.draft.routes.length)
      {
        setStatus("Draft is empty: use Browse + a to add routes.", "warn");
        return;
      }

      askInput("Entry (cue) name?", "", (err, value) =>
      {
        if (err) return;

        const r = model.commitDraftAsEntry(String(value || "").trim() || "Entry");
        setStatus(r.message, r.ok ? "ok" : "err");
        refreshEntries(null);
      });
    });

    // Entry: paste draft into selected entry (merge; confirm if overwrite)
    kb.bindKey(["p"], () =>
    {
      if (!routesModal.hidden) return;
      if (!inputModal.hidden) return;

      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      if (!model.pasteDraftIntoEntry)
      {
        setStatus("Missing model.pasteDraftIntoEntry().", "err");
        return;
      }

      const res = model.pasteDraftIntoEntry(e.id, { clearDraft: false });

      // If draft would overwrite existing routes, ask confirmation first.
      if (res && res.confirm)
      {
        const msg = res.message || 'Overwrite existing route(s)? Type "yes"';
        askInput(msg + 'Type "yes" to confirm.', "", (err, value) =>
        {
          if (err) return;
          const v = String(value || "").trim().toLowerCase();
          if (v !== "yes")
          {
            setStatus("Cancelled.", "warn");
            return;
          }

          const forced = model.pasteDraftIntoEntry(e.id, { clearDraft: false, force: true });
          setStatus(
            forced && forced.message ? forced.message : (forced?.ok ? "Pasted." : "Paste failed."),
            forced?.ok ? "ok" : "err"
          );
          refreshEntries(e.id);
        });
        return;
      }

      setStatus(res && res.message ? res.message : (res?.ok ? "Pasted." : "Paste failed."), res?.ok ? "ok" : "err");
      refreshEntries(e.id);
    });

    // Entry: edit routes (modal)
    kb.bindKey(["e"], () =>
    {
      if (!routesModal.hidden) return;
      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }
      openRoutesEditor(e.id);
    });

    // Entry: duplicate/copy
    kb.bindKey(["c"], () =>
    {
      if (!routesModal.hidden) return;

      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      if (!model.duplicateEntry)
      {
        setStatus("Cannot copy entry (missing model.duplicateEntry?).", "err");
        return;
      }

      const suggested = `${e.name} (copy)`;
      askInput("Copy entry: new name?", suggested, (err, value) =>
      {
        if (err) return;
        const name = String(value || "").trim() || suggested;

        const created = model.duplicateEntry(e.id, name);
        if (!created)
        {
          setStatus("Copy failed.", "err");
          return;
        }

        setStatus(`Copied: ${name}`, "ok");
        refreshEntries(created.id || null);
      });
    });

    // Entry: rename
    kb.bindKey(["r"], () =>
    {
      if (!routesModal.hidden) return;

      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      askInput("New name?", e.name, (err, value) =>
      {
        if (err) return;

        const name = String(value || "").trim();
        if (!name)
        {
          setStatus("Empty name: cancelled.", "warn");
          return;
        }

        const ok = model.renameEntry(e.id, name);
        setStatus(ok ? "Renamed." : "Rename error.", ok ? "ok" : "err");
        refreshEntries(e.id);
      });
    });

    // Entry: delete
    kb.bindKey(["d"], () =>
    {
      if (!routesModal.hidden) return;

      const e = getSelectedEntry();
      if (!e)
      {
        setStatus("No entry.", "warn");
        return;
      }

      askInput(`Delete "${e.name}"? Type "yes"`, "", (err, value) =>
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "yes")
        {
          setStatus("Cancelled.", "warn");
          return;
        }

        const ok = model.deleteEntry(e.id);
        setStatus(ok ? "Deleted." : "Delete error.", ok ? "ok" : "err");
        refreshEntries(null);
      });
    });

    // Entry: move up/down
    kb.bindKey(["v"], () =>
    {
      if (!routesModal.hidden) return;
      const e = getSelectedEntry();
      if (!e) return;

      if (!model.moveEntry)
      {
        setStatus("Missing model.moveEntry().", "err");
        return;
      }

      const ok = model.moveEntry(e.id, -1);
      if (!ok) setStatus("Move failed.", "err");
      refreshEntries(e.id);
    });

    kb.bindKey(["b"], () =>
    {
      if (!routesModal.hidden) return;
      const e = getSelectedEntry();
      if (!e) return;

      if (!model.moveEntry)
      {
        setStatus("Missing model.moveEntry().", "err");
        return;
      }

      const ok = model.moveEntry(e.id, +1);
      if (!ok) setStatus("Move failed.", "err");
      refreshEntries(e.id);
    });

    // Setlist: create
    kb.bindKey(["n"], () =>
    {
      if (!routesModal.hidden) return;

      askInput("New setlist name?", "", (err, value) =>
      {
        if (err) return;

        const name = String(value || "").trim() || "Setlist";
        if (!model.addSetlist)
        {
          setStatus("Cannot create setlist (missing model.addSetlist?).", "err");
          return;
        }

        model.addSetlist(name);
        setStatus(`Setlist created: ${name}`, "ok");
        refreshEntries(null);
        setlistsList.focus();
        refreshFocusMarkers();
      });
    });

    // Setlist: rename
    kb.bindKey(["x"], () =>
    {
      if (!routesModal.hidden) return;

      const s = getSelectedSetlist() || model.getActiveSetlist();
      if (!s)
      {
        setStatus("No setlist.", "warn");
        return;
      }

      askInput("Rename setlist:", s.name, (err, value) =>
      {
        if (err) return;

        const name = String(value || "").trim();
        if (!name)
        {
          setStatus("Empty name: cancelled.", "warn");
          return;
        }

        if (!model.renameSetlist)
        {
          setStatus("Cannot rename setlist (missing model.renameSetlist?).", "err");
          return;
        }

        const ok = model.renameSetlist(s.id, name);
        setStatus(ok ? "Setlist renamed." : "Rename error.", ok ? "ok" : "err");
        refreshEntries(null);
      });
    });

    // Setlist: delete
    kb.bindKey(["w"], () =>
    {
      if (!routesModal.hidden) return;

      const s = getSelectedSetlist() || model.getActiveSetlist();
      if (!s)
      {
        setStatus("No setlist.", "warn");
        return;
      }

      askInput(`Delete setlist "${s.name}"? Type "yes"`, "", (err, value) =>
      {
        if (err) return;

        const v = String(value || "").trim().toLowerCase();
        if (v !== "yes")
        {
          setStatus("Cancelled.", "warn");
          return;
        }

        if (!model.deleteSetlist)
        {
          setStatus("Cannot delete setlist (missing model.deleteSetlist?).", "err");
          return;
        }

        const ok = model.deleteSetlist(s.id);
        setStatus(ok ? "Setlist deleted." : "Delete error.", ok ? "ok" : "err");
        refreshEntries(null);
        setlistsList.focus();
        refreshFocusMarkers();
      });
    });

    kb.bindKey(["q"], () =>
    {
      if (!routesModal.hidden) { closeRoutesEditor(); return; }
      switchPage("browse");
    });

    kb.bindKey(["escape"], () =>
    {
      if (!routesModal.hidden) { closeRoutesEditor(); return; }
      switchPage("browse");
    });

    kb.bindKey(["C-c"], () => quit());

    refreshSetlistHeader();
    refreshSetlists();
    refreshEntries(null);

    setlistsList.focus();
    refreshFocusMarkers();
    screen.render();

    return function cleanup()
    {
      kb.unbindAllKeys();
      try { inputModal.hide(); } catch { }
      try { routesModal.hide(); } catch { }
    };
  }



// -------------------- System Settings Page --------------------

function buildSystemPage()
{
  const kb = makeKeyBinder();

  const frame = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: "line",
    label: " MIDISTAGE — SYSTEM SETTINGS ",
    style: { border: THEME.frame.border }
  });

  const header = blessed.box({
    parent: frame,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: THEME.header,
    content:
      "{bold}↑↓{/bold} select | {bold}Enter{/bold} apply | {bold}Esc / q{/bold} back "
  });

  const list = blessed.list({
    parent: frame,
    top: 2,
    left: 1,
    right: 1,
    height: "100%-8",
    border: "line",
    label: " Actions ",
    keys: true,
    vi: true,
    tags: true,
    style: THEME.list
  });

  const status = blessed.box({
    parent: frame,
    bottom: 1,
    left: 1,
    right: 1,
    height: 3,
    border: "line",
    label: " Status ",
    padding: { left: 1, right: 1 },
    tags: true,
    style: { border: THEME.panel.border },
    content: "System settings."
  });

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
    style: THEME.modal,
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
    vi: true,
    style: THEME.input
  });

  blessed.box({
    parent: confirmModal,
    bottom: 0,
    left: 0,
    height: 2,
    width: "100%",
    tags: true,
    content: "{bold}Enter{/bold} validate | {bold}Esc{/bold} cancel"
  });

  let _confirmAction = null;

  function setStatus(text, level)
  {
    let prefix = "";
    if (level === "ok") prefix = "{green-fg}[OK]{/green-fg} ";
    else if (level === "warn") prefix = "{yellow-fg}[WARN]{/yellow-fg} ";
    else if (level === "err") prefix = "{red-fg}[ERR]{/red-fg} ";
    status.setContent(prefix + text);
    screen.render();
  }

  function buildItems()
  {
    const ar = !!getSetting("ui.autorecallOnScroll", false);
    list.setItems([
      `UI: Auto-recall setlist entry on scroll: {bold}${ar ? "{green-fg}ON{/green-fg}" : "{red-fg}OFF{/red-fg}"}{/bold}`,
      "{yellow-fg}Machine: Hardware reboot!{/yellow-fg}",
      "{red-fg}Machine: Hardware poweroff!{/red-fg}"
    ]);
    list.select(0);
  }

  function askYes(question, action)
  {
    _confirmAction = action;
    confirmQuestion.setContent(question + '\nType "yes" to confirm.');
    confirmInput.setValue("");
    confirmModal.show();
    confirmInput.focus();
    confirmInput.readInput();
    screen.render();
  }

  function closeConfirm(cancelled, value)
  {
    try { confirmModal.hide(); } catch { }
    list.focus();
    screen.render();

    if (cancelled) return;

    const v = String(value || "").trim().toLowerCase();
    if (v !== "yes")
    {
      setStatus("Cancelled.", "warn");
      return;
    }

    const a = _confirmAction;
    _confirmAction = null;

    if (a === "reboot" || a === "poweroff")
    {
      setStatus(a === "reboot" ? "Rebooting..." : "Shutting down...", "ok");
      screen.render();
      const ok = runSystemctl(a);
      if (!ok) setStatus("Failed to execute systemctl (sudo/policy?).", "err");
    }
  }

  confirmInput.on("submit", (value) => closeConfirm(false, value));
  confirmInput.key(["escape"], () => closeConfirm(true, null));

  function applySelected()
  {
    const idx = list.selected | 0;

    if (idx === 0)
    {
      const cur = !!getSetting("ui.autorecallOnScroll", false);
      setSetting("ui.autorecallOnScroll", !cur);
      settings = loadSettings();
      buildItems();
      setStatus(`Auto-recall is now ${!cur ? "ON" : "OFF"}.`, "ok");
      return;
    }

    if (idx === 1)
    {
      askYes("Reboot the system?", "reboot");
      return;
    }

    if (idx === 2)
    {
      askYes("Power off the system?", "poweroff");
      return;
    }
  }

  list.key(["enter"], () =>
  {
    if (!confirmModal.hidden) return;
    applySelected();
  });

  list.key(["escape"], () =>
  {
    if (!confirmModal.hidden) { closeConfirm(true, null); return; }
    switchPage("browse");
  });

  kb.bindKey(["q"], () =>
  {
    if (!confirmModal.hidden) return;
    switchPage("browse");
  });

  kb.bindKey(["C-c"], () => quit());

  buildItems();
  list.focus();
  screen.render();

  return function cleanup()
  {
    kb.unbindAllKeys();
    try { confirmModal.hide(); } catch { }
  };
}

  // Start on browse
  switchPage("browse");
};


