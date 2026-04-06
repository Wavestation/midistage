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

const appVer = "1.2";

const settings = new Settings(SETTINGS_PATH);

let runtimeServer = null;
let remoteLogoAnim = null;
let remoteSplashTimer = null;

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

  runtimeServer = startTelnetServer((io) => startApp(MIDNAM_DIR, io, appVer, model), port, {
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

  runtimeServer = startSerialServer(
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

}
else
{
  startApp(MIDNAM_DIR, null, appVer, model);
}
////////////////////////////////////////////////////////////////////////////////////////////
// Démarrage de la RC
const remote = new G13RemoteDevice({
  log: console.log,
  vfdIdleDelay: parseInt(settings.getSetting("remote.vfdIdleTime", 39), 10) * 1000,
  vfdDefaultBrightness: settings.getSetting("remote.vfdBrightness", 3),
  vfdDeepSleepEnabled: !!settings.getSetting("remote.vfdDeepSleep", false),
  displayFont: 1,
  backlightColor: settings.getSetting("remote.backlightColor", "#48C410")
});

let shuttingDown = false;

async function shutdown(exitCode = 0)
{
  if (shuttingDown) return;
  shuttingDown = true;

  try { clearInterval(remoteLogoAnim); } catch {}
  try { clearTimeout(remoteSplashTimer); } catch {}

  try
  {
    await remote.shutdown();
  }
  catch (error)
  {
    console.warn("[REMOTE] SHUTDOWN ERROR " + (error.message || error));
  }

  try { runtimeServer && runtimeServer.close(); } catch {}
  try { require("./src/midi/driver").closeAll(); } catch {}

  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

remote.initVFD();
remote.setVFDBrightness(settings.getSetting("remote.vfdBrightness", 3));
remote.setBacklightColor("#48C410");
remote.setCharTable(0);
remote.setIntlFont(0);

remote.showText(`${String.fromCharCode(7)} MIDISTAGE ver${appVer} ${String.fromCharCode(7)}`, "");
//remote.showText(`${String.fromCharCode(0x1C)}${String.fromCharCode(0x1D)}MIDISTAGE ver${appVer}${String.fromCharCode(0x1E)}${String.fromCharCode(0x1F)}`, "");


let remoteLogoAnimStep = 0;
remoteLogoAnim = setInterval(() => {
  //const animsymbs = [176, 176, 176, 176, 176, 177, 177, 177, 177, 177, 178, 178, 178, 178, 178, 219, 219, 219, 219, 219];
  const animsymbs = [0, 0x1E, 0x1F, 5, 7, 5, 7, 5, 7, 5, 7, 5, 7, 5, 7, 5, 7, 5, 7];
  const animgay = [
    "#ff0000", // Rouge
    "#ff5500",
    "#ffaa00",
    "#ffff00", // Jaune
    "#aaff00",
    "#55ff00",
    "#00ff00", // Vert
    "#00ff55",
    "#00ffaa",
    "#00ffff", // Cyan
    "#00aaff",
    "#0055ff",
    "#0000ff", // Bleu
    "#2a00ff",
    "#5500ff",
    "#8000ff", // Indigo / Violet
    "#aa00ff",
    "#d400ff",
    "#ff00ff"  // Magenta
  ];
  remote.setBacklightColor(animgay[remoteLogoAnimStep]);
  remote.showTextXY(`${String.fromCharCode(0x1C)}${String.fromCharCode(0x1D)}MIDISTAGE ver${appVer} ${String.fromCharCode(0)}`, 1, 1);
  if (remoteLogoAnimStep >= 10) remote.showTextXY(`${String.fromCharCode(0x1C)}${String.fromCharCode(0x1D)} by Masami Komuro`, 1, 1);
  remote.showTextXY(`${String.fromCharCode(0x1E)}${String.fromCharCode(0x1F)}`, 1, 2);
  remote.showTextXY(String.fromCharCode(animsymbs[remoteLogoAnimStep]), remoteLogoAnimStep, 2);

  remoteLogoAnimStep++;
  if (remoteLogoAnimStep >= 21) clearInterval(remoteLogoAnim);
}, 100);

remoteSplashTimer = setTimeout(() => {
  clearInterval(remoteLogoAnim);

  const uis = model.getUiState();
  let currentName = uis.currentEntryName;
  if (model.getActiveSetlist().entries.length == 0) currentName = "<NO ENTRY>";

  remote.setBacklightColor(settings.getSetting("remote.backlightColor", "#48C410"));
  remote.showText(`{${uis.currentSetlistName}}`, currentName);
  remote.showTextXY("[WT]", 17, 1);

  remote.showTipText("?HELP? | ----- | ----- | ABOUT");
}, 2939);

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
  remote.showTextXY(`[${state.status}]`, 14, 1);
  console.log(`[REMOTE] RECALLED ENTRY TO REMOTE ${state.setlist} - ${state.entry}`);
});

model.on("changedSetlist", (state) =>
{
  remote.clearVFD();
  remote.showText(state.setlist, state.entry);
  remote.showTextXY(`[${state.status}]`, 14, 1);
  console.log(`[REMOTE] RECALLED SETLIST TO REMOTE ${state.setlist} - ${state.entry}`);
});

model.on("remoteMessage", (message) => {
  remote.showText(message.up.replace("%appver%", appVer), message.down.replace("%appver%", appVer));
});

model.on("remoteDisplayXY", (message) => {
  remote.showTextXY(message.text, message.xpos, message.ypos);
});

model.on("remoteTipText", (message) => {
  const text = (message && typeof message === "object") ? message.text : message;
  remote.showTipText(text);
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
  const applied = remote.setBacklightColor(value.value || settings.getSetting("remote.backlightColor", "#48C410"));
  console.log(`[REMOTE] PARAMETER BACKLIGHT COLOR CHANGED TO ${applied}`);
});

model.on("remoteMacroLeds", (value) => {
  const applied = remote.setMacroLeds(value);
  console.log(`[REMOTE] PARAMETER REMOTE LEDS SET TO ${applied}`);
});
