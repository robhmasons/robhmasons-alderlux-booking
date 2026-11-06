(() => {
  const $ = (id) => document.getElementById(id);
  const t = new URLSearchParams(location.search).get("t") || "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
  const longFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });

  async function load() {
    const res = await fetch(`/api/bookings/${encodeURIComponent(t)}`);
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { $("title").textContent = "Booking not found"; return; }
    $("title").textContent = b.status === "cancelled" ? "This call is cancelled" : b.name;
    $("when").hidden = false;
    $("when").textContent = longFmt.format(new Date(b.start));
    $("where").textContent = b.location;
    const upcoming = b.status === "confirmed" && Date.parse(b.start) > Date.now();
    $("actions").hidden = !upcoming;
    $("cancel-wrap").hidden = !upcoming;
    $("ics").href = `/api/bookings/${encodeURIComponent(t)}.ics`;
  }

  $("cancel").addEventListener("click", async () => {
    if (!confirm("Cancel this call?")) return;
    $("cancel").disabled = true;
    const res = await fetch(`/api/bookings/${encodeURIComponent(t)}/cancel`, { method: "POST" });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { $("error").textContent = b.error || "Could not cancel. Please try again."; $("cancel").disabled = false; return; }
    load();
  });

  load().catch(() => { $("title").textContent = "Something went wrong"; });
})();
