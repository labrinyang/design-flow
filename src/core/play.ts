import type { Flow } from "./flow.ts";

/** Content security policy of every screen frame: scripts run, nothing reaches the network. */
export const CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Runs inside the Play frame. Shows one section at a time; anything with data-to="ID" moves to that
 * screen and data-back to the previous one. Tells the host which screen is showing so it can draw the back/forward controls.
 */
function playScript(start: string, channel: string) {
  return `<script>(function(){
var channel=${JSON.stringify(channel)};var history=[];var current=null;
function sections(){return Array.prototype.slice.call(document.querySelectorAll("[data-screen]"));}
function show(id,push){var all=sections();var hit=all.filter(function(s){return s.getAttribute("data-screen")===id;})[0];if(!hit)return;
  if(push&&current&&current!==id)history.push(current);
  all.forEach(function(s){s.hidden=s!==hit;});current=id;scrollTo(0,0);
  parent.postMessage({channel:channel,type:"screen",id:id,canBack:history.length>0},"*");}
document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target:null;if(!t)return;
  var b=t.closest("[data-back]");if(b){e.preventDefault();if(history.length)show(history.pop(),false);return;}
  var el=t.closest("[data-to]");if(!el)return;e.preventDefault();show(el.getAttribute("data-to"),true);},true);
document.addEventListener("submit",function(e){e.preventDefault();},true);
document.addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({channel:channel,type:"escape"},"*");});
addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.channel!==channel)return;
  if(e.data.type==="go")show(e.data.id,true);
  if(e.data.type==="back"&&history.length)show(history.pop(),false);});
show(${JSON.stringify(start)},false);
})();</script>`;
}

const head = (inner: string, width: number) => `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=${width}">
<style>html,body{margin:0;min-height:100%}[data-screen][hidden]{display:none!important}</style>
${inner}`;

/** The whole flow as one interactive page: prototype.html as written, or one built from each screen's html. */
export function playDocument(flow: Flow, prototype: string | undefined, opts: { start: string; channel: string }): string {
  const width = flow.viewport?.width ?? 390;
  const script = playScript(opts.start, opts.channel);
  if (prototype !== undefined) {
    const withHead = /<head\b[^>]*>/i.test(prototype)
      ? prototype.replace(/<head\b[^>]*>/i, (m) => `${m}${head("", width)}`)
      : `<!doctype html><html><head>${head("", width)}</head><body>${prototype}</body></html>`;
    return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${script}</body>`) : withHead + script;
  }
  const body = flow.screens.map((s) => `<section data-screen="${s.id}">${s.html ?? ""}</section>`).join("\n");
  return `<!doctype html><html><head>${head(flow.style ?? "", width)}</head><body>${body}${script}</body></html>`;
}
