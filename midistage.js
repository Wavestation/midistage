const path = require("path");

const startApp = require("./src/tui/app");
const { startTelnetServer } = require("./src/tui/telnetServer");
const { startSerialServer } = require("./src/tui/serialServer");
// const { startTelnetPtyServer } = require("./src/tui/telnetPtyServer");

const { Model } = require("./src/core/model");
const { RemoteDevice } = require("./src/remote/remoteDevice");
const { Settings } = require("./src/core/settings");


const MIDNAM_DIR = path.join(__dirname, "data", "names");
const SETTINGS_PATH = path.join(__dirname, "data", "settings.json");

const appVer = "1.1"

const model = new Model(MIDNAM_DIR);
const settings = new Settings(SETTINGS_PATH);

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
  // Telnet
  const port = parseInt(getArg("--port", "2323"), 10);

  console.log("Starting Telnet on port " + port + " ...");

  startTelnetServer((io) => startApp(MIDNAM_DIR, io, appVer, model), port, {
    //terminal: "ansi",
    terminal: "xterm-256color",
    unicode: true,
    cols: 80,
    rows: 24
  });
}
else if (process.argv.includes("--serial"))
{
  const portPath = getArg("--serial", null);
  if (!portPath) {
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
      //terminal: "ansi",   // <-- IMPORTANT pour Kermit-95 / ANSI-BBS
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
  // local  
  startApp(MIDNAM_DIR, null, appVer, model);
}
////////////////////////////////////////////////////////////////////////////////////////////
// Démarrage de la RC
const remote = new RemoteDevice({
  path: settings.getSetting("remote.serialPort", "/dev/ttyS0"),
  baudRate: parseInt(settings.getSetting("remote.serialRate", 38400)),
  log: console.log,
  vfdIdleDelay: parseInt(settings.getSetting("remote.vfdIdleTime", 39)) * 1000,
  vfdDefaultBrightness: settings.getSetting("remote.vfdBrightness", 3),
  vfdDeepSleepEnabled: !!settings.getSetting("remote.vfdDeepSleep", false)
});

// console.log("[DEBUG] Setting VFD: " + settings.getSetting("remote.vfdBrightness", 3))

remote.initVFD();
remote.setVFDBrightness(settings.getSetting("remote.vfdBrightness", 3));
remote.setCharTable(0);
remote.setIntlFont(0);

remote.showText(`è MIDISTAGE ver${appVer} è`, "F1-8 FNCT é A-H HKYS");

setTimeout(() => {
  const uis = model.getUiState();
  let currentName = uis.currentEntryName
  if (model.getActiveSetlist().entries.length == 0) currentName = "<NO ENTRY>" 

  remote.showText(`{${uis.currentSetlistName}}`, currentName);
  remote.showTextXY(`[WT]`, 17, 1);

}, 2639);

// Remote Events handle
remote.on("key", k => { 
  try
  {
    console.log("[REMOTE] Key Pressed:" + k);
    model.handleRemoteKey(k);
  } catch(er) { console.warn("[REMOTE] ERR KEYPRESS " + er); } // doesn't crash here

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
  remote.idleDelay = parseInt(value.value) * 1000;
  console.log(`[REMOTE] PARAMETER IDLEDLY CHANGED TO ${value.value}`);
});
model.on("remoteVFDDeepSleep", (value) => {
  remote.deepSleepEnabled = !!value.value
  console.log(`[REMOTE] PARAMETER DEEPSLEEP CHANGED TO ${!!value.value}`);
});