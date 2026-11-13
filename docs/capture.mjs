/**
 * Takes the README's screenshots and GIFs from a running Video Clipper.
 *
 *   LIBRARY=http://127.0.0.1:8010 EMPTY=http://127.0.0.1:8011 \
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node docs/capture.mjs <out dir>
 *
 * LIBRARY: a server with videos and rendered shorts in it. EMPTY: one started
 * with SHORTS_DATA pointing at an empty folder, for the first-visit page.
 * Playwright is not a dependency of the app: `npm i --no-save playwright`
 * somewhere and name its index.mjs in PLAYWRIGHT; CHROMIUM names another
 * Chromium build. FIRST and SECOND name the videos (ids) for the editor
 * shots. The screens it opens change nothing in the library.
 * Videos land in <out dir>/video; cut them into GIFs with ffmpeg (see the end).
 */
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const LIB = process.env.LIBRARY, EMPTY = process.env.EMPTY, OUT = process.argv[2];
if (!LIB || !OUT) throw new Error("Set LIBRARY and give an output folder.");
mkdirSync(`${OUT}/video`, { recursive: true });
const VIEW = { width: 1440, height: 900 };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });

async function open(base, store = {}, video = false) {
  const ctx = await browser.newContext({ viewport: VIEW, ...(video ? { recordVideo: { dir: `${OUT}/video`, size: VIEW } } : {}) });
  await ctx.addInitScript((s) => {
    for (const [k, v] of Object.entries(s)) if (k !== "__pointer") localStorage.setItem(k, v);
    if (!s.__pointer) return;
    addEventListener("DOMContentLoaded", () => {  // a pointer, since a headless recording has none
      const dot = document.createElement("div");
      dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.35);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.6);pointer-events:none;left:-50px;top:-50px;transition:transform .12s";
      document.body.appendChild(dot);
      addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
      addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
      addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
    });
  }, { ...store, ...(video ? { __pointer: "1" } : {}) });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) console.error("console:", m.text().slice(0, 160)); });
  return { ctx, page, go: (hash) => page.goto(`${base}/${hash}`) };
}
async function click(page, sel, pause = 500) {
  const el = page.locator(sel).first();
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await page.waitForTimeout(250);
  await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
  await page.waitForTimeout(pause);
}
const editorReady = async (page) => {
  await page.waitForSelector(".preview-col .phone-frame");
  await page.waitForFunction(() => document.querySelector(".player video")?.readyState >= 2, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
};
const still = async (page) => {  // the still, once its picture has come
  await page.locator(".preview [role=tab]").nth(1).click();
  await page.waitForSelector(".preview-col .phone-frame img:not(.loading)", { timeout: 30000 });
  await page.waitForTimeout(600);
};

const lectures = await (await fetch(`${LIB}/api/lectures`)).json();
const withShort = [];
for (const l of lectures) {
  const shorts = (await (await fetch(`${LIB}/api/lectures/${l.id}/shorts`)).json()).filter((s) => s.rendered && s.ranges.length);
  if (shorts.length && l.has_transcript) withShort.push({ l, s: shorts[0] });
}
if (withShort.length < 1) throw new Error("The library needs a transcribed video with a rendered short.");
// FIRST / SECOND: video ids to use instead of the first two with a rendered short
const pick = (id) => withShort.find((x) => x.l.id === id);
const first = pick(process.env.FIRST) ?? withShort[0], second = pick(process.env.SECOND) ?? withShort[1] ?? first;
const hash = ({ l, s }) => `#/l/${l.id}/edit/${s.id}`;

{ // the library
  const { ctx, page, go } = await open(LIB);
  await go("#/"); await page.waitForSelector(".lib-row"); await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/library.png` });
  await ctx.close();
}
{ // the editor: everything open, the caption text beside the preview
  const { ctx, page, go } = await open(LIB, { "settings-section": "text" });
  await go(hash(first)); await editorReady(page); await still(page);
  await page.screenshot({ path: `${OUT}/editor.png` });
  await ctx.close();
}
{ // another talk, the look settings, the TikTok safe area on the preview
  const { ctx, page, go } = await open(LIB, { "settings-section": "look", "safe-zone-guide": "tiktok" });
  await go(hash(second)); await editorReady(page); await still(page);
  await page.screenshot({ path: `${OUT}/editor-ar.png` });
  await ctx.close();
}
{ // the transcript and the settings folded away
  const { ctx, page, go } = await open(LIB, { "folded-sections": JSON.stringify({ transcript: true, side: true }) });
  await go(hash(first)); await editorReady(page); await still(page);
  await page.screenshot({ path: `${OUT}/editor-folded.png` });
  await ctx.close();
}
{ // the editor, moving: play the cut, fold the transcript and the settings, bring them back
  const { ctx, page, go } = await open(LIB, { "settings-section": "text" }, true);
  await go(hash(first)); await editorReady(page);
  const t0 = Date.now();
  await click(page, ".preview [role=tab] >> nth=0", 900);
  await click(page, ".q-bar [aria-label='Forward 5 seconds']", 700);
  await click(page, ".quick-frame", 4500);
  await click(page, ".quick-frame", 600);
  await click(page, "[aria-label='Hide transcript']", 1300);
  await click(page, "[aria-label='Hide settings']", 1600);
  await click(page, "[aria-label='Show settings']", 900);
  await click(page, "[aria-label='Show transcript']", 1200);
  await click(page, ".cap-row >> nth=2", 1800);
  const video = await page.video().path();
  console.log(`editor ${video} ${((Date.now() - t0) / 1000).toFixed(1)}`);
  await ctx.close();
}
if (EMPTY) { // the first visit: the welcome, then down the page
  const { ctx, page, go } = await open(EMPTY, {}, true);
  await go("#/"); await page.waitForSelector(".hero h1"); await page.waitForTimeout(1500);
  await page.locator(".editor-shot img").scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);  // its picture loads late
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/landing.png`, fullPage: true });
  const t0 = Date.now();
  await page.mouse.move(720, 450);
  const height = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  for (let y = 0; y < height; y += 24) { await page.mouse.wheel(0, 24); await page.waitForTimeout(40); }
  await page.waitForTimeout(900);
  console.log(`landing ${await page.video().path()} ${((Date.now() - t0) / 1000).toFixed(1)}`);
  await ctx.close();
}
await browser.close();
// A GIF from a recording (the line printed above gives the file and the length):
//   ffmpeg -ss <start> -t <length> -i <video> -vf "fps=10,scale=900:-2:flags=lanczos,palettegen=stats_mode=diff" p.png
//   ffmpeg -ss <start> -t <length> -i <video> -i p.png -lavfi "fps=10,scale=900:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" out.gif
