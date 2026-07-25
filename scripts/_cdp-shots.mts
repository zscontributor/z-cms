import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveColorModes, resolveThemeSettings } from "@zcmsorg/theme-sdk";
import type { Theme, ThemeContext, ThemeManifest } from "@zcmsorg/theme-sdk";
const REPO = "/Users/z-soft/Data/z-soft/z-cms";
const OUT = process.env.OUT_DIR!;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
type AnyTheme = Theme<Record<string, unknown>>;
const dir = path.join(REPO, "themes", "z-soft");
const mod = (await import(pathToFileURL(path.join(dir, "dist/index.mjs")).href)) as { default: AnyTheme };
const theme: AnyTheme = mod.default ?? (mod as any);
const css = fs.readFileSync(path.join(dir, "dist/theme.css"), "utf8");
const manifest = theme.manifest as any;
function flatten(input:any,prefix=""):Record<string,string>{const o:any={};for(const[k,v]of Object.entries(input)){const f=prefix?`${prefix}.${k}`:k;if(v&&typeof v==="object"&&!Array.isArray(v))Object.assign(o,flatten(v,f));else if(typeof v==="string")o[f]=v;}return o;}
function toContent(d:any,p:string,i=0){return{id:"x",siteId:"s",contentType:{id:d.contentType,key:d.contentType,name:d.contentType},locale:d.locale,translationGroupId:"g",title:d.title,slug:d.slug,path:p,excerpt:d.excerpt??null,data:d.data??{},blocks:d.blocks??[],seo:{},status:"PUBLISHED",publishedAt:"2026-05-14T09:00:00Z",author:{id:"a",name:"Z"},createdAt:"2026-05-14T09:00:00Z",updatedAt:"2026-05-14T09:00:00Z"};}
function prefixFor(ct:string){const p=manifest.demo?.contentTypes?.find((c:any)=>c.key===ct)?.routePrefix;return p?`${p}/`:"";}
function resolveCollections(locale:string){const out:any={};for(const[n,q]of Object.entries(manifest.collections??{})){const qq=q as any;out[n]=(manifest.demo?.contents??[]).filter((c:any)=>c.contentType===qq.contentType&&c.locale===locale).slice(0,qq.limit??12).map((c:any,i:number)=>toContent(c,c.slug?`/${prefixFor(c.contentType)}${c.slug}`:"/",i));}return out;}
function buildContext(locale:string){const settings={...resolveThemeSettings(manifest.settingsSchema,null),...(manifest.demo?.settings??{})};const menus:any={};for(const menu of manifest.demo?.menus??[])menus[menu.key]={key:menu.key,name:menu.name,items:menu.items.map((it:any,i:number)=>({id:`${menu.key}-${i}`,label:it.label,url:it.url,target:it.target??"",children:[]}))};const catalog=(theme as any).messages??{};const flat=flatten(catalog[locale]??catalog.en??{});const base=flatten(catalog.en??{});const ctx:any={site:{id:"s",name:"Z-SOFT",canonicalHost:"e.com",locale,defaultLocale:"en",locales:["en","ja","vi"],brand:{primaryColor:"#d4a75f",logo:""}},settings,menus,locale,t:(k:string,v?:any)=>(flat[k]??base[k]??k).replace(/\{(\w+)\}/g,(_m:any,n:string)=>v&&n in v?String(v[n]):`{${n}}`),renderBlocks:(bs:any[]):ReactNode=>(bs??[]).map((r:any,i:number)=>{const C=theme.blocks?.[r.type];return C?createElement(C as never,{key:r.id??i,block:r,props:r.props??{},ctx}as never):null;}),hasCapability:()=>false,getIntegration:()=>undefined,renderSlot:()=>null,collections:resolveCollections(locale),colorMode:resolveColorModes(manifest,settings),url:(p:string)=>locale==="en"?p||"/":`/${locale}${p==="/"?"":p}`,asset:(p:string)=>/^([a-z]+:)?\/\//i.test(p)||p.startsWith("/")?p:pathToFileURL(path.join(dir,p)).href,alternates:["en","ja","vi"].map(c=>({locale:c,path:c==="en"?"/":`/${c}`,current:c===locale,flagUrl:null}))};return ctx as ThemeContext<any>;}
function docHtml(markup:string,withProbe:boolean){const probe=withProbe?`<script>window.addEventListener('load',function(){var vw=document.documentElement.clientWidth;var bad=[];document.querySelectorAll('*').forEach(function(el){var r=el.getBoundingClientRect();if(r.right>vw+1){var sel=el.tagName.toLowerCase()+(typeof el.className==='string'&&el.className?'.'+el.className.trim().split(/\\s+/).join('.'):'');bad.push(Math.round(r.right)+' w'+Math.round(r.width)+' '+sel);}});var pre=document.createElement('pre');pre.style.cssText='position:fixed;top:0;left:0;z-index:99999;background:#ffffe0;color:#c00;font:11px monospace;padding:6px;margin:0;max-width:100%;white-space:pre-wrap;border:2px solid red';pre.textContent='vw='+vw+' scrollW='+document.documentElement.scrollWidth+' bad='+bad.length+'\\n'+bad.slice(0,20).join('\\n');document.body.appendChild(pre);});</script>`:"";return `<!doctype html><html lang="en" data-theme="light" style="color-scheme:light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*,::before,::after{box-sizing:border-box}body{margin:0}${css}</style></head><body>${markup}${probe}</body></html>`;}

// ---- CDP driver via built-in WebSocket ----
const PORT = 9741;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), "zs-cdp-"));
const chrome = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--no-default-browser-check","--hide-scrollbars","--force-color-profile=srgb","--allow-file-access-from-files",`--remote-debugging-port=${PORT}`,`--user-data-dir=${udd}`,"about:blank"], { stdio: "ignore" });
function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}
let wsUrl="";
for(let i=0;i<60;i++){await sleep(300);try{const r=await fetch(`http://127.0.0.1:${PORT}/json`);const list:any=await r.json();const pg=list.find((t:any)=>t.type==="page");if(pg?.webSocketDebuggerUrl){wsUrl=pg.webSocketDebuggerUrl;break;}}catch{}}
if(!wsUrl){chrome.kill("SIGKILL");throw new Error("no CDP page target");}
const ws=new WebSocket(wsUrl);
await new Promise((res,rej)=>{ws.onopen=()=>res(null);ws.onerror=(e)=>rej(e);});
let msgId=0;const pending=new Map<number,(v:any)=>void>();const events:any[]=[];const waiters:{method:string,res:(v:any)=>void}[]=[];
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data as string);if(m.id&&pending.has(m.id)){pending.get(m.id)!(m.result);pending.delete(m.id);}else if(m.method){for(let i=waiters.length-1;i>=0;i--){if(waiters[i].method===m.method){waiters[i].res(m.params);waiters.splice(i,1);}}}};
function cmd(method:string,params:any={}):Promise<any>{const id=++msgId;return new Promise((res)=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}
function waitEvent(method:string):Promise<any>{return new Promise((res)=>waiters.push({method,res}));}
await cmd("Page.enable");

const en=(manifest.demo?.contents??[]).filter((c:any)=>c.locale==="en");
const home=en.find((c:any)=>c.slug==="");
const services=en.find((c:any)=>c.slug==="services");
const pages=[{name:"home",content:home,kind:"home"},{name:"services",content:services,kind:"page"}].filter(p=>p.content);
const widths=[{w:360,tag:"360",probe:true},{w:390,tag:"390",probe:false},{w:414,tag:"414",probe:false}];
fs.mkdirSync(OUT,{recursive:true});
for(const page of pages){
  for(const vw of widths){
    const ctx=buildContext("en");
    const Template=page.kind==="home"?(theme.templates.home??theme.templates.page):theme.templates.page;
    const markup=renderToStaticMarkup(createElement(theme.Layout as never,{ctx}as never,createElement(Template as never,{ctx,content:toContent(page.content,page.content.slug?`/${page.content.slug}`:"/")}as never)));
    const tmpHtml=path.join(udd,`p.html`);fs.writeFileSync(tmpHtml,docHtml(markup,vw.probe));
    await cmd("Emulation.setDeviceMetricsOverride",{width:vw.w,height:800,deviceScaleFactor:2,mobile:true});
    const loaded=waitEvent("Page.loadEventFired");
    await cmd("Page.navigate",{url:pathToFileURL(tmpHtml).href});
    await loaded;await sleep(1200);
    const {cssContentSize}=await cmd("Page.getLayoutMetrics");
    const h=Math.min(Math.ceil(cssContentSize.height),16000);
    await cmd("Emulation.setDeviceMetricsOverride",{width:vw.w,height:h,deviceScaleFactor:2,mobile:true});
    await sleep(300);
    const {data}=await cmd("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip:{x:0,y:0,width:vw.w,height:h,scale:1}});
    fs.writeFileSync(path.join(OUT,`${page.name}-${vw.tag}.png`),Buffer.from(data,"base64"));
    console.log(`shot ${page.name}@${vw.tag} h=${h}`);
  }
}
ws.close();chrome.kill("SIGKILL");try{fs.rmSync(udd,{recursive:true,force:true});}catch{}
console.log("done");
