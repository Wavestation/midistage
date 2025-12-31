const fs = require("fs");
const blessed = require("blessed");

const { Model } = require("../core/model");

module.exports = function startApp(midnamDir, io)
{
    const screen = blessed.screen({
        smartCSR: true,
        title: "MIDISTAGE 26+",
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
            {
                screen.program.resize(io.cols, io.rows);
            }
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
                {
                    screen.program.resize(cols, rows);
                }
                screen.render();
            }
            catch { }
        });
    }

    const model = new Model({ midnamDir });

    // -------------------- Key binding helpers (CRITICAL) --------------------
    // Blessed ne "débinde" pas tout seul quand tu détruis les widgets.
    // Donc on attache les keys à une page et on les retire au switch.
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
        try
        {
            // Détruit tous les widgets de la page
            screen.children.forEach(c => c.destroy());
        }
        catch { }
    }

    function switchPage(name)
    {
        if (currentCleanup)
        {
            try { currentCleanup(); } catch { }
            currentCleanup = null;
        }

        clearScreen();

        if (name === "setlist")
        {
            currentCleanup = buildSetlistPage();
        }
        else
        {
            currentCleanup = buildBrowsePage();
        }

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
                "{bold}Tab{/bold} focus | {bold}Enter{/bold} send to synth | {bold}S{/bold} search | {bold}A{/bold} add->draft | {bold}M{/bold} machine list | {bold}L{/bold} set list | {bold}Ctrl-Q / Esc{/bold} quit"
        });

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
            style: {
                border: THEME.border,
                selected: { inverse: true }
            }
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
            style: {
                border: THEME.border,
                selected: { inverse: true }
            }
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
            style: {
                border: THEME.border,
                selected: { inverse: true }
            }
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

        // -------- Machine picker modal --------

        const machineModal = blessed.box({
            parent: frame,
            top: "center",
            left: "center",
            width: "70%",
            height: "60%",
            border: "line",
            label: " Machines ",
            hidden: true,
            tags: true,
            style: { border: THEME.borderFocus },
            padding: { left: 1, right: 1 }
        });

        const machineList = blessed.list({
            parent: machineModal,
            top: 1,
            left: 1,
            width: "100%-2",
            height: "100%-4",
            keys: true,
            vi: true,
            tags: true,
            style: {
                selected: { inverse: true }
            }
        });

        const machineHelp = blessed.box({
            parent: machineModal,
            bottom: 0,
            left: 1,
            height: 2,
            width: "100%-2",
            tags: true,
            content: "{bold}↑↓{/bold} choisir | {bold}Enter{/bold} valider | {bold}Esc{/bold} annuler"
        });

        function tryPeekDeviceName(midnamFile)
        {
            if (!midnamFile) return "<no midnam>";
            try { return model.peekMidnamDeviceName(midnamFile); } catch { return "?"; }
        }

        function machineToLine(m, withId)
        {
            const out = m.out ? m.out : "default";
            const ch = m.channel ? `CH${m.channel}` : "CH?";
            const mid = m.midnamFile ? m.midnamFile : "<no midnam>";
            const dev = tryPeekDeviceName(m.midnamFile);

            const idPart = withId ? `  {gray-fg}(${m.id}){/gray-fg}` : "";
            return `${m.name}  {gray-fg}[${out} / ${ch}]{/gray-fg}  {gray-fg}${dev}{/gray-fg}  {gray-fg}(${mid}){/gray-fg}${idPart}`;
        }

        function setLabelWithFocus(widget, baseLabel, focused)
        {
            widget.setLabel(` ${focused ? FOCUS_MARK + " " : ""}${baseLabel} `);

            const borderStyle = focused ? THEME.borderFocus : THEME.border;
            if (widget.style && widget.style.border)
            {
                widget.style.border = borderStyle;
            }
        }

        function refreshFocusMarkers()
        {
            setLabelWithFocus(filesList, "Instruments", screen.focused === filesList);
            setLabelWithFocus(banksList, "Banks", screen.focused === banksList);
            setLabelWithFocus(patchesList, "Patches", screen.focused === patchesList);
            setLabelWithFocus(search, "Search", screen.focused === search);
            setLabelWithFocus(status, "Status", screen.focused === status);
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

            filesList.setItems(list.map(m => machineToLine(m, false)));

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

            // Active machine
            try { model.machines.setActive(m.id); } catch { }

            if (!m.midnamFile)
            {
                clearLoadedInstrumentUI(
                    `Machine active: ${m.name}\n(midnam: none) | ${model.draftGetSummary()}`
                );
                return;
            }

            try
            {
                const parsed = model.loadMidnam(m.midnamFile);
                search.setValue("");

                setStatus(
                    `OK: ${parsed.deviceName}\nMachine: ${m.name} | ${model.draftGetSummary()}`,
                    "ok"
                );

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
            if (b.count > 0)
            {
                banksList.select(Math.min(model.state.bankIndex || 0, b.count - 1));
            }
            else
            {
                banksList.select(0);
            }
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
            else
            {
                setStatus(r.message, "err");
            }
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
            else
            {
                setStatus(r.message, "err");
            }
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

        // -------- Machine picker modal (toujours utile) --------

        function openMachinePicker()
        {
            const list = model.listMachines();
            if (!list.length)
            {
                setStatus("Aucune machine.", "warn");
                return;
            }

            machineList.setItems(list.map(m => machineToLine(m, true)));
            machineList._machines = list;

            const active = model.getActiveMachine();
            let idx = 0;
            if (active)
            {
                const i = list.findIndex(x => x.id === active.id);
                if (i >= 0) idx = i;
            }

            machineList.select(idx);

            machineModal.show();
            machineList.focus();
            refreshFocusMarkers();
            screen.render();
        }

        function closeMachinePicker(focusBackTo)
        {
            machineModal.hide();
            (focusBackTo || patchesList).focus();
            refreshFocusMarkers();
            screen.render();
        }

        machineList.key(["escape"], function ()
        {
            closeMachinePicker(patchesList);
        });

        machineList.key(["enter"], function ()
        {
            const list = machineList._machines || [];
            const m = list[machineList.selected];
            if (!m)
            {
                closeMachinePicker(patchesList);
                return;
            }

            // Sélection via picker = machine active + reload instrument (midnam)
            try { model.machines.setActive(m.id); } catch { }

            // Sync filesList selection if visible
            const fl = filesList._machines || [];
            const fIdx = fl.findIndex(x => x.id === m.id);
            if (fIdx >= 0) filesList.select(fIdx);

            closeMachinePicker(filesList);
            loadSelectedMachineInstrument();
        });

        // -------------------- Events --------------------

        filesList.on("select", function ()
        {
            loadSelectedMachineInstrument();
        });

        banksList.on("select", function ()
        {
            model.setBankIndex(banksList.selected);
            refreshPatches();
            screen.render();
        });

        patchesList.key(["enter"], function ()
        {
            sendSelectedPatch();
        });

        // Focus management (Tab n'inclut pas Search)
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

        kb.bindKey(["tab"], function ()
        {
            if (!machineModal.hidden) return;

            if (screen.focused === search)
            {
                patchesList.focus();
                refreshFocusMarkers();
                screen.render();
                return;
            }
            focusNext();
        });

        kb.bindKey(["S-tab"], function ()
        {
            if (!machineModal.hidden) return;

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
            w.on("focus", function ()
            {
                refreshFocusMarkers();
                screen.render();
            });
            w.on("blur", function ()
            {
                refreshFocusMarkers();
                screen.render();
            });
        });

        // Search open
        kb.bindKey(["s"], function ()
        {
            if (!machineModal.hidden) return;

            search.focus();
            refreshFocusMarkers();
            screen.render();
        });

        // Search submit
        search.on("submit", function (value)
        {
            model.setPatchFilter(value || "");
            refreshPatches();
            patchesList.focus();
            refreshFocusMarkers();
            screen.render();
        });

        // Esc: cancel/reset search (global)
        kb.bindKey(["escape"], function ()
        {
            if (!machineModal.hidden)
            {
                closeMachinePicker(patchesList);
                return;
            }

            if (screen.focused === search)
            {
                clearSearchAndReturn();
                return;
            }

            if (model.state.patchFilter && model.state.patchFilter.trim())
            {
                clearSearchAndReturn();
            }
        });

        // Ctrl+N / Ctrl+P: next/prev selection
        kb.bindKey(["C-n"], function ()
        {
            moveSelection(+1);
        });

        kb.bindKey(["C-p"], function ()
        {
            moveSelection(-1);
        });

        // Add to draft
        kb.bindKey(["a"], function ()
        {
            addToDraft();
        });

        // Modal machine
        kb.bindKey(["m"], function ()
        {
            openMachinePicker();
        });

        // Go to Setlist page
        kb.bindKey(["l"], function ()
        {
            switchPage("setlist");
        });

        // Quit
        kb.bindKey(["C-q", "C-c"], function ()
        {
            quit();
        });

        // Init
        refreshMachinesList();
        filesList.focus();
        refreshFocusMarkers();
        screen.render();

        // Auto-load current machine if any
        if ((filesList._machines || []).length)
        {
            loadSelectedMachineInstrument();
        }
        else
        {
            clearLoadedInstrumentUI("Aucune machine dans machines.json.");
        }

        return function cleanup()
        {
            kb.unbindAllKeys();
            try { machineModal.hide(); } catch { }
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
            style: {
                border: THEME.border,
                selected: { inverse: true }
            }
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
            scrollbar: {
                ch: " ",
                inverse: true
            },
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

        const inputHelp = blessed.box({
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

            if (cb)
            {
                cb(cancelled ? new Error("cancelled") : null, value);
            }
        }

        inputBox.on("submit", function (value)
        {
            closeInputModal(false, value);
        });

        inputBox.key(["escape"], function ()
        {
            closeInputModal(true, null);
        });

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
            setlistInfo.setContent(
                `Active: {bold}${name}{/bold}\n${model.draftGetSummary()}`
            );
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
        entriesList.on("highlight", function ()
        {
            refreshPreview();
        });

        entriesList.key(["up", "down", "k", "j", "pageup", "pagedown"], function ()
        {
            refreshPreview();
        });

        entriesList.key(["enter"], function ()
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

        // Save draft as new entry
        kb.bindKey(["a"], function ()
        {
            if (!model.draft.routes.length)
            {
                setStatus("Draft vide: utilise Browse + A pour ajouter des routes.", "warn");
                return;
            }

            askInput("Nom de l'entrée (cue) ?", "", function (err, value)
            {
                if (err) return;

                const r = model.commitDraftAsEntry(String(value || "").trim() || "Entry");
                setStatus(r.message, r.ok ? "ok" : "err");
                refreshEntries();
            });
        });

        // Rename selected entry
        kb.bindKey(["r"], function ()
        {
            const e = getSelectedEntry();
            if (!e)
            {
                setStatus("Aucune entrée.", "warn");
                return;
            }

            askInput("Nouveau nom ?", e.name, function (err, value)
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

        // Delete selected entry
        kb.bindKey(["d"], function ()
        {
            const e = getSelectedEntry();
            if (!e)
            {
                setStatus("Aucune entrée.", "warn");
                return;
            }

            askInput(`Supprimer "${e.name}" ? Tape "oui"`, "", function (err, value)
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

        // Back to browse
        kb.bindKey(["q", "escape"], function ()
        {
            switchPage("browse");
        });

        // Quit hard
        kb.bindKey(["C-c"], function ()
        {
            quit();
        });

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