(() => {
  // Shown inside a page on the business's own site: drop our own header band.
  const embedded = window.top !== window.self;
  if (embedded) document.documentElement.classList.add("embedded");
  // Tell the host page our height so its frame fits the content (no scrolling box on phones).
  const tellHeight = () => { if (embedded) parent.postMessage({ alxBooking: "height", h: Math.ceil(document.documentElement.scrollHeight) }, "*"); };
  if (embedded && "ResizeObserver" in window) new ResizeObserver(tellHeight).observe(document.body);
  window.addEventListener("load", tellHeight);
  const $ = (id) => document.getElementById(id);
  const state = { config: null, type: null, from: null, slots: {}, date: null, start: null };
  const visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";

  const steps = ["type", "time", "form", "done"];
  function show(step) {
    for (const s of steps) $("step-" + s).hidden = s !== step;
    if (embedded) parent.postMessage({ alxBooking: "top" }, "*");
    else window.scrollTo({ top: 0 });
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  const fmt = (opts, tz = visitorTz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
  const timeFmt = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const longFmt = fmt({ weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });

  function addDays(d, n) {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Something went wrong. Please try again.");
    return body;
  }

  async function init() {
    state.config = await api("/api/config");
    const list = $("types");
    for (const t of state.config.eventTypes.filter((x) => !x.clientOnly)) {
      list.append(
        el("button", { class: "card", type: "button", role: "listitem", onclick: () => chooseType(t) },
          el("span", { class: "name" }, t.name),
          el("span", { class: "meta" }, `${t.durationMin} minutes`),
          el("span", {}, t.description)),
      );
    }
    const pre = new URLSearchParams(location.search).get("type");
    const match = state.config.eventTypes.find((t) => t.slug === pre);
    if (match) chooseType(match);
  }

  async function chooseType(t) {
    state.type = t;
    state.from = null;
    $("time-eyebrow").textContent = t.name;
    $("form-eyebrow").textContent = t.name;
    const tzLabel = visitorTz === state.config.timezone ? "UK time" : `your time zone (${visitorTz})`;
    $("tz-note").textContent = `${t.durationMin} minutes. Times are shown in ${tzLabel}.`;
    show("time");
    await loadWeek();
  }

  async function loadWeek() {
    $("days").replaceChildren();
    $("times").replaceChildren(el("p", { class: "empty" }, "Loading times…"));
    const q = new URLSearchParams({ type: state.type.slug, days: "14" });
    if (state.from) q.set("from", state.from);
    try {
      const data = await api("/api/slots?" + q);
      state.from = data.from;
      state.last = data.lastBookableDate;
      state.slots = data.slots;
      renderDays(data);
    } catch (e) {
      $("times").replaceChildren(el("p", { class: "empty" }, e.message));
    }
  }

  function renderDays(data) {
    const days = $("days");
    days.replaceChildren();
    let first = null;
    for (let i = 0; i < data.days; i++) {
      const d = addDays(data.from, i);
      const has = (state.slots[d] || []).length > 0;
      const dt = new Date(d + "T12:00:00Z");
      const b = el("button", { class: "day", type: "button", role: "tab", "aria-selected": "false", onclick: () => chooseDate(d) },
        fmt({ weekday: "short" }, "UTC").format(dt), el("b", {}, String(dt.getUTCDate())), fmt({ month: "short" }, "UTC").format(dt));
      if (!has) b.disabled = true;
      b.dataset.date = d;
      days.append(b);
      if (has && !first) first = d;
    }
    $("prev-week").disabled = !state.from || state.from <= new Date().toISOString().slice(0, 10);
    $("next-week").disabled = addDays(data.from, data.days) > state.last;
    if (first) chooseDate(first);
    else $("times").replaceChildren(el("p", { class: "empty" }, "No times in these two weeks. Try later dates."));
  }

  function chooseDate(d) {
    state.date = d;
    for (const b of $("days").children) b.setAttribute("aria-selected", String(b.dataset.date === d));
    const times = $("times");
    times.replaceChildren();
    for (const iso of state.slots[d] || []) {
      times.append(el("button", { class: "time", type: "button", role: "listitem", onclick: () => chooseTime(iso) }, timeFmt.format(new Date(iso))));
    }
  }

  function chooseTime(iso) {
    state.start = iso;
    $("chosen").textContent = longFmt.format(new Date(iso));
    const qs = $("questions");
    qs.replaceChildren();
    for (const q of state.type.questions) {
      let input;
      if (q.type === "select") {
        input = el("select", { name: "q_" + q.id }, el("option", { value: "" }, "Choose…"));
        for (const o of q.options) input.append(el("option", { value: o }, o));
      } else if (q.type === "textarea") input = el("textarea", { name: "q_" + q.id, maxlength: "2000" });
      else input = el("input", { name: "q_" + q.id, maxlength: "2000" });
      if (q.required) input.required = true;
      qs.append(el("label", {}, q.label + (q.required ? "" : " (optional)"), input));
    }
    // Remember name and email on this device so returning clients do not retype them.
    try {
      const saved = JSON.parse(localStorage.getItem("alx_details") || "null");
      const f = $("form");
      if (saved && !f.elements.name.value) f.elements.name.value = saved.name || "";
      if (saved && !f.elements.email.value) f.elements.email.value = saved.email || "";
    } catch (e) { /* storage unavailable: nothing to prefill */ }
    const lbl = state.type.clientOnly ? null : state.config.mailingListLabel;
    $("subscribe-row").hidden = !lbl;
    if (lbl) $("subscribe-label").textContent = lbl;
    $("form-error").textContent = "";
    show("form");
  }

  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const answers = {};
    for (const q of state.type.questions) answers[q.id] = (f.get("q_" + q.id) || "").toString();
    const btn = $("submit");
    btn.disabled = true;
    $("form-error").textContent = "";
    try {
      const res = await api("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: state.type.slug, start: state.start, name: f.get("name"), email: f.get("email"), website: f.get("website"), answers, subscribe: f.get("subscribe") === "yes" }),
      });
      try { localStorage.setItem("alx_details", JSON.stringify({ name: f.get("name"), email: f.get("email") })); } catch (e) { /* not stored */ }
      $("done-when").textContent = `${state.type.name}, ${longFmt.format(new Date(res.start))}`;
      $("ics-link").href = `/api/bookings/${encodeURIComponent(res.manageToken)}.ics`;
      show("done");
    } catch (e) {
      $("form-error").textContent = e.message;
      if (/no longer available|just been taken/.test(e.message)) setTimeout(() => { show("time"); loadWeek(); }, 1800);
    } finally {
      btn.disabled = false;
    }
  });

  $("prev-week").addEventListener("click", () => { state.from = addDays(state.from, -14); loadWeek(); });
  $("next-week").addEventListener("click", () => { state.from = addDays(state.from, 14); loadWeek(); });
  for (const b of document.querySelectorAll("[data-back]")) b.addEventListener("click", () => show(b.dataset.back));

  init().catch((e) => { $("types").replaceChildren(el("p", { class: "empty" }, e.message)); });
})();
