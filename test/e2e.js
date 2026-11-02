// End-to-end check for the revived eDEX-UI: boots the real app, exercises the terminal, attacks the websocket.
const {_electron} = require("playwright-core");
const WebSocket = require("../src/node_modules/ws");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");

const EDEX = path.join(__dirname, ".."), OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "edex-e2e-out-")), PORT = 3900;
// realpath because CI's temp dir can be an 8.3 short path, while shells report the long form
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "edex-e2e-")));
fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({
    shell: process.env.E2E_SHELL || "powershell.exe", shellArgs: "", cwd: tmp, keyboard: "en-US", theme: "tron", termFontSize: 15,
    audio: false, audioVolume: 0, disableFeedbackAudio: true, clockHours: 24, pingAddr: "1.1.1.1", port: PORT,
    nointro: true, nocursor: false, forceFullscreen: false, allowWindowed: true, excludeThreadsFromToplist: true,
    hideDotfiles: false, fsListView: false, experimentalGlobeFeatures: false, experimentalFeatures: false,
    ...(process.env.E2E_IFACE ? {iface: process.env.E2E_IFACE} : {})
}));
fs.writeFileSync(path.join(tmp, "lastWindowState.json"), JSON.stringify({useFullscreen: false}));

const results = [];
const check = (name, ok, extra = "") => { results.push({name, ok}); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// Two pages: Latin text with a standard font, then Chinese that relies on CMaps and has no embedded font
function makePdf() {
    const pages = ["BT /F1 36 Tf 72 700 Td (eDEX Afterlife) Tj ET", "BT /F2 36 Tf 72 700 Td <4E2D6587> Tj ET"];
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F2 8 0 R >> >> >>",
        ...pages.map(c => `<< /Length ${c.length} >>
stream
${c}
endstream`),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [9 0 R] >>",
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>"
    ];
    let pdf = "%PDF-1.7\n";
    const offsets = objects.map((o, i) => { const at = pdf.length; pdf += `${i+1} 0 obj
${o}
endobj
`; return at; });
    const xref = pdf.length;
    pdf += `xref
0 ${objects.length+1}
0000000000 65535 f 
` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    return pdf + `trailer
<< /Size ${objects.length+1} /Root 1 0 R >>
startxref
${xref}
%%EOF
`;
}

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
    const warnings = [];
    win.on("console", m => { if (m.type() === "error") errors.push(m.text()); else if (m.type() === "warning") warnings.push(m.text()); });
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

    // Slow machines can take far longer to reach a prompt, so poll instead of sleeping
    const readTerm = () => ev(() => { const b = window.term[0].term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += (l.isWrapped ? "" : "\n") + l.translateToString(true); } return s; });
    const until = async (test, ms = Number(process.env.E2E_TIMEOUT || 45000)) => {
        for (const end = Date.now() + ms; Date.now() < end; await wait(500)) {
            if (await test()) return true;
        }
        return false;
    };
    const untilTermShows = async (text, count = 2) => {
        const shown = await until(async () => (await readTerm()).split(text).length - 1 >= count);
        if (!shown) console.log("Terminal contents:\n" + (await readTerm()).trimEnd().split("\n").slice(-12).join("\n"));
        return shown;
    };
    check("shell reaches a prompt", await until(async () => />\s*$/.test((await readTerm()).trimEnd())));

    const bootText = await ev(() => document.getElementById("boot_screen") ? document.getElementById("boot_screen").innerText : "");
    check("UI booted without boot-screen error", !/Error|at file/.test(bootText), bootText.slice(0, 300));
    const mods = await ev(() => Object.keys(window.mods || {}));
    check("system modules loaded", mods.length >= 8, mods.join(","));

    const marker = "REVIVED" + Date.now();
    await ev(m => window.term[0].writelr(`echo ${m}; $PSVersionTable.PSVersion.Major`), marker);
    check("terminal executes real shell command", await untilTermShows(marker));

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
    check("keyboard input reaches the shell", await untilTermShows(typed));

    // Text that doesn't map to plain key events, which is how IMEs commit Chinese
    await win.keyboard.type("echo 中文输入", {delay: 10});
    await win.keyboard.press("Enter");
    check("non-ASCII input reaches the shell", await untilTermShows("中文输入"));

    // The file browser follows the shell, including non-ASCII paths with spaces
    const cwdTarget = path.join(tmp, "edex 中文 test");
    fs.mkdirSync(cwdTarget);
    fs.writeFileSync(path.join(cwdTarget, "cwd-marker.txt"), "");
    fs.writeFileSync(path.join(cwdTarget, "edex-test.pdf"), makePdf(), "latin1");
    await ev(p => window.term[0].writelr(`cd "${p}"`), cwdTarget);
    if (!await until(async () => (await ev(() => window.fsDisp.cwd_path)) === cwdTarget)) {
        console.log("Terminal cwd:", await ev(() => window.term[0].cwd));
        console.log("Terminal contents:\n" + (await readTerm()).trimEnd().split("\n").slice(-10).join("\n"));
        await win.screenshot({path: path.join(OUT, "cwd-failure.png")});
    }
    await wait(1500);
    const fsState = await ev(() => JSON.stringify({
        path: window.fsDisp.cwd_path, tracking: !window.fsDisp._noTracking,
        title: document.querySelector("section#filesystem > h3.title > p:first-of-type").innerText,
        marker: !!Array.from(document.querySelectorAll("#fs_disp_container h3")).find(e => e.innerText.includes("cwd-marker"))
    }));
    const fsInfo = JSON.parse(fsState);
    check("file browser tracks the shell directory", fsInfo.tracking && fsInfo.path === cwdTarget && !/TRACKING FAILED/.test(fsInfo.title), fsState);
    check("file browser lists the new directory", fsInfo.marker);

    // PDF viewer, opened from a non-ASCII path. Includes Chinese without embedded fonts and page navigation
    const pdfInk = () => ev(() => { const c = document.querySelector(".pdf_canvas"); if (!c || !c.width) return 0; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n; });
    await ev(() => window.fsDisp.openFile(window.fsDisp.cwd.findIndex(f => f.name === "edex-test.pdf")));
    const pdfOpened = await until(async () => (await ev(() => (document.querySelector(".page_count") || {}).textContent)) === "2" && (await pdfInk()) > 200);
    check("PDF viewer renders the first page", pdfOpened, `ink=${await pdfInk()}`);
    await ev(() => document.querySelector(".next_page").click());
    await until(async () => (await ev(() => document.querySelector(".page_num").textContent)) === "2");
    await wait(2500);
    await win.screenshot({path: path.join(OUT, "pdf-page2.png")});
    check("PDF viewer renders Chinese without embedded fonts", (await pdfInk()) > 200, `ink=${await pdfInk()}`);
    check("PDF work runs in a real worker", !warnings.some(w => /fake worker/i.test(w)));
    await ev(() => Object.values(window.modals).forEach(m => m.close()));
    await ev(() => window.term[0].term.focus());

    const tabTitle = await ev(() => document.getElementById("shell_tab0").innerText);
    check("tab shows the shell name", /MAIN - (powershell|cmd)/i.test(tabTitle), tabTitle);

    if (process.env.E2E_EXPECT_IFACE) {
        await wait(5000);
        const netState = await ev(() => JSON.stringify({iface: window.mods.netstat.iface, offline: window.mods.netstat.offline}));
        const netInfo = JSON.parse(netState);
        check("network panel picks the routed interface", netInfo.iface === process.env.E2E_EXPECT_IFACE && netInfo.offline === false, netState);
    }

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

    // Each tab keeps its own directory, and the file browser follows the active one
    const tabTarget = path.join(tmp, "second tab dir");
    fs.mkdirSync(tabTarget);
    await until(async () => /> *$/.test(await ev(() => { const b = window.term[1].term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + "\n"; } return s.trimEnd(); })));
    await ev(p => window.term[1].writelr(`cd "${p}"`), tabTarget);
    check("file browser follows the active tab", await until(async () => (await ev(() => window.fsDisp.cwd_path)) === tabTarget));
    await ev(() => window.focusShellTab(0));
    check("file browser returns with the first tab", await until(async () => (await ev(() => window.fsDisp.cwd_path)) === cwdTarget));

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
