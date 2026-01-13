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

  initVFD()
  {
    const payload = Buffer.concat([
      Buffer.from([0x1B, 0x40]),  // INIT DISPLAY
      Buffer.from([0x0C, 0x0B]),  // CLEAR and HOME
    ]);
    this._send(payload);
  }
  
  clearVFD()
  {
    const payload = Buffer.concat([
      Buffer.from([0x0C, 0x0B]),  // CLEAR and HOME
    ]);
    this._send(payload);
  }

  setVFDBrightness(br)    // 1 to 4 levels
  {
    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x58, br]),  // SET BRIGHTNESS
    ]);
    this._send(payload);
  }

  setVFDReverse(rv)     // O = normal, 1 = reverse
  {
    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x72, rv]),  // SET REVERSE
    ]);
    this._send(payload);
  }

  setVFDPower(pw)     // O = off, 1 = on
  {
    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x28, 0x61, 0x40, pw]),  // SET POWER STATE
    ]);
    this._send(payload);
  }

  setVFDBlink(bk)     // bk = blink speed 1 to 255 / 0 = off
  {
    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x45, bk]),  // SET BLINK
    ]);
    this._send(payload);
  }

  setIntlFont(ifs)    // international font set
  {
    const payload = Buffer.concat([
      Buffer.from([0x1B, 0x52, ifs]),  // SET FONT
    ]);
    this._send(payload);
  }

  setCharTable(tid)
  {
    const payload = Buffer.concat([
      Buffer.from([0x1B, 0x74, tid]),  // SET CHAR TABLE
    ]);
    this._send(payload);
  }
  

  showText(line_up, line_low)
  {
    const line1 = fitFixed(line_up, 20);
    const line2 = fitFixed(line_low, 20);

    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x24, 0x01, 0x01]), // GOTO ROW 1 LINE 1
      Buffer.from(line1, "ascii"),
      Buffer.from([0x1F, 0x24, 0x01, 0x02]), // GOTO ROW 1 LINE 2
      Buffer.from(line2, "ascii")
    ]);

    this._send(payload);
  }

  showSetEnt(setlistName, entryName)
  {
    const line1 = `SET:${fitFixed(setlistName, 16)}`;
    const line2 = `ENT:${fitFixed(entryName, 16)}`;

    this.showText(line1, line2);
  }

  showTextXY(text, xpos, ypos)
  {
    const payload = Buffer.concat([
      Buffer.from([0x1F, 0x24, xpos, ypos]), // GOTO X Y
      Buffer.from(text, "ascii"),
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
