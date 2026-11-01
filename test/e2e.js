// End-to-end check for the revived eDEX-UI: boots the real app, exercises the terminal, attacks the websocket.
const {_electron} = require("playwright-core");
const WebSocket = require("../src/node_modules/ws");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");

const EDEX = path.join(__dirname, ".."), OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "edex-e2e-out-")), PORT = 3900;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edex-e2e-"));
fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({
    shell: "powershell.exe", shellArgs: "", cwd: tmp, keyboard: "en-US", theme: "tron", termFontSize: 15,
    audio: false, audioVolume: 0, disableFeedbackAudio: true, clockHours: 24, pingAddr: "1.1.1.1", port: PORT,
    nointro: true, nocursor: false, forceFullscreen: false, allowWindowed: true, excludeThreadsFromToplist: true,
    hideDotfiles: false, fsListView: false, experimentalGlobeFeatures: false, experimentalFeatures: false,
    ...(process.env.E2E_IFACE ? {iface: process.env.E2E_IFACE} : {})
}));
fs.writeFileSync(path.join(tmp, "lastWindowState.json"), JSON.stringify({useFullscreen: false}));

const results = [];
const check = (name, ok, extra = "") => { results.push({name, ok}); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function wsAttempt(url, headers) {
    return new Promise(res => {
        const s = new WebSocket(url, {headers});
        const t = setTimeout(() => { s.terminate(); res("timeout"); }, 4000);
        s.on("open", () => { clearTimeout(t); s.close(); res("OPEN"); });
        s.on("unexpected-response", (_, r) => { clearTimeout(t); res("HTTP " + r.statusCode); });
        s.on("error", e => { clearTimeout(t); res("error " + e.code); });
    });
}

(async () => {
    const app = await _electron.launch({
        executablePath: process.env.E2E_EXE || path.join(EDEX, "node_modules/electron/dist/electron.exe"),
        args: [...(process.env.E2E_EXE ? [] : [path.join(EDEX, "src")]), "--nointro", `--user-data-dir=${tmp}`],
        env: {...process.env, ELECTRON_RUN_AS_NODE: undefined},
        timeout: 60000
    });
    const main = [];
    app.process().stdout.on("data", d => main.push(String(d)));
    app.process().stderr.on("data", d => main.push(String(d)));
    const win = await app.firstWindow();
    const errors = [];
    win.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    win.on("pageerror", e => errors.push("pageerror: " + e.message));
    const cdp = await win.context().newCDPSession(win);
    const ev = async (fn, arg) => {
        const r = await cdp.send("Runtime.evaluate", {expression: `(${fn})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true});
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
        return r.result.value;
    };
    for (let i = 0; i < 40; i++) {
        if (await ev("() => !!(window.term && window.term[0] && window.term[0].socket && window.term[0].socket.readyState === 1)").catch(() => false)) break;
        await wait(1000);
    }
    await wait(9000);

    const bootText = await ev(() => document.getElementById("boot_screen") ? document.getElementById("boot_screen").innerText : "");
    check("UI booted without boot-screen error", !/Error|at file/.test(bootText), bootText.slice(0, 300));
    const mods = await ev(() => Object.keys(window.mods || {}));
    check("system modules loaded", mods.length >= 8, mods.join(","));

    const marker = "REVIVED" + Date.now();
    await ev(m => window.term[0].writelr(`echo ${m}; $PSVersionTable.PSVersion.Major`), marker);
    await wait(4000);
    const buf = await ev(() => { const b = window.term[0].term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + "\n"; } return s; });
    check("terminal executes real shell command", (buf.match(new RegExp(marker, "g")) || []).length >= 2);

    await wait(1000);
    fs.writeFileSync(path.join(OUT, "pixel.png"), await win.screenshot({clip: {x: 700, y: 480, width: 30, height: 30}}));
    check("webgl renderer active", await ev(() => !!document.querySelector(".xterm-screen canvas")));
    await wait(Number(process.env.E2E_SETTLE || 0));
    await win.screenshot({path: path.join(OUT, "edex-revived.png")});

    // Real key events, as a user would type them
    const typed = "TYPED" + Date.now();
    await ev(() => window.term[0].term.focus());
    await win.keyboard.type(`echo ${typed}`, {delay: 15});
    await win.keyboard.press("Enter");
    await wait(3000);
    const buf2 = await ev(() => { const b = window.term[0].term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + "\n"; } return s; });
    check("keyboard input reaches the shell", (buf2.match(new RegExp(typed, "g")) || []).length >= 2);

    // Attack: CVE-2023-30856 style connections
    const url = `ws://127.0.0.1:${PORT}/`;
    check("attack: evil origin, no token rejected", (await wsAttempt(url, {Origin: "https://evil.example"})) === "HTTP 401");
    check("attack: file origin, no token rejected", (await wsAttempt(url, {Origin: "file://"})) === "HTTP 401");
    check("attack: no origin, wrong token rejected", (await wsAttempt(url + "?token=deadbeef", {})) === "HTTP 401");
    const token = await ev(p => require("electron").ipcRenderer.sendSync("terminal_token-" + p), PORT);
    check("attack: stolen token with evil origin rejected", (await wsAttempt(url + "?token=" + token, {Origin: "https://evil.example"})) === "HTTP 401");
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal);
    if (lan) check("not reachable from LAN address", /ECONNREFUSED|timeout|EHOSTUNREACH/.test(await wsAttempt(`ws://${lan.address}:${PORT}/`, {})));

    // Extra tab
    await ev(() => window.term[0] && window.focusShellTab && window.focusShellTab(1));
    await wait(5000);
    const tab = await ev(() => !!(window.term[1] && window.term[1].socket && window.term[1].socket.readyState === 1));
    check("second terminal tab connects", tab);

    // Attack an idle terminal: no client attached, so only origin and token checks can reject
    const reply = await ev(`() => new Promise(r => { const {ipcRenderer: i} = require("electron"); i.once("ttyspawn-reply", (e, m) => r(m)); i.send("ttyspawn", "true"); })`);
    const idle = Number(reply.replace("SUCCESS: ", ""));
    await wait(2500);
    const idleUrl = `ws://127.0.0.1:${idle}/`;
    const idleToken = await ev(p => require("electron").ipcRenderer.sendSync("terminal_token-" + p), idle);
    console.log("idle port", idle);
    check("idle: evil origin + no token rejected", (await wsAttempt(idleUrl, {Origin: "https://evil.example"})) === "HTTP 401");
    check("idle: file origin + no token rejected", (await wsAttempt(idleUrl, {Origin: "file://"})) === "HTTP 401");
    check("idle: file origin + wrong token rejected", (await wsAttempt(idleUrl + "?token=" + "0".repeat(64), {Origin: "file://"})) === "HTTP 401");
    check("idle: real token + evil origin rejected", (await wsAttempt(idleUrl + "?token=" + idleToken, {Origin: "https://evil.example"})) === "HTTP 401");
    check("idle: real token + no origin rejected", (await wsAttempt(idleUrl + "?token=" + idleToken, {})) === "HTTP 401");
    check("control: real token + file origin accepted", (await wsAttempt(idleUrl + "?token=" + idleToken, {Origin: "file://"})) === "OPEN");

    // Clipboard path used by the paste shortcut
    const clip = await ev(async () => { try { remote.clipboard.writeText("edex-clip"); return remote.clipboard.readText(); } catch (e) { return "ERR " + e.message; } });
    check("clipboard API works", clip === "edex-clip", clip);

    fs.writeFileSync(path.join(OUT, "errors.txt"), errors.join("\n") + "\n--- main ---\n" + main.join(""));
    console.log("renderer errors:", errors.length);
    errors.slice(0, 15).forEach(e => console.log("  " + e.slice(0, 220)));
    await app.close().catch(() => {});
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
