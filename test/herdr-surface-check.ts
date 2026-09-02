import { isMuxAvailable, createSurface, sendCommand, readScreen, closeSurface } from "../pi-extension/subagents/tmux.ts";
import assert from "node:assert";
assert.ok(isMuxAvailable(), "herdr should be available");
const p = createSurface("surface-check");
console.log("created", p);
sendCommand(p, "echo SURFACE_OK_$((6*7))");
await new Promise((r) => setTimeout(r, 1500));
const screen = readScreen(p, 20);
assert.match(screen, /SURFACE_OK_42/, `sentinel not found in:\n${screen}`);
closeSurface(p);
await new Promise((r) => setTimeout(r, 500));
let gone = false;
try { readScreen(p, 3); } catch { gone = true; }
assert.ok(gone, "pane should be gone after close");
console.log("surface check passed");
