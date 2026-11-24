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

interface ScrollerLike {
  nodeType: number;
  parentElement: ScrollerLike | null;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

/**
 * Whether a wheel of (dx, dy) over `el` scrolls something inside the frame: a scroll area around `el`,
 * or the page itself, with room left that way.
 * Self-contained: the frame script embeds its source, where no outer helper exists.
 */
export function scrollsInside(
  el: ScrollerLike | null,
  dx: number,
  dy: number,
  doc: { scrollingElement: ScrollerLike | null; documentElement: ScrollerLike; body: ScrollerLike | null },
  style: (el: ScrollerLike) => { overflowX: string; overflowY: string },
): boolean {
  const root = doc.scrollingElement ?? doc.documentElement;
  let page = style(doc.documentElement);
  // The page scrolls by html's overflow, or by body's when html leaves both axes visible.
  const bodyLends = page.overflowX === "visible" && page.overflowY === "visible" && !!doc.body;
  if (bodyLends && doc.body) page = style(doc.body);
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    let canX: boolean;
    let canY: boolean;
    if (cur === root) {
      canX = !/hidden|clip/.test(page.overflowX);
      canY = !/hidden|clip/.test(page.overflowY);
    } else if (cur === doc.body && bodyLends) {
      continue;
    } else {
      const s = style(cur);
      canX = /auto|scroll|overlay/.test(s.overflowX);
      canY = /auto|scroll|overlay/.test(s.overflowY);
    }
    if (dy && canY && (dy > 0 ? cur.scrollTop + cur.clientHeight < cur.scrollHeight - 1 : cur.scrollTop > 0)) return true;
    if (dx && canX && (dx > 0 ? cur.scrollLeft + cur.clientWidth < cur.scrollWidth - 1 : cur.scrollLeft > 0)) return true;
  }
  return false;
}

/**
 * Runs inside the sandboxed frame. Reports clicks and hovers to the canvas; never touches the network.
 * A frame takes the pointer while commenting, so it also hands wheels to the canvas, which pans and
 * zooms under it as everywhere else. Ctrl or ⌘ (and a pinch) always zoom the canvas. A plain wheel
 * first scrolls the screen while it, or a scroll area under the pointer, has room left that way, as a
 * nested scroll area would; one gesture stays with whichever it started on.
 */
function frameScript(channel: string) {
  const sel = selectorFor.toString();
  const scroll = scrollsInside.toString();
  return `<script>(function(){
var channel=${JSON.stringify(channel)};var commenting=false;var hovered=null;
var selectorFor=${sel};var scrollsInside=${scroll};var wheelTo=null,wheelAt=0,pinned=null;
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
  if(e.data.type==="highlight"){var t=null;try{t=e.data.selector?document.querySelector(e.data.selector):null;}catch(_){}pinned=t;place(pin,t);}
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
addEventListener("wheel",function(e){
  if(!e.ctrlKey&&!e.metaKey){var now=Date.now();
    if(wheelTo===null||now-wheelAt>200)wheelTo=scrollsInside(e.target,e.deltaX,e.deltaY,document,function(x){return getComputedStyle(x);})?"frame":"canvas";
    wheelAt=now;if(wheelTo==="frame")return;}
  e.preventDefault();send({type:"wheel",x:e.clientX,y:e.clientY,dx:e.deltaX,dy:e.deltaY,mode:e.deltaMode,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey,alt:e.altKey});},{passive:false});
addEventListener("scroll",function(){if(commenting&&hovered)mark(hovered);if(pinned)place(pin,pinned);},true);
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

/** A wheel or pinch over a frame, in the frame's own CSS px, to be replayed on the canvas. */
export interface FrameWheelData {
  channel: string;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A wheel from a registered frame, checked against that frame's own window. */
export function acceptFrameWheel(
  e: { data: unknown; source: MessageEventSource | null },
  frames: Map<string, { window: () => MessageEventSource | null | undefined }>,
): FrameWheelData | undefined {
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d.channel !== "string" || d.type !== "wheel") return undefined;
  const f = frames.get(d.channel);
  if (!f || !e.source || e.source !== f.window()) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const [x, y, deltaX, deltaY, deltaMode] = [num(d.x), num(d.y), num(d.dx), num(d.dy), num(d.mode)];
  if (x === undefined || y === undefined || deltaX === undefined || deltaY === undefined || deltaMode === undefined) return undefined;
  return { channel: d.channel, x, y, deltaX, deltaY, deltaMode, ctrlKey: d.ctrl === true, metaKey: d.meta === true, shiftKey: d.shift === true, altKey: d.alt === true };
}

/** Where a point inside a frame (its own CSS px) is on the page, from the frame's on-screen box and its CSS width. */
export function frameToClient(p: { x: number; y: number }, rect: { left: number; top: number; width: number }, frameWidth: number) {
  const k = rect.width / frameWidth;
  return { x: rect.left + p.x * k, y: rect.top + p.y * k };
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
