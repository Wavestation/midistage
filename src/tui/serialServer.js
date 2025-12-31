"use strict";

const { SerialPort } = require("serialport");
const { Duplex } = require("stream");

function makeSerialTTY(port, opts) {
  const tty = new Duplex({
    read() {
      // data is pushed from port 'data' event
    },
    write(chunk, enc, cb) {
      try {
        // blessed envoie parfois des Buffers, parfois des strings
        let s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

        // IMPORTANT: conversion LF -> CRLF (sans doubler CRLF)
        // On convertit seulement les \n qui ne sont pas déjà précédés de \r
        s = s.replace(/(?<!\r)\n/g, "\r\n");

        port.write(s, cb);
      } catch (e) {
        cb(e);
      }
    }
  });

  // blessed aime bien croire qu'il parle à un vrai terminal
  tty.isTTY = true;
  tty.columns = Number.isFinite(opts.cols) ? opts.cols : 80;
  tty.rows = Number.isFinite(opts.rows) ? opts.rows : 24;

  // no-op, mais blessed/key handling peut l'appeler
  tty.setRawMode = function setRawMode() { return; };
  tty.getWindowSize = function getWindowSize() { return [tty.columns, tty.rows]; };

  // push input from serial to blessed
  port.on("data", (buf) => {
    // buf doit rester Buffer si possible
    tty.push(buf);
  });

  port.on("close", () => {
    try { tty.push(null); } catch {}
  });

  port.on("error", () => {
    try { tty.push(null); } catch {}
  });

  return tty;
}

function startSerialServer(options, onSession) {
  if (!options || !options.path) {
    throw new Error("startSerialServer: options.path manquant (ex: COM3 ou /dev/ttyUSB0)");
  }
  if (typeof onSession !== "function") {
    throw new Error("startSerialServer: onSession callback manquant");
  }

  const sp = new SerialPort({
    path: options.path,
    baudRate: Number.isFinite(options.baudRate) ? options.baudRate : 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: true,
  });

  // NE PAS setEncoding ici: on veut des Buffers (ESC + codes)
  // sp.setEncoding("utf8");  <-- à éviter

  const tty = makeSerialTTY(sp, options);

  const io = {
    input: tty,
    output: tty,

    // Pour Kermit/ANSI-BBS
    terminal: options.terminal || "ansi",
    unicode: typeof options.unicode === "boolean" ? options.unicode : false,

    cols: Number.isFinite(options.cols) ? options.cols : 80,
    rows: Number.isFinite(options.rows) ? options.rows : 24,

    onResize: null,
  };

  // Petit test ANSI immédiat (utile pour debug)
  try {
    sp.write("\x1b[2J\x1b[H\x1b[32mMIDISTAGE serial OK\x1b[0m\r\n");
  } catch {}

  onSession(io);

  const close = () => {
    try { sp.close(); } catch {}
  };

  sp.on("error", close);

  return { close };
}

module.exports = { startSerialServer };
