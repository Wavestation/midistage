# MIDISTAGE

MIDISTAGE is a Node.js terminal tool for managing hardware synth patches and recalling them reliably on stage.

It reads MIDINameDocument (.midnam) files to display banks/patch names, lets you map them to your real MIDI outputs and channels (“machines”), and builds setlists so you can recall patches instantly via MIDI Program Change (and bank selection when needed).  
The UI runs locally or remotely over Telnet / serial TTY (RS-232).

## Features

- **TUI (terminal UI)** with lists for Machines / Banks / Patches and a status console.
- **.midnam support** (Apple/CoreMIDI MIDINameDocument XML) to browse patch names by bank.
- **Search** patches by name/program (global search across banks).
- **Machine management**
  - Create / edit / delete machines (friendly name, MIDNAM file, MIDI channel, MIDI output).
  - Auto-fill synth name from the selected MIDNAM device name.
  - Assign MIDI outputs to machines.
- **Live patch recall**
  - Send **Program Change** and **Bank Select** (MSB/LSB when applicable) to the selected machine.
- **Setlists**
  - Build a “draft” of routes across multiple machines.
  - Save drafts as entries (“cues”), rename/delete entries, recall a cue to switch multiple devices at once.
- **Multiple access modes**
  - Local terminal
  - Remote **Telnet**
  - Remote **Serial/RS-232 TTY** (ANSI color friendly, CRLF output)

## Dependencies

### Runtime (npm)
- **blessed**: terminal user interface widgets (lists, boxes, input, focus handling).
- **midi**: MIDI I/O (list outputs, send Program Change / Bank Select).
- **serialport**: RS-232 / serial TTY support.

## Optional / Notes
- MIDI can be mocked via `MIDI_MOCK=1` (useful for dev without hardware).
- Remote access modes depend on your server modules (Telnet / serial wrapper).

## Development & Test Environment

MIDISTAGE is primarily developed and tested in the following environment:

- **Main runtime machine**:  
  Raspberry Pi 4 Model B (8 GB RAM)  
  Debian Trixie 64-bit  
  Node.js v24

- **Remote terminal access**:  
  Lenovo S10-3t using **PuTTY** on Windows 7
  Connection via **Telnet**  
  Terminal emulation: **xterm-256color**

- **MIDI interface**:  
  iConnectivity **mioXL**  
  Connected to the Raspberry Pi via **RTP-MIDI**  
  RTP stack: `rtpmidid` by David Moreno

This setup allows MIDISTAGE to run headless on the Raspberry Pi while being fully controlled remotely from a terminal, with low-latency MIDI routing over the network.
