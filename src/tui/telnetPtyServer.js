const net = require("net");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");

function startTelnetPtyServer(port = 2323)
{
    const projectRoot = process.cwd();
    const scriptPath = path.join(projectRoot, "midistage.js");

    if (!fs.existsSync(scriptPath))
    {
        throw new Error(`midistage.js introuvable: ${scriptPath} (lance depuis la racine du projet)`);
    }

    const nodePath = process.execPath; // chemin absolu du node en cours
    if (!fs.existsSync(nodePath))
    {
        throw new Error(`Node introuvable: ${nodePath}`);
    }

    const server = net.createServer((socket) =>
    {
        socket.setNoDelay(true);
        socket.setKeepAlive(true);

        let term;
        try
        {
            term = pty.spawn(nodePath, [scriptPath, "--local"], {
                name: "xterm-256color",
                cols: 80,
                rows: 24,
                cwd: projectRoot,
                env: {
                    ...process.env,
                    TERM: "xterm-256color"
                }
            });
        }
        catch (e)
        {
            socket.write(`ERR spawning PTY: ${e.message}\r\n`);
            socket.end();
            return;
        }

        term.onData((data) =>
        {
            socket.write(data.replace(/\n/g, "\r\n"));
        });

        socket.on("data", (buf) =>
        {
            // Minimal: on envoie en UTF-8
            term.write(buf.toString("utf8"));
        });

        const cleanup = () =>
        {
            try { term.kill(); } catch {}
            try { socket.end(); } catch {}
        };

        socket.on("close", cleanup);
        socket.on("end", cleanup);
        socket.on("error", cleanup);
    });

    server.listen(port, "0.0.0.0", () =>
    {
        console.log(`MIDISTAGE PTY Telnet server on port ${port}`);
        console.log(`Connect: telnet <ip> ${port}`);
        console.log(`Node: ${process.execPath}`);
        console.log(`Script: ${path.join(process.cwd(), "midistage.js")}`);
    });

    return server;
}

module.exports = { startTelnetPtyServer };
