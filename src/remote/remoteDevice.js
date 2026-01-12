"use strict";

const { EventEmitter } = require("events");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanText(s)
{
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fitFixed(s, n)
{
  const t = cleanText(s);
  return (t.length > n) ? t.slice(0, n) : t.padEnd(n, " ");
}

class RemoteDevice extends EventEmitter
{
  constructor({
    path,
    baudRate = 38400,
    log,
    readyLine = "cts",
    pollMs = 5,
    chunkSize = 32
  })
  {
    super();

    if (!path) throw new Error("RemoteDevice requires a serial path");

    this.log = typeof log === "function" ? log : () => {};
    this.readyLine = readyLine;
    this.pollMs = pollMs;
    this.chunkSize = chunkSize;

    this.queue = [];
    this.sending = false;

    this.port = new SerialPort({
      path,
      baudRate,
      autoOpen: true,
      dataBits: 8,
      stopBits: 1,
      parity: "none"
    });

    this.parser = this.port.pipe(
      new ReadlineParser({ delimiter: "\n" })
    );

    this.parser.on("data", line =>
    {
      const s = String(line).trim();
      if (!s) return;
      this.emit("key", s[0].toUpperCase());
    });

    this.port.on("error", e =>
    {
      this.log(`[REMOTE] serial error: ${e.message}`);
      this.emit("error", e);
    });

    this.log(`[REMOTE] started on ${path}`);
  }

  async _isReady()
  {
    return new Promise(resolve =>
    {
      this.port.get((err, status) =>
      {
        if (err || !status) return resolve(true);
        resolve(!!status[this.readyLine]);
      });
    });
  }

  async _waitReady()
  {
    while (!(await this._isReady()))
      await sleep(this.pollMs);
  }

  _send(buf)
  {
    this.queue.push(buf);
    this._kick();
  }

  async _kick()
  {
    if (this.sending) return;
    this.sending = true;

    try
    {
      while (this.queue.length)
      {
        const buf = this.queue.shift();

        for (let i = 0; i < buf.length; i += this.chunkSize)
        {
          await this._waitReady();

          const chunk = buf.subarray(i, i + this.chunkSize);
          await new Promise((res, rej) =>
            this.port.write(chunk, err => err ? rej(err) : res())
          );
          await new Promise(res => this.port.drain(res));
        }
      }
    }
    catch (e)
    {
      this.log(`[REMOTE] write error: ${e.message}`);
    }
    finally
    {
      this.sending = false;
    }
  }

  show(setlistName, entryName)
  {
    const line1 = `SET : ${fitFixed(setlistName, 14)}`;
    const line2 = `ENT : ${fitFixed(entryName, 14)}`;

    const payload = Buffer.concat([
      Buffer.from([0x0C, 0x0B]),
      Buffer.from(line1, "ascii"),
      Buffer.from([0x0A]),
      Buffer.from(line2, "ascii")
    ]);

    this._send(payload);
  }

  close()
  {
    try
    {
      if (this.port?.isOpen)
        this.port.close();
    }
    catch {}
  }
}

module.exports = { RemoteDevice };
