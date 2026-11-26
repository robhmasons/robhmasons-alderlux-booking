import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";
import { TENANTS } from "../src/config";
import { validateBooking } from "../src/validate";

const env = { DB: {} } as unknown as Env;
const config = async (qs = "") => (await (await worker.fetch(new Request("https://book.example/api/config" + qs), env)).json()) as { eventTypes: { slug: string; privateOnly: boolean }[] };

describe("private-client (Robert, 26/11/2026)", () => {
  it("is never listed in the public config", async () => {
    const c = await config();
    expect(c.eventTypes.map((e) => e.slug)).not.toContain("private-client");
    expect(c.eventTypes.length).toBeGreaterThan(0);
  });
  it("is returned when asked for by its own slug", async () => {
    const c = await config("?type=private-client");
    const pc = c.eventTypes.find((e) => e.slug === "private-client");
    expect(pc?.privateOnly).toBe(true);
  });
  it("asking for a public slug does not reveal it", async () => {
    const c = await config("?type=the-edge");
    expect(c.eventTypes.map((e) => e.slug)).not.toContain("private-client");
  });
  it("accepts a valid booking and never asks for balances or addresses", () => {
    const et = TENANTS.alderlux.eventTypes.find((e) => e.slug === "private-client")!;
    expect(et.questions.map((q) => q.label).join(" ")).not.toMatch(/balance|address|amount|how much/i);
    const v = validateBooking({ type: "private-client", start: "2026-12-01T10:00:00Z", name: "A Client", email: "a@example.com", answers: { format: "Video call (Zoom)", heard_about: "Personal introduction" } }, et);
    expect(v.ok).toBe(true);
  });
});
