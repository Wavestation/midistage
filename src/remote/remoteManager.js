"use strict";

const { RemoteControl } = require("./remote");
const { VfdDisplay } = require("./vfd");

class RemoteManager {
  constructor(model, { log } = {}) {
    this.model = model;
    this.log = log || (() => {});

    this.remote = new RemoteControl({ log: this.log }); // ouvre le port + lit RX
    this.vfd = null;                                   // utilisera le même port

    this.enabled = false;
    this.portPath = "";

    this._wired = false;
  }

  async applyConfig(cfg) {
    const enabled = !!cfg.remoteEnabled;
    const portPath = (cfg.remotePort || "").trim();     // UN SEUL PORT

    // stop si disable
    if (!enabled) {
      await this.stop();
      return;
    }

    // (re)start si port change
    if (!this.enabled || portPath !== this.portPath) {
      this.portPath = portPath;

      // Ouvre le port (remote)
      await this.remote.setPort(this.portPath);

      // Crée/Remplace le VFD sur le même port
      // IMPORTANT: readyLine doit correspondre à ton câblage (VFD_DTR -> CTS recommandé)
      this.vfd = new VfdDisplay(this.remote.getPort(), {
        log: this.log,
        readyLine: cfg.remoteReadyLine || "cts", // optionnel, sinon fixe "cts"
        chunkSize: 32,
        pollMs: 5
      });

      this._wireOnce();
    }

    this.enabled = true;
    this.refreshVfdFromModel();
  }

  _wireOnce() {
    if (this._wired) return;
    this._wired = true;

    this.remote.on("key", (ch) => {
      if (ch >= "A" && ch <= "H") this.model.triggerSetlistHotkey?.(ch);
      else if (ch >= "1" && ch <= "8") this.model.triggerFunctionKey?.(Number(ch));
    });

    this.model.on?.("stateChanged", () => this.refreshVfdFromModel());
  }

  refreshVfdFromModel() {
    if (!this.vfd) return;
    const s = this.model.getUiState?.() || {};
    this.vfd.showConcert(s.currentSetlistName || "", s.currentEntryName || "");
  }

  async stop() {
    this.enabled = false;
    this.portPath = "";

    try { await this.remote.stop(); } catch {}
    this.vfd = null;
  }
}

module.exports = { RemoteManager };