import type { Flow } from "./flow.ts";
import { playDocument } from "./play.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The flow as one HTML file anyone can open: the screens run in a sandboxed frame scaled to fit the
 * window, with a list of screens to jump to. No network, no build, no server.
 */
export function shareDocument(flow: Flow, prototype: string | undefined, opts: { start: string }): string {
  const vp = flow.viewport ?? { width: 390, height: 844 };
  const channel = "share";
  const inner = playDocument(flow, prototype, { start: opts.start, channel });
  const stops = flow.screens
    .map((s) => `<button type="button" data-go="${esc(s.id)}"><b>${esc(s.id)}</b>${esc(s.title)}</button>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(flow.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#efece6;--ink:#1d1a17;--muted:#6c6660;--panel:#faf8f5;--line:#dfdad3;--on:#ffcc00}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--ink:#f1ede7;--muted:#9a938b;--panel:#1d1a17;--line:#34302b}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif}
body{display:grid;grid-template-columns:240px 1fr;grid-template-rows:auto 1fr}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{margin:0;font-size:17px;font-weight:600}header p{margin:0;color:var(--muted);font-size:12px}
header .sp{flex:1}header button{border:1px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer}
header button:disabled{opacity:.4;cursor:default}
nav{overflow:auto;padding:10px;border-right:1px solid var(--line)}
nav button{display:flex;gap:8px;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:7px 10px;border-radius:10px;cursor:pointer}
nav button b{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:500;min-width:2.6em}
nav button:hover{background:var(--panel)}nav button[aria-current=true]{background:var(--panel);box-shadow:inset 3px 0 0 var(--on)}
main{position:relative;overflow:hidden}
#stage{position:absolute;left:50%;top:50%;transform-origin:center;border-radius:28px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.08);background:#fff}
#stage iframe{display:block;border:0}
@media (max-width:720px){body{grid-template-columns:1fr}nav{display:none}}
</style></head>
<body>
<header><div><h1>${esc(flow.title)}</h1>${flow.subtitle ? `<p>${esc(flow.subtitle)}</p>` : ""}</div><span class="sp"></span>
<button type="button" id="back" disabled>← Back</button><button type="button" id="restart">Restart</button></header>
<nav aria-label="Screens">${stops}</nav>
<main><div id="stage" style="width:${vp.width}px;height:${vp.height}px"><iframe id="screen" title="${esc(flow.title)}" sandbox="allow-scripts" width="${vp.width}" height="${vp.height}"></iframe></div></main>
<script>
(function(){
var DOC=${JSON.stringify(inner).replace(/</g, "\\u003c")};
var START=${JSON.stringify(opts.start)};var W=${vp.width},H=${vp.height};var CH=${JSON.stringify(channel)};
var frame=document.getElementById("screen");var stage=document.getElementById("stage");var main=document.querySelector("main");
var back=document.getElementById("back");
function fit(){var r=main.getBoundingClientRect();var s=Math.min((r.width-48)/W,(r.height-48)/H);stage.style.transform="translate(-50%,-50%) scale("+s+")";}
addEventListener("resize",fit);fit();
frame.srcdoc=DOC;
function post(m){m.channel=CH;frame.contentWindow.postMessage(m,"*");}
addEventListener("message",function(e){if(e.source!==frame.contentWindow||!e.data||e.data.channel!==CH||e.data.type!=="screen")return;
  back.disabled=!e.data.canBack;
  document.querySelectorAll("nav button").forEach(function(b){b.setAttribute("aria-current",String(b.getAttribute("data-go")===e.data.id));});});
document.querySelector("nav").addEventListener("click",function(e){var b=e.target.closest("[data-go]");if(b)post({type:"go",id:b.getAttribute("data-go")});});
back.addEventListener("click",function(){post({type:"back"});});
document.getElementById("restart").addEventListener("click",function(){frame.srcdoc=DOC;});
addEventListener("keydown",function(e){if(e.key==="Backspace"||(e.key==="ArrowLeft"&&e.altKey))post({type:"back"});});
})();
</script>
</body></html>
`;
}
