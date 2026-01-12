const path = require("path");
const startApp = require("./src/tui/app");
const { startTelnetServer } = require("./src/tui/telnetServer");
//const { startTelnetPtyServer } = require("./src/tui/telnetPtyServer");
const { startSerialServer } = require("./src/tui/serialServer");

const MIDNAM_DIR = path.join(__dirname, "data", "names");

const appVer = "1.1"

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

  startTelnetServer((io) => startApp(MIDNAM_DIR, io, appVer), port, {
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
    (io) => startApp(MIDNAM_DIR, io, appVer)
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
  startApp(MIDNAM_DIR, null, appVer);
}
