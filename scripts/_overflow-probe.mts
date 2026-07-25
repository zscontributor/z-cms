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
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
type AnyTheme = Theme<Record<string, unknown>>;
const dir = path.join(REPO, "themes", "z-soft");
const mod = (await import(pathToFileURL(path.join(dir, "dist/index.mjs")).href)) as { default: AnyTheme };
const theme: AnyTheme = mod.default ?? (mod as any);
const css = fs.readFileSync(path.join(dir, "dist/theme.css"), "utf8");
const manifest = theme.manifest as any;
function flatten(input: any, prefix = ""): Record<string,string>{const o:any={};for(const[k,v]of Object.entries(input)){const f=prefix?`${prefix}.${k}`:k;if(v&&typeof v==="object"&&!Array.isArray(v))Object.assign(o,flatten(v,f));else if(typeof v==="string")o[f]=v;}return o;}
function toContent(d:any,p:string,i=0){return{id:`x`,siteId:"s",contentType:{id:d.contentType,key:d.contentType,name:d.contentType},locale:d.locale,translationGroupId:"g",title:d.title,slug:d.slug,path:p,excerpt:d.excerpt??null,data:d.data??{},blocks:d.blocks??[],seo:{},status:"PUBLISHED",publishedAt:"2026-05-14T09:00:00Z",author:{id:"a",name:"Z"},createdAt:"2026-05-14T09:00:00Z",updatedAt:"2026-05-14T09:00:00Z"};}
function prefixFor(ct:string){const p=manifest.demo?.contentTypes?.find((c:any)=>c.key===ct)?.routePrefix;return p?`${p}/`:"";}
function resolveCollections(locale:string){const out:any={};for(const[n,q]of Object.entries(manifest.collections??{})){const qq=q as any;out[n]=(manifest.demo?.contents??[]).filter((c:any)=>c.contentType===qq.contentType&&c.locale===locale).slice(0,qq.limit??12).map((c:any,i:number)=>toContent(c,c.slug?`/${prefixFor(c.contentType)}${c.slug}`:"/",i));}return out;}
function buildContext(locale:string){const settings={...resolveThemeSettings(manifest.settingsSchema,null),...(manifest.demo?.settings??{})};const menus:any={};for(const menu of manifest.demo?.menus??[])menus[menu.key]={key:menu.key,name:menu.name,items:menu.items.map((it:any,i:number)=>({id:`${menu.key}-${i}`,label:it.label,url:it.url,target:it.target??"",children:[]}))};const catalog=(theme as any).messages??{};const flat=flatten(catalog[locale]??catalog.en??{});const base=flatten(catalog.en??{});const ctx:any={site:{id:"s",name:"Z-SOFT",canonicalHost:"e.com",locale,defaultLocale:"en",locales:["en","ja","vi"],brand:{primaryColor:"#d4a75f",logo:""}},settings,menus,locale,t:(k:string,v?:any)=>(flat[k]??base[k]??k).replace(/\{(\w+)\}/g,(_m:any,n:string)=>v&&n in v?String(v[n]):`{${n}}`),renderBlocks:(bs:any[]):ReactNode=>(bs??[]).map((r:any,i:number)=>{const C=theme.blocks?.[r.type];return C?createElement(C as never,{key:r.id??i,block:r,props:r.props??{},ctx}as never):null;}),hasCapability:()=>false,getIntegration:()=>undefined,renderSlot:()=>null,collections:resolveCollections(locale),colorMode:resolveColorModes(manifest,settings),url:(p:string)=>locale==="en"?p||"/":`/${locale}${p==="/"?"":p}`,asset:(p:string)=>/^([a-z]+:)?\/\//i.test(p)||p.startsWith("/")?p:pathToFileURL(path.join(dir,p)).href,alternates:["en","ja","vi"].map(c=>({locale:c,path:c==="en"?"/":`/${c}`,current:c===locale,flagUrl:null}))};return ctx as ThemeContext<any>;}
const en=(manifest.demo?.contents??[]).filter((c:any)=>c.locale==="en");
const home=en.find((c:any)=>c.slug==="");
const ctx=buildContext("en");
const Template=theme.templates.home??theme.templates.page;
const markup=renderToStaticMarkup(createElement(theme.Layout as never,{ctx}as never,createElement(Template as never,{ctx,content:toContent(home,"/")}as never)));
const probe=`<script>window.addEventListener('load',function(){var vw=document.documentElement.clientWidth;var bad=[];document.querySelectorAll('*').forEach(function(el){var r=el.getBoundingClientRect();if(r.right>vw+1||r.left<-1){var sel=el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).join('.'):'');bad.push({sel:sel,left:Math.round(r.left),right:Math.round(r.right),w:Math.round(r.width)});}});bad.sort(function(a,b){return b.right-a.right;});var pre=document.createElement('pre');pre.style.cssText='position:fixed;top:0;left:0;z-index:99999;background:#fff;color:#c00;font:11px monospace;padding:8px;margin:0;max-width:100%;white-space:pre-wrap';pre.textContent='vw='+vw+' scrollW='+document.documentElement.scrollWidth+'\\n'+bad.slice(0,25).map(function(b){return b.right+' <- '+b.left+' w'+b.w+' '+b.sel;}).join('\\n');document.body.appendChild(pre);});</script>`;
const html=`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*,::before,::after{box-sizing:border-box}body{margin:0}${css}</style></head><body>${markup}${probe}</body></html>`;
const tmpHtml=path.join(os.tmpdir(),"zs-probe.html");fs.writeFileSync(tmpHtml,html);
const out=process.env.OUT!;const udd=fs.mkdtempSync(path.join(os.tmpdir(),"zs-"));
const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files","--virtual-time-budget=4000",`--user-data-dir=${udd}`,"--window-size=360,1200",`--screenshot=${out}`,pathToFileURL(tmpHtml).href],{stdio:"ignore"});
let prev=-1;for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,400));const s=fs.existsSync(out)?fs.statSync(out).size:-1;if(s>0&&s===prev)break;prev=s;}chrome.kill("SIGKILL");fs.rmSync(udd,{recursive:true,force:true});console.log("probe done");
