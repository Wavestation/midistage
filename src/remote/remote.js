// src/remote/remote.js
"use strict";

const { EventEmitter } = require("events");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const REMOTE_BAUDRATE = 38400; // baud du LIEN PC<->RS232 (STM32 doit matcher)

class RemoteControl extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = typeof log === "function" ? log : () => {};
    this.path = null;

    this.port = null;
    this.parser = null;
  }

  isRunning() {
    return !!(this.port && this.port.isOpen);
  }

  getPort() {
    return this.port;
  }

  async setPort(path) {
    const newPath = (path || "").trim() || null;

    if (newPath === this.path && this.isRunning()) return;

    await this.stop();
    this.path = newPath;

    if (!this.path) return; // disabled

    await this.start();
  }

  async start() {
    if (!this.path || this.isRunning()) return;

    this.port = new SerialPort({
      path: this.path,
      baudRate: REMOTE_BAUDRATE,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: "none"
    });

    await new Promise((resolve, reject) => {
      this.port.open(err => (err ? reject(err) : resolve()));
    });

    // STM32: "A\r\n" etc.
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));

    this.parser.on("data", (line) => {
      const s = String(line).trim(); // retire \r
      if (!s) return;

      const ch = s[0].toUpperCase();

      // filtre: A..H + 1..8 (à toi d’étendre)
      const ok = ((ch >= "A" && ch <= "H") || (ch >= "1" && ch <= "8"));
      if (!ok) {
        this.emit("raw", s);
        return;
      }

      this.emit("key", ch);
    });

    this.port.on("error", (e) => this.emit("error", e));
    this.port.on("close", () => this.emit("close"));

    this.log(`[REMOTE] started on ${this.path} @ ${REMOTE_BAUDRATE}`);
  }

  async stop() {
    if (!this.port) return;

    const p = this.port;
    this.port = null;
    this.parser = null;

    await new Promise((resolve) => {
      try {
        if (!p.isOpen) return resolve();
        p.close(() => resolve());
      } catch {
        resolve();
      }
    });

    this.log("[REMOTE] stopped");
  }
}

module.exports = { RemoteControl, REMOTE_BAUDRATE };
