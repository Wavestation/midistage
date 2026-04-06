"use strict";

const { EventEmitter } = require("events");
const { G13Interface } = require("gtreize-interface");

const DISPLAY_WIDTH = 20;
const BLANK_LINE = " ".repeat(DISPLAY_WIDTH);
const POWER_OFF_DELAY_OFFSET_SECONDS = 3600;
const DEFAULT_BACKLIGHT_COLOR = "#48C410";
const BRIGHTNESS_SCALE = Object.freeze({
  1: 0.18,
  2: 0.38,
  3: 0.68,
  4: 1
});
const NAMED_BACKLIGHT_COLORS = Object.freeze({
  green: DEFAULT_BACKLIGHT_COLOR,
  amber: "#FF8C00",
  orange: "#FF8C00",
  red: "#FF4030",
  blue: "#4080FF",
  cyan: "#30D0D0",
  magenta: "#D040FF",
  purple: "#8A4DFF",
  pink: "#FF66CC",
  white: "#FFFFFF",
  off: "#000000"
});

const SPECIAL_CHAR_MAP = new Map([
  [String.fromCharCode(0x9F), ">"],
  [String.fromCharCode(0xF7), "*"],
  [String.fromCharCode(176), "."],
  [String.fromCharCode(177), ":"],
  [String.fromCharCode(178), "="],
  [String.fromCharCode(219), "#"]
]);

function clampByte(value)
{
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function clampBrightness(value)
{
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.max(1, Math.min(4, Math.round(number)));
}

function normalizeBacklightColor(value)
{
  if (Array.isArray(value) && value.length === 3)
  {
    return {
      r: clampByte(value[0]),
      g: clampByte(value[1]),
      b: clampByte(value[2])
    };
  }

  if (value && typeof value === "object")
  {
    return {
      r: clampByte(value.r),
      g: clampByte(value.g),
      b: clampByte(value.b)
    };
  }

  const raw = String(value || DEFAULT_BACKLIGHT_COLOR).trim();
  if (!raw) return normalizeBacklightColor(DEFAULT_BACKLIGHT_COLOR);

  const named = NAMED_BACKLIGHT_COLORS[raw.toLowerCase()];
  const source = named || raw;
  const hex = source.startsWith("#") ? source.slice(1) : source;

  if (/^[0-9a-fA-F]{3}$/.test(hex))
  {
    return normalizeBacklightColor(`#${hex.split("").map((char) => char + char).join("")}`);
  }

  if (!/^[0-9a-fA-F]{6}$/.test(hex))
  {
    throw new Error(`Unsupported backlight color: ${value}`);
  }

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function colorToHex(color)
{
  return `#${clampByte(color.r).toString(16).padStart(2, "0")}${clampByte(color.g).toString(16).padStart(2, "0")}${clampByte(color.b).toString(16).padStart(2, "0")}`.toUpperCase();
}

function scaleColor(color, factor)
{
  return {
    r: clampByte(color.r * factor),
    g: clampByte(color.g * factor),
    b: clampByte(color.b * factor)
  };
}

function sanitizeDisplayText(value)
{
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ");
  for (const [from, to] of SPECIAL_CHAR_MAP.entries())
  {
    text = text.split(from).join(to);
  }
  return text.replace(/\s+/g, " ");
}

function fitFixed(value, length = DISPLAY_WIDTH)
{
  const chars = Array.from(sanitizeDisplayText(value));
  if (chars.length >= length) return chars.slice(0, length).join("");
  return chars.join("").padEnd(length, " ");
}

function normalizeKeyId(id)
{
  return String(id || "").trim().toUpperCase();
}

class G13RemoteDevice extends EventEmitter
{
  constructor({
    log,
    pollIntervalMs,
    inputPollIntervalMs,
    vfdIdleDelay = 90_000,
    vfdDefaultBrightness = 3,
    vfdDeepSleepEnabled = true,
    displayFont = 1,
    backlightColor = DEFAULT_BACKLIGHT_COLOR
  } = {})
  {
    super();

    this.log = typeof log === "function" ? log : () => {};
    this.idleDelay = Number(vfdIdleDelay) || 90_000;
    this.powerOffDelayOffset = POWER_OFF_DELAY_OFFSET_SECONDS;
    this.deepSleepEnabled = !!vfdDeepSleepEnabled;
    this.activeBrightness = clampBrightness(vfdDefaultBrightness);
    this.sleepBrightness = 1;
    this.fontId = displayFont;
    this.baseBacklightColor = normalizeBacklightColor(backlightColor);

    this.idleTimer = null;
    this.offTimer = null;
    this.sleeping = false;
    this.vfdoff = false;
    this.disabled = false;
    this.lines = [BLANK_LINE, BLANK_LINE];

    this.device = new G13Interface({
      pollIntervalMs,
      inputPollIntervalMs
    });

    this._bindDeviceEvents();
    this.device.open().catch((error) => this._handleError(error));
  }

  _bindDeviceEvents()
  {
    this.device.on.connect((payload) =>
    {
      this.log(`[REMOTE] G13 connected on ${payload.devicePath}.`);
      this._applyVisualStateSafely();
      this._renderSafely();
      this.emit("connect", payload);
    });

    this.device.on.disconnect((payload) =>
    {
      this.log(`[REMOTE] G13 disconnected (${payload.reason || "disconnect"}).`);
      this.emit("disconnect", payload);
    });

    this.device.on.anyKey((payload) =>
    {
      const key = normalizeKeyId(payload.id);
      if (!key) return;
      this._resetIdleTimer();
      this.emit("key", key);
    });

    this.device.on.error((error) => this._handleError(error));
  }

  _clearTimers()
  {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.offTimer) clearTimeout(this.offTimer);
    this.idleTimer = null;
    this.offTimer = null;
  }

  _handleError(error)
  {
    if (!error) return;
    const message = String(error.message || error);
    if (message.includes("not currently connected")) return;
    this.log(`[REMOTE] G13 error: ${message}`);
    this.emit("error", error);
  }

  _wakeDisplay()
  {
    let changed = false;

    if (this.sleeping)
    {
      this.sleeping = false;
      changed = true;
    }

    if (this.vfdoff)
    {
      this.vfdoff = false;
      changed = true;
    }

    if (changed)
    {
      this._applyVisualStateSafely();
      this._renderSafely();
    }
  }

  _resetIdleTimer()
  {
    this._wakeDisplay();

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() =>
    {
      this.sleeping = true;
      this._applyVisualStateSafely();
    }, this.idleDelay);

    if (this.offTimer) clearTimeout(this.offTimer);
    if (this.deepSleepEnabled)
    {
      this.offTimer = setTimeout(() =>
      {
        this.sleeping = false;
        this.vfdoff = true;
        this._applyVisualStateSafely();
        this._renderSafely();
      }, this.idleDelay + (this.powerOffDelayOffset * 1000));
    }
  }

  async _applyVisualState()
  {
    if (!this.device.connected) return;

    if (this.vfdoff)
    {
      await Promise.allSettled([
        this.device.display.clear(),
        this.device.lights.setBacklight({ r: 0, g: 0, b: 0 }),
        this.device.lights.setMacroIndicators({ m1: false, m2: false, m3: false, mr: false })
      ]);
      return;
    }

    const brightness = this.sleeping ? this.sleepBrightness : this.activeBrightness;
    const macroEnabled = !this.sleeping;
    const factor = BRIGHTNESS_SCALE[clampBrightness(brightness)] ?? BRIGHTNESS_SCALE[4];

    await Promise.allSettled([
      this.device.lights.setBacklight(scaleColor(this.baseBacklightColor, factor)),
      this.device.lights.setMacroIndicators({
        m1: macroEnabled,
        m2: macroEnabled,
        m3: macroEnabled,
        mr: macroEnabled
      })
    ]);
  }

  _applyVisualStateSafely()
  {
    this._applyVisualState().catch((error) => this._handleError(error));
  }

  async _render()
  {
    if (!this.device.connected) return;

    if (this.vfdoff)
    {
      await this.device.display.clear();
      return;
    }

    await this.device.display.write(`${this.lines[0]}\n${this.lines[1]}`, {
      font: this.fontId,
      wrap: false,
      lineHeight: 16,
      spacing: 0
    });
  }

  _renderSafely()
  {
    this._render().catch((error) => this._handleError(error));
  }

  initVFD()
  {
    this._resetIdleTimer();
    this._renderSafely();
  }

  clearVFD()
  {
    this.lines = [BLANK_LINE, BLANK_LINE];
    this._resetIdleTimer();
    this._renderSafely();
  }

  setVFDBrightness(br)
  {
    this.activeBrightness = clampBrightness(br);
    this._resetIdleTimer();
    this._applyVisualStateSafely();
  }

  setBacklightColor(color)
  {
    this.baseBacklightColor = normalizeBacklightColor(color);
    this._resetIdleTimer();
    this._applyVisualStateSafely();
    return colorToHex(this.baseBacklightColor);
  }

  getBacklightColor()
  {
    return colorToHex(this.baseBacklightColor);
  }

  setMacroLeds(value)
  {
    // { m1: false, m2: false, m3: false, mr: false }
    this.device.lights.setMacroIndicators(value);
    return value;
  }

  setVFDReverse()
  {
  }

  setVFDPower(pw)
  {
    const powerOn = !!pw;
    this.vfdoff = !powerOn;
    this.sleeping = false;

    if (powerOn)
    {
      this._resetIdleTimer();
    }
    else
    {
      this._clearTimers();
    }

    this._applyVisualStateSafely();
    this._renderSafely();
  }

  setVFDBlink()
  {
  }

  setIntlFont()
  {
  }

  setCharTable()
  {
  }

  showText(lineUp, lineLow)
  {
    this.lines = [
      fitFixed(lineUp, DISPLAY_WIDTH),
      fitFixed(lineLow, DISPLAY_WIDTH)
    ];
    this._resetIdleTimer();
    this._renderSafely();
  }

  showSetEnt(setlistName, entryName)
  {
    this.showText(`SET:${fitFixed(setlistName, 16)}`, `ENT:${fitFixed(entryName, 16)}`);
  }

  showTextXY(text, xpos, ypos)
  {
    const row = Math.max(0, Math.min(1, Math.round(Number(ypos) || 1) - 1));
    const rawColumn = Math.round(Number(xpos));
    const column = Math.max(0, Math.min(DISPLAY_WIDTH - 1, rawColumn <= 0 ? 0 : rawColumn - 1));
    const chars = Array.from(sanitizeDisplayText(text));
    const line = Array.from(this.lines[row]);

    for (let index = 0; index < chars.length && (column + index) < DISPLAY_WIDTH; index += 1)
    {
      line[column + index] = chars[index];
    }

    this.lines[row] = line.join("");
    this._resetIdleTimer();
    this._renderSafely();
  }

  async shutdown()
  {
    this._clearTimers();
    this.vfdoff = true;
    this.sleeping = false;

    try
    {
      await this._applyVisualState();
      await this._render();
    }
    catch (error)
    {
      this._handleError(error);
    }

    await this.close();
  }

  async close()
  {
    this._clearTimers();

    try
    {
      await this.device.close();
    }
    catch (error)
    {
      this._handleError(error);
    }
  }
}

module.exports = { G13RemoteDevice };
