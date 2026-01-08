// src/tui/telnetServer.js
"use strict";

const telnet = require("telnet2");

/**
 * startTelnetServer((io) => startApp(MIDNAM_DIR, io), port)
 * - io: { input, output, terminal, unicode, cols, rows, onResize(fn) }
 */
function startTelnetServer(createSession, port = 2323, options = {})
{
  const server = telnet({ tty: true }, (client) =>
  {
    // Valeurs par défaut "saines"
    client.columns = client.columns || options.cols || 80;
    client.rows = client.rows || options.rows || 24;

    let terminal = options.terminal || "ansi"; // mieux pour telnet
    let unicode = (typeof options.unicode === "boolean") ? options.unicode : false;

    // telnet2: TERM du client
    client.on("term", (term) =>
    {
      terminal = term || terminal;
      // On ne force pas de render ici: c’est l’app qui gère
    });

    // telnet2: taille du client
    const resizeListeners = [];
    client.on("size", (width, height) =>
    {
      const w = Number(width) || client.columns || 80;
      const h = Number(height) || client.rows || 24;

      client.columns = w;
      client.rows = h;

      // Convention blessed: "resize" sur le stream/pty
      try { client.emit("resize"); } catch {}

      // Notre hook applicatif (si défini)
      for (const fn of resizeListeners)
      {
        try { fn(w, h); } catch {}
      }
    });

    // Construire l'io attendu par startApp
    const io = {
      input: client,
      output: client,
      terminal,     // sera mis à jour via io.setTerminal ci-dessous
      unicode,
      cols: client.columns,
      rows: client.rows,
      onResize(fn) { if (typeof fn === "function") resizeListeners.push(fn); },
      setTerminal(term) { terminal = term; },
      setUnicode(u) { unicode = !!u; }
    };

    // Si TERM arrive après, on met aussi à jour io.terminal
    client.on("term", (term) =>
    {
      io.terminal = term || terminal;
      // Certaines TUIs aiment re-render quand TERM change
      try { client.emit("resize"); } catch {}
      console.log("Telnet: Session connect.");
    });

    // Démarre une session (ton startApp)
    // IMPORTANT: ton app doit gérer screen.destroy() sur quit, etc.
    let sessionCleanup = null;
    try
    {
      sessionCleanup = createSession(io);
    }
    catch (e)
    {
      // Si ton app throw dès l’init, on ferme proprement
      try { client.end("Session error.\r\n"); } catch {}
      try { client.destroy(); } catch {}
      console.log("Telnet: Session error.");
      return;
    }

    // Cleanup quand le client se barre
    client.on("close", () =>
    {
      try { sessionCleanup && sessionCleanup(); } catch {}
      try { client.destroy(); } catch {}
      console.log("Telnet: Session ended.");
    });

    client.on("error", () =>
    {
      try { sessionCleanup && sessionCleanup(); } catch {}
      try { client.destroy(); } catch {}
    });
  });

  server.listen(port);
  console.log("Telnet: Session ready.");
  return server;
}

module.exports = { startTelnetServer };
