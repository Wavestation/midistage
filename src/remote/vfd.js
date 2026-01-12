// src/remote/vfd.js
"use strict";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanText(s) {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fitFixed(s, n) {
  const t = cleanText(s);
  return (t.length > n) ? t.slice(0, n) : t.padEnd(n, " ");
}

class VfdDisplay {
  /**
   * @param {SerialPort} port - port déjà ouvert (même port que remote)
   * @param {object} opts
   * @param {function} opts.log
   * @param {"cts"|"dsr"|"dcd"|"ri"} opts.readyLine - entrée modem à lire (ex: VFD_DTR câblé sur CTS)
   * @param {number} opts.pollMs
   * @param {number} opts.chunkSize
   */
  constructor(port, {
    log,
    readyLine = "cts",
    pollMs = 5,
    chunkSize = 32
  } = {}) {
    if (!port) throw new Error("VfdDisplay requires an opened SerialPort instance");
    this.port = port;

    this.log = typeof log === "function" ? log : () => {};
    this.readyLine = readyLine;
    this.pollMs = pollMs;
    this.chunkSize = chunkSize;

    this.queue = [];
    this.sending = false;
  }

  async _isReady() {
    return new Promise((resolve) => {
      this.port.get((err, status) => {
        if (err || !status) return resolve(true); // fallback: ne bloque pas
        // readyLine est une ENTREE modem lisible (cts/dsr/dcd/ri)
        resolve(!!status[this.readyLine]);
      });
    });
  }

  async _waitReady() {
    // Si tu ne câbles pas la ligne READY, ça restera "true" via fallback,
    // mais tu perds la protection anti-discard.
    for (;;) {
      const ok = await this._isReady();
      if (ok) return;
      await sleep(this.pollMs);
    }
  }

  send(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "ascii");
    this.queue.push(buf);
    this._kick();
  }

  // Commands datasheet: Clear=0x0C, Home=0x0B, LF=0x0A :contentReference[oaicite:1]{index=1}
  showConcert(setlistName, entryName) {
    const line1 = `SET : ${fitFixed(setlistName, 14)}`; // 20 chars
    const line2 = `ENT : ${fitFixed(entryName, 14)}`;   // 20 chars

    const payload = Buffer.concat([
      Buffer.from([0x0C, 0x0B]),
      Buffer.from(line1, "ascii"),
      Buffer.from([0x0A]),
      Buffer.from(line2, "ascii"),
    ]);

    this.send(payload);
  }

  async _kick() {
    if (this.sending) return;
    this.sending = true;

    try {
      while (this.queue.length) {
        const buf = this.queue.shift();

        for (let i = 0; i < buf.length; i += this.chunkSize) {
          const chunk = buf.subarray(i, i + this.chunkSize);

          await this._waitReady();

          await new Promise((resolve, reject) => {
            this.port.write(chunk, (err) => err ? reject(err) : resolve());
          });

          // Un drain de temps en temps aide à lisser
          await new Promise((resolve) => this.port.drain(() => resolve()));
        }
      }
    } catch (e) {
      this.log(`[VFD] write error: ${e?.message || e}`);
      // option: vider la queue
      // this.queue.length = 0;
    } finally {
      this.sending = false;
    }
  }
}

module.exports = { VfdDisplay };
