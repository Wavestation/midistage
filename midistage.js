const path = require("path");

const startApp = require("./src/tui/app");
const { startTelnetServer } = require("./src/tui/telnetServer");
const { startSerialServer } = require("./src/tui/serialServer");
// const { startTelnetPtyServer } = require("./src/tui/telnetPtyServer");

const { Model } = require("./src/core/model");
const { G13RemoteDevice } = require("./src/remote/g13RemoteDevice");
const { Settings } = require("./src/core/settings");

const MIDNAM_DIR = path.join(__dirname, "data", "names");
const SETTINGS_PATH = path.join(__dirname, "data", "settings.json");

const appVer = "1.1";

const settings = new Settings(SETTINGS_PATH);

const model = new Model({
  midnamDir: MIDNAM_DIR,
  fuzzySearchEnabled: !!settings.getSetting("ui.enableFuzzySearch", false)
});

function getArg(name, def = null)
{
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

function clampInt(v, def, min, max)
{
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

if (process.argv.includes("--telnet"))
{
  const port = parseInt(getArg("--port", "2323"), 10);

  console.log("Starting Telnet on port " + port + " ...");

  startTelnetServer((io) => startApp(MIDNAM_DIR, io, appVer, model), port, {
    terminal: "xterm-256color",
    unicode: true,
    cols: 80,
    rows: 24
  });
}
else if (process.argv.includes("--serial"))
{
  const portPath = getArg("--serial", null);
  if (!portPath)
  {
    console.error("Usage: node midistage.js --serial <COM3|/dev/ttyUSB0> [--baud 115200] [--cols 80] [--rows 24]");
    process.exit(2);
  }

  const baud = clampInt(getArg("--baud", "115200"), 115200, 300, 2000000);
  const cols = clampInt(getArg("--cols", "64"), 80, 20, 300);
  const rows = clampInt(getArg("--rows", "24"), 24, 10, 120);

  console.log("Starting Telnet on port " + portPath + " ...");

  const srv = startSerialServer(
    {
      path: portPath,
      baudRate: baud,
      cols,
      rows,
      terminal: "xterm-256color",
      unicode: false
    },
    (io) => startApp(MIDNAM_DIR, io, appVer, model)
  );

  const shutdown = () => {
    try { srv.close(); } catch {}
    try { require("./src/midi/driver").closeAll(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
else
{
  startApp(MIDNAM_DIR, null, appVer, model);
}
////////////////////////////////////////////////////////////////////////////////////////////
// D?marrage de la RC
const remote = new G13RemoteDevice({
  log: console.log,
  vfdIdleDelay: parseInt(settings.getSetting("remote.vfdIdleTime", 39), 10) * 1000,
  vfdDefaultBrightness: settings.getSetting("remote.vfdBrightness", 3),
  vfdDeepSleepEnabled: !!settings.getSetting("remote.vfdDeepSleep", false),
  displayFont: 1,
  backlightColor: settings.getSetting("remote.backlightColor", "#48C410")
});

remote.initVFD();
remote.setVFDBrightness(settings.getSetting("remote.vfdBrightness", 3));
remote.setBacklightColor(settings.getSetting("remote.backlightColor", "#48C410"));
remote.setCharTable(0);
remote.setIntlFont(0);

//remote.showText(`${String.fromCharCode(7)} MIDISTAGE ver${appVer} ${String.fromCharCode(7)}`, "");
remote.showText(`${String.fromCharCode(0x1C)}${String.fromCharCode(0x1D)}MIDISTAGE ver${appVer} ${String.fromCharCode(7)}`, "");


let remoteLogoAnimStep = 0;
let remoteLogoAnim = setInterval(() => {
  //const animsymbs = [176, 176, 176, 176, 176, 177, 177, 177, 177, 177, 178, 178, 178, 178, 178, 219, 219, 219, 219, 219];
  const animsymbs = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4];
  remote.showTextXY(String.fromCharCode(animsymbs[remoteLogoAnimStep]), remoteLogoAnimStep, 2);

  remoteLogoAnimStep++;
  if (remoteLogoAnimStep >= 21) clearInterval(remoteLogoAnim);
}, 100);

setTimeout(() => {
  clearInterval(remoteLogoAnim);

  const uis = model.getUiState();
  let currentName = uis.currentEntryName;
  if (model.getActiveSetlist().entries.length == 0) currentName = "<NO ENTRY>";

  remote.showText(`{${uis.currentSetlistName}}`, currentName);
  remote.showTextXY("[WT]", 17, 1);
}, 2639);

remote.on("connect", (payload) => {
  console.log(`[REMOTE] G13 AVAILABLE ON ${payload.devicePath}`);
});

remote.on("disconnect", (payload) => {
  console.warn(`[REMOTE] G13 DISCONNECTED (${payload.reason || "disconnect"})`);
});

remote.on("error", (error) => {
  console.warn(`[REMOTE] G13 ERROR ${error.message}`);
});

remote.on("key", (k) => {
  try
  {
    console.log("[REMOTE] Key Pressed:" + k);
    model.handleRemoteKey(k);
  }
  catch (er)
  {
    console.warn("[REMOTE] ERR KEYPRESS " + er);
  }
});

model.on("recalledEntry", (state) =>
{
  remote.clearVFD();
  remote.showText(state.setlist, state.entry);
  remote.showTextXY(`[${state.status}]`, 17, 1);
  console.log(`[REMOTE] RECALLED ENTRY TO REMOTE ${state.setlist} - ${state.entry}`);
});

model.on("changedSetlist", (state) =>
{
  remote.clearVFD();
  remote.showText(state.setlist, state.entry);
  remote.showTextXY(`[${state.status}]`, 17, 1);
  console.log(`[REMOTE] RECALLED SETLIST TO REMOTE ${state.setlist} - ${state.entry}`);
});

model.on("remoteMessage", (message) => {
  remote.showText(message.up, message.down);
});

model.on("remoteDisplayXY", (message) => {
  remote.showTextXY(message.text, message.xpos, message.ypos);
});

model.on("remoteDisplayPower", (value) => {
  remote.setVFDPower(value.value);
});

model.on("remoteVFDBrightness", (value) => {
  remote.setVFDBrightness(value.value);
  console.log(`[REMOTE] PARAMETER VFDBR CHANGED TO ${value.value}`);
});

model.on("remoteVFDIdleTime", (value) => {
  remote.idleDelay = parseInt(value.value, 10) * 1000;
  console.log(`[REMOTE] PARAMETER IDLEDLY CHANGED TO ${value.value}`);
});

model.on("remoteVFDDeepSleep", (value) => {
  remote.deepSleepEnabled = !!value.value;
  console.log(`[REMOTE] PARAMETER DEEPSLEEP CHANGED TO ${!!value.value}`);
});

model.on("remoteBacklightColor", (value) => {
  const applied = remote.setBacklightColor(value.value);
  console.log(`[REMOTE] PARAMETER BACKLIGHT COLOR CHANGED TO ${applied}`);
});
