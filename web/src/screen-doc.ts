import { CSP } from "../../src/core/play.ts";
import type { Flow, Screen, Viewport } from "../../src/core/flow.ts";
import { annotateLines } from "../../src/core/lines.ts";
import type { FrameElement } from "./anchor.ts";

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

interface TextLike {
  innerText?: string;
  textContent?: string | null;
  parentElement: TextLike | null;
}

/**
 * Text around an element, so an agent reading a comment knows where it is: the nearest ancestor, up to
 * four levels up, with more text than the element itself, whitespace collapsed and cut to max characters.
 * Self-contained: the frame script embeds its source, where no outer helper exists.
 */
export function nearText(el: TextLike, max: number): string {
  const read = (n: TextLike) => String(n.innerText ?? n.textContent ?? "").replace(/\s+/g, " ").trim();
  const own = read(el);
  let cur = el.parentElement;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    const text = read(cur);
    if (text.length > own.length) return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  return "";
}

/**
 * Runs inside the sandboxed frame. Reports clicks and hovers to the canvas; never touches the network.
 * A frame takes the pointer while commenting, so it also hands wheels to the canvas, which pans and
 * zooms under it as everywhere else. Ctrl or ⌘ (and a pinch) always zoom the canvas. A plain wheel
 * first scrolls the screen while it, or a scroll area under the pointer, has room left that way, as a
 * nested scroll area would; one gesture stays with whichever it started on.
 *
 * The canvas pauses a screen's motion while it is too small to watch or off screen ("motion"): CSS
 * animations pause, and requestAnimationFrame callbacks wait. It asks where commented elements are now
 * ("locate"), so pins follow them when the screen changes, and can ring one element for a moment ("flash").
 */
function frameScript(channel: string) {
  const sel = selectorFor.toString();
  const scroll = scrollsInside.toString();
  const near = nearText.toString();
  return `<script>(function(){
var channel=${JSON.stringify(channel)};var commenting=false;var hovered=null;
var selectorFor=${sel};var scrollsInside=${scroll};var nearText=${near};var wheelTo=null,wheelAt=0,pinned=null;
function send(m){m.channel=channel;parent.postMessage(m,"*");}
var still=null,stopped=[],waiting=[],raf=typeof requestAnimationFrame==="function"?requestAnimationFrame.bind(window):null;
if(raf)window.requestAnimationFrame=function(cb){if(still){waiting.push(cb);return 0;}return raf(cb);};
function motion(on){
  if(on){if(!still)return;still.remove();still=null;stopped.forEach(function(a){try{a.play();}catch(_){}});stopped=[];var q=waiting;waiting=[];q.forEach(function(cb){raf(cb);});return;}
  if(still)return;still=document.createElement("style");still.setAttribute("data-df-chrome","");still.textContent="*,*::before,*::after{animation-play-state:paused!important}";(document.head||document.documentElement).appendChild(still);
  stopped=document.getAnimations?document.getAnimations().filter(function(a){return a.playState==="running";}):[];stopped.forEach(function(a){a.pause();});}
var asked=null,told="",locateAt=0;
function locate(){if(!asked)return;var out=asked.map(function(it){var t=null;try{t=document.querySelector(it.selector);}catch(_){}if(!t)return{id:it.id,missing:true};var r=t.getBoundingClientRect();return{id:it.id,x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};});
  var s=JSON.stringify(out);if(s===told)return;told=s;send({type:"located",items:out});}
function relocate(){clearTimeout(locateAt);locateAt=setTimeout(locate,150);}
if(typeof ResizeObserver==="function")new ResizeObserver(relocate).observe(document.documentElement);
if(typeof MutationObserver==="function"&&document.body)new MutationObserver(relocate).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["class","hidden","open"]});
function box(css){var b=document.createElement("div");b.setAttribute("data-df-chrome","");b.style.cssText="position:fixed;pointer-events:none;outline:2px solid rgb(20,18,14);outline-offset:2px;box-shadow:0 0 0 2px #fff;border-radius:4px;display:none;"+css;document.documentElement.appendChild(b);return b;}
var ring=box("z-index:2147483647"),pin=box("z-index:2147483646;background:rgba(20,18,14,.06)"),flash=box("z-index:2147483646;background:rgba(20,18,14,.08);transform-origin:50% 50%"),flashAt=0;
function find(sel){try{return sel?document.querySelector(sel):null;}catch(_){return null;}}
function flashOn(t){if(!t)return;try{t.scrollIntoView({block:"nearest",inline:"nearest"});}catch(_){}place(flash,t);clearTimeout(flashAt);
  var calm=typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,anim=!calm&&!!flash.animate;
  if(anim)flash.animate([{transform:"scale(1)"},{transform:"scale(1.06)"},{transform:"scale(1)"}],{duration:420,easing:"cubic-bezier(.34,1.4,.64,1)"});
  flashAt=setTimeout(function(){if(!anim){flash.style.display="none";return;}var a=flash.animate([{opacity:1},{opacity:0}],{duration:220,easing:"cubic-bezier(.22,1,.36,1)"});a.onfinish=function(){flash.style.display="none";};},1100);}
function place(box,el){if(!el||el===document.body||el===document.documentElement){box.style.display="none";return;}var r=el.getBoundingClientRect();box.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";}
function mark(el){place(ring,el);}
addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.channel!==channel)return;if(e.data.type==="commenting"){commenting=!!e.data.on;if(!commenting)mark(null);}
  if(e.data.type==="motion")motion(!!e.data.on);
  if(e.data.type==="locate"){asked=Array.isArray(e.data.items)?e.data.items:null;told="";locate();}
  if(e.data.type==="highlight"){pinned=find(e.data.selector);place(pin,pinned);}
  if(e.data.type==="flash")flashOn(find(e.data.selector));
  if(e.data.type==="snapshot"){var n=document.documentElement.cloneNode(true);n.querySelectorAll("[data-df-chrome]").forEach(function(x){x.remove();});n.querySelectorAll("body").forEach(function(b){b.style.height=innerHeight+"px";});n.querySelectorAll("script").forEach(function(x){x.remove();});var m=n.querySelector('meta[http-equiv]');if(m)m.remove();send({type:"snapshot",id:e.data.id,html:new XMLSerializer().serializeToString(n),width:innerWidth,height:innerHeight});}});
document.addEventListener("mousemove",function(e){if(!commenting)return;var el=e.target;if(el!==hovered){hovered=el;mark(el);}},true);
document.addEventListener("click",function(e){
  var el=e.target;
  if(commenting){e.preventDefault();e.stopPropagation();}
  if(!el||el===document.documentElement){send({type:"click",commenting:commenting,x:e.clientX,y:e.clientY});return;}
  var info=null;
  if(el!==document.body){var r=el.getBoundingClientRect();var at=function(v,a,b){return b>0?Math.round(Math.min(1,Math.max(0,(v-a)/b))*1000)/1000:0.5;};
    info={selector:selectorFor(el,document.body),tag:el.localName,text:(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||"").trim().replace(/\\s+/g," ").slice(0,80),
      box:{x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),width:Math.round(r.width),height:Math.round(r.height)},
      offset:{x:at(e.clientX,r.left,r.width),y:at(e.clientY,r.top,r.height)},near:nearText(el,120)};
    var ln=el.closest&&el.closest("[data-df-line]");if(ln){var no=+ln.getAttribute("data-df-line");if(no>0)info.line=no;}}
  send({type:"click",commenting:commenting,x:e.clientX,y:e.clientY,element:info});
},true);
document.addEventListener("submit",function(e){e.preventDefault();},true);
addEventListener("wheel",function(e){
  if(!e.ctrlKey&&!e.metaKey){var now=Date.now();
    if(wheelTo===null||now-wheelAt>200)wheelTo=scrollsInside(e.target,e.deltaX,e.deltaY,document,function(x){return getComputedStyle(x);})?"frame":"canvas";
    wheelAt=now;if(wheelTo==="frame")return;}
  e.preventDefault();send({type:"wheel",x:e.clientX,y:e.clientY,dx:e.deltaX,dy:e.deltaY,mode:e.deltaMode,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey,alt:e.altKey});},{passive:false});
addEventListener("scroll",function(){if(commenting&&hovered)mark(hovered);if(pinned)place(pin,pinned);flash.style.display="none";relocate();},true);
send({type:"ready"});
})();</script>`;
}


/** The full document for one screen's sandboxed frame. */
export function screenDocument(flow: Flow, screen: Screen, opts: { channel: string }): string {
  const vp = viewportOf(flow, screen);
  const body =
    screen.html && screen.html.trim()
      ? screen.htmlLine
        ? // A prototype section: each tag says its line, counted from the section's own first line, so the frame
          // stays the same (and does not reload) when lines above the section move. The canvas adds the section's line.
          annotateLines(screen.html, 1)
        : screen.html
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
  element: FrameElement | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The clicked element as the frame described it, keeping only well-formed fields: the page inside the frame can post messages too. */
export function cleanElement(el: unknown): FrameElement | null {
  if (!el || typeof el !== "object") return null;
  const x = el as Record<string, unknown>;
  if (typeof x.selector !== "string" || typeof x.tag !== "string" || typeof x.text !== "string") return null;
  const out: FrameElement = { selector: x.selector, tag: x.tag, text: x.text };
  const b = x.box as Record<string, unknown> | undefined;
  if (b && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height) && b.width >= 0 && b.height >= 0)
    out.box = { x: b.x, y: b.y, width: b.width, height: b.height };
  const o = x.offset as Record<string, unknown> | undefined;
  if (o && finite(o.x) && finite(o.y) && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1) out.offset = { x: o.x, y: o.y };
  if (typeof x.near === "string" && x.near.trim()) out.near = x.near.slice(0, 120);
  if (typeof x.line === "number" && Number.isInteger(x.line) && x.line > 0) out.line = x.line;
  return out;
}

/** Where a commented element is now, in the frame's CSS px relative to what it shows; or that it is gone. */
export type Located = { id: string; x: number; y: number; width: number; height: number } | { id: string; missing: true };

/** A frame's answer to "locate", checked against that frame's own window. */
export function acceptFrameLocated(
  e: { data: unknown; source: MessageEventSource | null },
  frames: Map<string, { screen: string; window: () => MessageEventSource | null | undefined }>,
): { screen: string; items: Located[] } | undefined {
  const d = e.data as { channel?: unknown; type?: unknown; items?: unknown };
  if (!d || typeof d.channel !== "string" || d.type !== "located" || !Array.isArray(d.items)) return undefined;
  const f = frames.get(d.channel);
  if (!f || !e.source || e.source !== f.window()) return undefined;
  const items: Located[] = [];
  for (const it of d.items as Record<string, unknown>[]) {
    if (!it || typeof it.id !== "string") continue;
    if (it.missing === true) items.push({ id: it.id, missing: true });
    else if (finite(it.x) && finite(it.y) && finite(it.width) && finite(it.height)) items.push({ id: it.id, x: it.x, y: it.y, width: it.width, height: it.height });
  }
  return { screen: f.screen, items };
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
  return { screen: f.screen, x: d.x, y: d.y, element: cleanElement(d.element) };
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
