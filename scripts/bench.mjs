// Visitor-side benchmark of a booking page: load speed, weight, requests, third parties, clicks to the details form.
// Usage: node scripts/bench.mjs <label> <url> <outdir> [ours]
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const [label, url, out, mode] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY && !url.includes("127.0.0.1") ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch(proxy ? { proxy } : {});
const result = { label, url };
for (const [name, opts] of [["desktop", { viewport: { width: 1366, height: 860 } }], ["mobile", devices["iPhone 13"]]]) {
  const ctx = await browser.newContext({ ...opts, ignoreHTTPSErrors: false });
  const page = await ctx.newPage();
  let bytes = 0, requests = 0; const hosts = new Set();
  page.on("response", async (r) => { requests++; try { hosts.add(new URL(r.url()).host); const b = await r.body(); bytes += b.length; } catch {} });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  let clicks = 0, tSlots = null, tForm = null, notes = [];
  try {
    if (mode === "ours") {
      await page.getByText("Succession: introductory consultation").first().click(); clicks++;
      await page.locator(".time").first().waitFor({ timeout: 20000 }); tSlots = Date.now() - t0;
      await page.locator(".time").first().click(); clicks++;
      await page.locator("#form").waitFor(); tForm = Date.now() - t0;
      if (name === "desktop") {
        await page.fill("input[name=name]", "Bench Test"); await page.fill("input[name=email]", "bench@example.com");
        await page.selectOption("select[name=q_heard_about]", "Personal introduction");
        await page.click("#submit");
        await page.locator("#step-done:not([hidden])").waitFor({ timeout: 15000 });
        notes.push("full booking completed");
      }
    } else {
      // Calendly: dates are buttons with an aria-label containing "Times available"; stop at the details form.
      const day = page.locator('button[aria-label*="Times available"]').first();
      await day.waitFor({ timeout: 30000 }); tSlots = Date.now() - t0;
      await day.click(); clicks++;
      const time = page.locator('button[data-container="time-button"]').first();
      await time.waitFor({ timeout: 20000 }); await time.click(); clicks++;
      const next = page.getByRole("button", { name: /^Next/ }).first();
      if (await next.isVisible().catch(() => false)) { await next.click(); clicks++; }
      await page.locator('input[name="full_name"], input[name="name"], input[type="email"]').first().waitFor({ timeout: 20000 });
      tForm = Date.now() - t0; notes.push("stopped at details form; nothing booked");
    }
  } catch (e) { notes.push("flow error: " + String(e.message).split("\n")[0]); }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${label}-${name}.png`, fullPage: false });
  result[name] = { msToSlotsVisible: tSlots, msToDetailsForm: tForm, clicksToDetailsForm: clicks + (mode === "ours" ? 0 : 0), requests, kilobytes: Math.round(bytes / 1024), hosts: [...hosts].sort(), notes };
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(result, null, 1));
