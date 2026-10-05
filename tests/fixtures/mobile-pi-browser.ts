/** Run against mcp-tui-broker + an actual Pi CLI using mcp-tui-extension. */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const url = process.argv[2];
if (!url) throw new Error("提供手机邀请网址");
const browser = await chromium.launch({ executablePath: process.env.PI_COMMS_TEST_CHROMIUM, headless: true, args: ["--no-sandbox"] });
try {
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const carolContext = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const bob = await bobContext.newPage(), carol = await carolContext.newPage();
  for (const [page,name] of [[bob,"PhoneBob"], [carol,"PhoneCarol"]] as const) {
    await page.goto(url); await page.locator("#username").fill(name); await page.locator("#join-button").click();
    await page.locator("#chat-view").waitFor({ state: "visible" });
  }
  await bob.locator("#message").fill("来自真实 Pi 验收浏览器的普通消息"); await bob.locator("#send-button").click();
  await carol.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("来自真实 Pi 验收浏览器的普通消息"));
  await carol.locator("#message").fill("@Alice-Pi 请用群聊 MCP 验证上下文和消息历史。只读取，不修改文件。");
  await carol.locator("#send-button").click();
  for (const page of [bob,carol]) await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("MCP_E2E_PASS"), undefined, { timeout: 30_000 });
  await bob.locator("#members").click();
  await mkdir("docs/screenshots", { recursive: true });
  await bob.screenshot({ path: "docs/screenshots/27-web-real-pi.png", fullPage: true });
  console.log(JSON.stringify({ result: "MOBILE_REAL_PI_E2E_PASS", members: await bob.locator("#member-list").textContent(), messages: await bob.locator("#messages").textContent() }));
} finally { await browser.close(); }
