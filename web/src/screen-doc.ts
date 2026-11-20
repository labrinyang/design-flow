import { CSP } from "../../src/core/play.ts";
import type { Flow, Screen, Viewport } from "../../src/core/flow.ts";

export const DEFAULT_VIEWPORT: Viewport = { width: 390, height: 844 };
export const viewportOf = (flow: Flow, screen: Screen): Viewport => screen.viewport ?? flow.viewport ?? DEFAULT_VIEWPORT;

interface ElementLike {
  tagName: string;
  localName: string;
  id: string;
  parentElement: ElementLike | null;
  children: ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
}

/**
 * A stable CSS selector for `el` from the document body: data-id, then id, then an nth-of-type path.
 * Self-contained: the frame script embeds its source, where no outer helper exists.
 */
export function selectorFor(el: ElementLike, body: ElementLike): string {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  const parts: string[] = [];
  let cur: ElementLike | null = el;
  while (cur && cur !== body) {
    const dataId = cur.getAttribute("data-id");
    if (dataId) {
      parts.unshift(`[data-id="${esc(dataId)}"]`);
      break;
    }
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    const parent: ElementLike | null = cur.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
    parts.unshift(siblings.length > 1 ? `${cur.localName}:nth-of-type(${siblings.indexOf(cur) + 1})` : cur.localName);
    cur = parent;
  }
  return parts.join(" > ");
}

/** Runs inside the sandboxed frame. Reports clicks and hovers to the canvas; never touches the network. */
function frameScript(channel: string) {
  const sel = selectorFor.toString();
  return `<script>(function(){
var channel=${JSON.stringify(channel)};var commenting=false;var hovered=null;
var selectorFor=${sel};
function send(m){m.channel=channel;parent.postMessage(m,"*");}
var ring=document.createElement("div");
ring.style.cssText="position:fixed;pointer-events:none;outline:3px solid #ffcc00;outline-offset:2px;border-radius:4px;z-index:2147483647;display:none";
document.documentElement.appendChild(ring);
var pin=document.createElement("div");
pin.style.cssText="position:fixed;pointer-events:none;outline:3px solid #ffcc00;outline-offset:2px;background:rgba(255,204,0,.18);border-radius:4px;z-index:2147483646;display:none";
document.documentElement.appendChild(pin);
function place(box,el){if(!el||el===document.body||el===document.documentElement){box.style.display="none";return;}var r=el.getBoundingClientRect();box.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";}
function mark(el){place(ring,el);}
addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.channel!==channel)return;if(e.data.type==="commenting"){commenting=!!e.data.on;if(!commenting)mark(null);}
  if(e.data.type==="highlight"){var t=null;try{t=e.data.selector?document.querySelector(e.data.selector):null;}catch(_){}place(pin,t);}
  if(e.data.type==="snapshot"){ring.style.display="none";pin.style.display="none";var n=document.documentElement.cloneNode(true);n.querySelectorAll("body").forEach(function(b){b.style.height=innerHeight+"px";});n.querySelectorAll("script").forEach(function(x){x.remove();});var m=n.querySelector('meta[http-equiv]');if(m)m.remove();send({type:"snapshot",id:e.data.id,html:new XMLSerializer().serializeToString(n),width:innerWidth,height:innerHeight});}});
document.addEventListener("mousemove",function(e){if(!commenting)return;var el=e.target;if(el!==hovered){hovered=el;mark(el);}},true);
document.addEventListener("click",function(e){
  var el=e.target;
  if(commenting){e.preventDefault();e.stopPropagation();}
  if(!el||el===document.documentElement){send({type:"click",commenting:commenting,x:e.clientX,y:e.clientY});return;}
  var onBody=el===document.body;
  send({type:"click",commenting:commenting,x:e.clientX,y:e.clientY,
    element:onBody?null:{selector:selectorFor(el,document.body),tag:el.localName,text:(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||"").trim().replace(/\\s+/g," ").slice(0,80)}});
},true);
document.addEventListener("submit",function(e){e.preventDefault();},true);
send({type:"ready"});
})();</script>`;
}


/** The full document for one screen's sandboxed frame. */
export function screenDocument(flow: Flow, screen: Screen, opts: { channel: string }): string {
  const vp = viewportOf(flow, screen);
  const body =
    screen.html && screen.html.trim()
      ? screen.html
      : `<div data-empty style="display:flex;align-items:center;justify-content:center;height:100vh;font:14px system-ui;color:#888">${screen.id}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=${vp.width}">
<style>html,body{margin:0;min-height:100%}</style>
${flow.style ?? ""}
</head><body>${body}${frameScript(opts.channel)}</body></html>`;
}

export interface FrameClickData {
  screen: string;
  x: number;
  y: number;
  element: { selector: string; tag: string; text: string } | null;
}

/** A commenting click from a registered frame, checked against that frame's own window. */
export function acceptFrameMessage(
  e: { data: unknown; source: MessageEventSource | null },
  frames: Map<string, { screen: string; window: () => MessageEventSource | null | undefined }>,
): FrameClickData | undefined {
  const d = e.data as { channel?: unknown; type?: unknown; commenting?: unknown; x?: unknown; y?: unknown; element?: FrameClickData["element"] };
  if (!d || typeof d.channel !== "string" || d.type !== "click" || d.commenting !== true) return undefined;
  const f = frames.get(d.channel);
  if (!f || !e.source || e.source !== f.window()) return undefined;
  if (typeof d.x !== "number" || typeof d.y !== "number") return undefined;
  return { screen: f.screen, x: d.x, y: d.y, element: d.element ?? null };
}

/** SVG image of a frame's cloned document, sized as the frame's viewport so vh/% layouts keep their shape. */
export function snapshotSvg(html: string, width: number, height: number): string {
  const sized = html.replace(/<html\b([^>]*)>/, (_m, attrs: string) => {
    const pin = `width:${width}px;height:${height}px;overflow:hidden;`;
    return /\sstyle="/.test(attrs) ? `<html${attrs.replace(/\sstyle="/, ` style="${pin}`)}>` : `<html${attrs} style="${pin}">`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${sized}</foreignObject></svg>`;
}

/** Inline style for a frame's snapshot <img>: the iframe's own size/transform, immune to img { max-width:100%; height:auto }. */
export function snapshotImageStyle(frameStyle: string, width: number, height: number): string {
  return `${frameStyle} width: ${width}px; height: ${height}px; max-width: none; max-height: none; display: block;`;
}
