/* Lightweight Home Assistant dashboard for a Raspberry Pi Zero 2W kiosk.
 * Talks to Home Assistant directly over its WebSocket API. No dependencies. */
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let cfg;
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    cfg = await res.json();
  } catch (err) {
    showError("Could not load config.json: " + err.message);
    return;
  }
  if (cfg.error) {
    showError(cfg.error);
    return;
  }

  if (cfg.theme === "light" || cfg.theme === "dark") {
    document.documentElement.dataset.theme = cfg.theme;
  }
  $("title").textContent = cfg.title;
  document.title = cfg.title;

  const DOMAIN_ICONS = {
    light: "💡", switch: "🔌", fan: "🌀", cover: "🚪", lock: "🔒",
    scene: "🎬", script: "📜", climate: "🌡️", sensor: "📈",
    binary_sensor: "⚪", input_boolean: "✅", automation: "🤖",
    button: "🔘", media_player: "🎵", camera: "📷", person: "👤", vacuum: "🧹",
  };
  const TOGGLE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean", "automation", "media_player"]);
  // Domains where an accidental tap matters: require a second tap to confirm.
  const CONFIRM_DOMAINS = new Set(["lock"]);
  // Covers get explicit Open / Stop / Close buttons instead of a tile tap.
  const ON_STATES = new Set(["on", "open", "opening", "unlocked", "playing", "home", "heat", "cool", "heat_cool", "auto"]);

  const tiles = new Map(); // entity_id -> { tile, el, parts }
  const badgeOwner = new Map(); // badge binary_sensor -> camera entity_id
  const states = new Map(); // entity_id -> HA state object
  let ws = null;
  let msgId = 0;
  const pending = new Map(); // id -> { resolve, reject }
  let retryDelay = 1000;
  let authFailed = false;
  // While the initial get_states is in flight, state_changed events are also
  // recorded here so they can be replayed over the (older) snapshot.
  let eventsDuringSnapshot = null;

  /* ---------- UI ---------- */

  // The error/toast live regions stay rendered (CSS collapses them when empty)
  // so screen readers announce text as it is inserted.
  function showError(msg) {
    $("error").textContent = msg || "";
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.textContent = ""; }, 2500);
  }

  function setConn(status, label) {
    const el = $("conn");
    el.className = "conn conn-" + status;
    el.title = label;
    const text = $("conn-text");
    if (text.textContent !== label) text.textContent = label;
  }

  function tickClock() {
    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // Re-render just after each minute boundary so the clock never lags.
  (function scheduleClock() {
    tickClock();
    setTimeout(scheduleClock, 60000 - (Date.now() % 60000) + 50);
  })();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildTiles(list) {
    const grid = $("grid");
    grid.textContent = "";
    tiles.clear();
    cameras.length = 0;
    badgeOwner.clear();
    let securityAdded = false;
    for (const tile of list) {
      if (tile.heading) {
        grid.append(el("h2", "area-heading", tile.heading));
        continue;
      }
      // A "Security" tile in front of the first camera opens all cameras full screen.
      if (!securityAdded && tile.entity.startsWith("camera.")) {
        securityAdded = true;
        const sec = el("div", "tile actionable security-tile");
        const main = el("button", "tile-main");
        main.type = "button";
        main.append(el("div", "icon", "🛡️"), el("div", "name", "Security"), el("div", "state", "All cameras"));
        sec.append(main);
        sec.addEventListener("click", openSecurity);
        grid.append(sec);
      }
      const domain = tile.entity.split(".")[0];
      const root = el("div", "tile unavailable");
      const parts = {
        icon: el("div", "icon", tile.icon || DOMAIN_ICONS[domain] || "❔"),
        name: el("div", "name", tile.name || tile.entity),
        state: el("div", "state", "—"),
      };
      // Actionable tiles put their label in a real <button>, kept separate
      // from inner controls such as the brightness slider (no nesting).
      const actionable = isActionable(domain);
      const body = actionable ? el("button", "tile-main") : root;
      if (actionable) {
        body.type = "button";
        parts.main = body;
        root.append(body);
      }
      if (domain === "camera") {
        root.classList.add("camera");
        parts.img = el("img", "cam-img");
        parts.img.alt = "";
        parts.img.decoding = "async";
        parts.badge = el("div", "cam-badge");
        parts.badge.hidden = true;
        body.append(parts.img, parts.badge);
        // Frigate's per-camera sensors drive a Person / Motion badge.
        const slug = tile.entity.split(".")[1];
        const cam = { tile, parts, busy: false, last: 0,
          person: "binary_sensor." + slug + "_person_occupancy", motion: "binary_sensor." + slug + "_motion" };
        badgeOwner.set(cam.person, tile.entity);
        badgeOwner.set(cam.motion, tile.entity);
        cameras.push(cam);
      } else {
        body.append(parts.icon);
      }

      if (domain === "sensor") {
        parts.value = el("div", "value", "—");
        body.append(parts.value);
      }
      body.append(parts.name, parts.state);

      if (domain === "light") {
        parts.slider = el("input");
        parts.slider.type = "range";
        parts.slider.min = "1";
        parts.slider.max = "100";
        parts.slider.hidden = true;
        parts.slider.setAttribute("aria-label", "Brightness");
        stopTap(parts.slider);
        parts.slider.addEventListener("change", () => {
          // callService already shows a toast on failure.
          callService("light", "turn_on", tile.entity, { brightness_pct: Number(parts.slider.value) }).catch(() => {});
        });
        root.append(parts.slider);
      }

      if (domain === "cover") {
        const row = el("div", "cover-controls");
        for (const [label, svc, aria] of [["▲", "open_cover", "Open"], ["■", "stop_cover", "Stop"], ["▼", "close_cover", "Close"]]) {
          const btn = el("button", null, label);
          btn.type = "button";
          btn.setAttribute("aria-label", aria + " " + (tile.name || tile.entity));
          stopTap(btn);
          btn.addEventListener("click", () => {
            const st = states.get(tile.entity);
            if (!st || st.state === "unavailable") { toast("Unavailable"); return; }
            callService("cover", svc, tile.entity).then(() => toast((tile.name || tile.entity) + ": " + aria), () => {});
          });
          row.append(btn);
        }
        root.append(row);
      }

      if (domain === "climate") {
        const row = el("div", "climate-controls");
        const minus = el("button", null, "−");
        const plus = el("button", null, "+");
        parts.target = el("span", "value", "—");
        minus.setAttribute("aria-label", "Lower temperature");
        plus.setAttribute("aria-label", "Raise temperature");
        for (const [btn, dir] of [[minus, -1], [plus, 1]]) {
          stopTap(btn);
          btn.addEventListener("click", () => nudgeTemperature(tile.entity, dir));
        }
        row.append(minus, parts.target, plus);
        root.append(row);
      }

      if (actionable) {
        root.classList.add("actionable");
        // Taps anywhere on the card toggle; the inner button's keyboard
        // activation bubbles here too. Inner controls stop propagation.
        root.addEventListener("click", () => onTap(tile, root));
      }

      tiles.set(tile.entity, { tile, el: root, parts });
      grid.append(root);
    }
    if (secOpen) openSecurity();
  }

  function stopTap(node) {
    node.addEventListener("click", (e) => e.stopPropagation());
    node.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  function isActionable(domain) {
    return TOGGLE_DOMAINS.has(domain) || CONFIRM_DOMAINS.has(domain) || domain === "camera" ||
      domain === "scene" || domain === "script" || domain === "button";
  }

  function formatState(s) {
    if (!s) return "—";
    const unit = s.attributes.unit_of_measurement;
    const domain = s.entity_id.split(".")[0];
    if (s.state === "unavailable" || (s.state === "unknown" && domain !== "scene" && domain !== "button")) {
      return s.state.replace(/^./, (c) => c.toUpperCase());
    }
    if (domain === "sensor") {
      const n = Number(s.state);
      const val = Number.isFinite(n) && s.state.trim() !== "" ? String(Math.round(n * 10) / 10) : s.state;
      return unit ? val + " " + unit : val;
    }
    if (domain === "light" && s.state === "on" && s.attributes.brightness != null) {
      return "On · " + Math.round((s.attributes.brightness / 255) * 100) + "%";
    }
    if (domain === "cover" && s.attributes.current_position != null) {
      return s.state.replace(/^./, (c) => c.toUpperCase()) + " · " + s.attributes.current_position + "%";
    }
    if (domain === "climate") {
      const cur = s.attributes.current_temperature;
      return (cur != null ? "Now " + cur + "° · " : "") + s.state;
    }
    if (domain === "scene" || domain === "script" || domain === "button") {
      return domain === "script" && s.state === "on" ? "Running" : "Tap to run";
    }
    return s.state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  function render(entityId) {
    const t = tiles.get(entityId);
    if (!t) return;
    const s = states.get(entityId);
    const { el: root, parts, tile } = t;
    const domain = entityId.split(".")[0];
    // Scenes/buttons report "unknown" until first used; that is not unavailable.
    const stateless = domain === "scene" || domain === "button";
    const unavailable = !s || s.state === "unavailable" || (s.state === "unknown" && !stateless);

    root.classList.remove("pending");
    root.classList.toggle("unavailable", unavailable);
    const isOn = !!s && (domain === "media_player"
      ? !["off", "standby", "unavailable", "unknown"].includes(s.state)
      : ON_STATES.has(s.state));
    root.classList.toggle("on", isOn);
    if (parts.main && TOGGLE_DOMAINS.has(domain)) {
      parts.main.setAttribute("aria-pressed", String(isOn));
    }

    if (!tile.name && s && s.attributes.friendly_name) parts.name.textContent = s.attributes.friendly_name;

    if (parts.value) {
      parts.value.textContent = formatState(s);
      parts.state.textContent = s && s.attributes.device_class ? s.attributes.device_class.replace(/_/g, " ") : "";
    } else {
      parts.state.textContent = formatState(s);
    }

    if (parts.slider) {
      const on = s && s.state === "on";
      const supportsBrightness = s && (s.attributes.supported_color_modes || []).some((m) => m !== "onoff");
      parts.slider.hidden = !(on && supportsBrightness);
      if (on && s.attributes.brightness != null && document.activeElement !== parts.slider) {
        parts.slider.value = String(Math.max(1, Math.round((s.attributes.brightness / 255) * 100)));
      }
    }

    if (parts.badge) {
      const cam = cameras.find((c) => c.tile === tile);
      const isOn = (id) => { const b = states.get(id); return !!b && b.state === "on"; };
      const kind = cam && isOn(cam.person) ? "person" : cam && isOn(cam.motion) ? "motion" : "";
      for (const b of [parts.badge, cam && cam.secBadge]) {
        if (!b) continue;
        b.hidden = !kind;
        b.className = "cam-badge " + kind;
        b.textContent = kind === "person" ? "Person" : "Motion";
      }
    }

    if (parts.img && s && s.attributes.access_token &&
        parts.img.dataset.token !== s.attributes.access_token) {
      parts.img.dataset.token = s.attributes.access_token;
      refreshCamera(cameras.find((c) => c.tile === tile), true);
    }

    if (parts.target) {
      const target = s && s.attributes.temperature;
      parts.target.textContent = target != null ? target + "°" : "—";
    }
  }

  function renderAll() {
    for (const id of tiles.keys()) render(id);
  }

  /* ---------- Actions ---------- */

  const confirmations = new WeakMap(); // tile element -> { timer, service }

  function cancelConfirm(root) {
    const c = confirmations.get(root);
    if (!c) return;
    clearTimeout(c.timer);
    confirmations.delete(root);
    root.classList.remove("confirm");
    // Don't leave a "Tap again to ..." prompt up for an action that's gone.
    if ($("toast").textContent.startsWith("Tap again")) toast("");
  }
  // Tiles with a service call awaiting HA's reply. Kept apart from the
  // "pending" class, which render() clears on any state update.
  const inFlight = new WeakSet();

  function onTap(tile, root) {
    const entityId = tile.entity;
    const domain = entityId.split(".")[0];
    const s = states.get(entityId);
    const stateless = domain === "scene" || domain === "button";
    if (!s || s.state === "unavailable" || (s.state === "unknown" && !stateless)) {
      toast("Unavailable");
      return;
    }
    if (domain === "camera") {
      openLive(tile, s);
      return;
    }
    // A second tap before HA answers would send a second toggle and could
    // flip the entity straight back.
    if (inFlight.has(root)) return;

    let service = serviceFor(domain, s.state);
    if (CONFIRM_DOMAINS.has(domain)) {
      const pendingConfirm = confirmations.get(root);
      if (!pendingConfirm) {
        root.classList.add("confirm");
        toast("Tap again to " + describeAction(service));
        const timer = setTimeout(() => {
          confirmations.delete(root);
          root.classList.remove("confirm");
        }, 3000);
        confirmations.set(root, { timer, service });
        return;
      }
      // Run exactly what the prompt offered, even if the state changed since.
      service = pendingConfirm.service;
      clearTimeout(pendingConfirm.timer);
      confirmations.delete(root);
      root.classList.remove("confirm");
    }
    root.classList.add("pending");
    inFlight.add(root);
    callService(domain, service, entityId).then(() => {
      if (domain === "scene" || domain === "button") {
        toast((tile.name || s.attributes.friendly_name || entityId) + " ✓");
      }
    }, () => {}).finally(() => {
      inFlight.delete(root);
      root.classList.remove("pending");
    });
  }

  function serviceFor(domain, state) {
    switch (domain) {
      case "lock": return state === "locked" ? "unlock" : "lock";
      case "cover": return state === "closed" || state === "closing" ? "open_cover" : "close_cover";
      case "scene": case "script": return "turn_on";
      case "button": return "press";
      case "media_player": return "toggle"; // power on/off; play/pause fails on an idle Cast device
      default: return "toggle";
    }
  }

  function describeAction(service) {
    return { open_cover: "open", close_cover: "close" }[service] || service;
  }

  function nudgeTemperature(entityId, dir) {
    const s = states.get(entityId);
    if (!s || s.attributes.temperature == null) return;
    const step = s.attributes.target_temp_step || (s.attributes.temperature_unit === "°F" ? 1 : 0.5);
    let next = s.attributes.temperature + dir * step;
    if (s.attributes.min_temp != null) next = Math.max(s.attributes.min_temp, next);
    if (s.attributes.max_temp != null) next = Math.min(s.attributes.max_temp, next);
    // Strip float noise (20.1 + 0.2 = 20.300000000000001) while keeping
    // steps finer than 0.1, e.g. target_temp_step 0.25.
    next = Number(next.toPrecision(12));
    // Optimistic update so repeated taps accumulate before HA echoes back.
    // A state update from HA replaces `s`, so the confirmed value is the one
    // this object held before its first optimistic change.
    if (!("confirmedTemp" in s)) s.confirmedTemp = s.attributes.temperature;
    const version = (s.tempVersion = (s.tempVersion || 0) + 1);
    s.attributes.temperature = next;
    render(entityId);
    callService("climate", "set_temperature", entityId, { temperature: next }).catch(() => {
      // Only the latest tap decides; roll back to HA's last confirmed value.
      if (states.get(entityId) === s && s.tempVersion === version) {
        s.attributes.temperature = s.confirmedTemp;
        render(entityId);
      }
    });
  }

  /* ---------- Cameras ---------- */

  const cameras = []; // { tile, parts, busy, last }
  let liveOpen = false;

  function camToken(entityId) {
    const s = states.get(entityId);
    return s && s.state !== "unavailable" ? s.attributes.access_token : null;
  }

  // Snapshots through HA's camera proxy. One request per camera at a time,
  // and nothing while the live view is up, to spare the Zero's CPU.
  function refreshCamera(cam, force) {
    if (!cam || cam.busy || liveOpen || secOpen || saverOn || document.hidden) return;
    const period = (Number(cam.tile.refresh) || 10) * 1000;
    if (!force && Date.now() - cam.last < period) return;
    const token = camToken(cam.tile.entity);
    if (!token) return;
    cam.busy = true;
    cam.last = Date.now();
    const img = new Image();
    img.onload = () => { cam.parts.img.src = img.src; cam.busy = false; };
    img.onerror = () => { cam.busy = false; };
    img.src = cfg.haUrl + "/api/camera_proxy/" + cam.tile.entity +
      "?token=" + encodeURIComponent(token) + "&_=" + Date.now();
  }
  setInterval(() => { for (const c of cameras) refreshCamera(c); }, 1000);

  let liveTimer = null;
  function openLive(tile, s) {
    const token = s.attributes.access_token;
    if (!token) { toast("No camera token yet"); return; }
    const ov = $("live");
    const img = $("live-img");
    $("live-name").textContent = tile.name || s.attributes.friendly_name || tile.entity;
    liveOpen = true;
    img.src = cfg.haUrl + "/api/camera_proxy_stream/" + tile.entity + "?token=" + encodeURIComponent(token);
    ov.hidden = false;
    clearTimeout(liveTimer);
    // MJPEG decoding is heavy on a Zero 2W: close by itself after 3 minutes.
    liveTimer = setTimeout(closeLive, 180000);
  }
  function closeLive() {
    clearTimeout(liveTimer);
    const img = $("live-img");
    img.removeAttribute("src"); // aborts the MJPEG stream
    $("live").hidden = true;
    liveOpen = false;
  }
  $("live").addEventListener("click", closeLive);

  /* ---------- Security view: every camera, filling the screen ---------- */

  let secOpen = false;
  let secTimer = null;
  let secAuto = null;
  let secIdx = 0;

  function openSecurity() {
    const n = cameras.length;
    if (!n) { toast("No cameras"); return; }
    const grid = $("sec-grid");
    grid.textContent = "";
    const cols = Math.ceil(Math.sqrt(n));
    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.style.gridTemplateRows = "repeat(" + Math.ceil(n / cols) + ", 1fr)";
    for (const cam of cameras) {
      const cell = el("div", "sec-cell");
      const img = el("img");
      img.alt = "";
      if (cam.parts.img.src) img.src = cam.parts.img.src;
      const st = states.get(cam.tile.entity);
      cam.secBadge = el("div", "cam-badge");
      cam.secBadge.hidden = true;
      cell.append(img, el("span", null, cam.tile.name || (st && st.attributes.friendly_name) || cam.tile.entity), cam.secBadge);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = states.get(cam.tile.entity);
        if (cur && cur.state !== "unavailable") openLive(cam.tile, cur);
        else toast("Unavailable");
      });
      cam.secImg = img;
      grid.append(cell);
      render(cam.tile.entity);
    }
    secOpen = true;
    $("sec").hidden = false;
    clearInterval(secTimer);
    // One snapshot request at a time, round-robin: each camera refreshes
    // every (cameras x 0.8 s), which the Zero 2W can keep up with.
    secTimer = setInterval(secTick, 800);
    clearTimeout(secAuto);
    secAuto = setTimeout(closeSecurity, 10 * 60 * 1000);
  }

  function secTick() {
    if (!secOpen || liveOpen || document.hidden || !cameras.length) return;
    const cam = cameras[secIdx++ % cameras.length];
    const token = camToken(cam.tile.entity);
    if (cam.secBusy || !token || !cam.secImg) return;
    cam.secBusy = true;
    const img = new Image();
    img.onload = () => { if (cam.secImg) cam.secImg.src = img.src; cam.secBusy = false; };
    img.onerror = () => { cam.secBusy = false; };
    img.src = cfg.haUrl + "/api/camera_proxy/" + cam.tile.entity +
      "?token=" + encodeURIComponent(token) + "&_=" + Date.now();
  }

  function closeSecurity() {
    secOpen = false;
    clearInterval(secTimer);
    clearTimeout(secAuto);
    $("sec").hidden = true;
    $("sec-grid").textContent = "";
    for (const cam of cameras) { cam.secImg = null; cam.secBadge = null; }
  }
  $("sec-bar").addEventListener("click", closeSecurity);

  /* ---------- Screensaver ---------- */

  // After 3 idle minutes show the art with a big clock and stop fetching
  // camera snapshots. The first tap only wakes the screen; it can't hit a tile.
  const IDLE_MS = 3 * 60 * 1000;
  let saverOn = false;
  let idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startSaver, IDLE_MS);
  }
  function tickSaver() {
    const d = new Date();
    $("saver-time").textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("saver-date").textContent = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }
  function startSaver() {
    if (liveOpen || secOpen) { resetIdle(); return; } // someone is watching a camera
    saverOn = true;
    tickSaver();
    $("saver").hidden = false;
  }
  setInterval(() => { if (saverOn) tickSaver(); }, 15000);
  $("saver").addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
  $("saver").addEventListener("click", (e) => {
    e.stopPropagation();
    saverOn = false;
    $("saver").hidden = true;
    resetIdle();
    for (const c of cameras) refreshCamera(c, true);
  });
  for (const ev of ["pointerdown", "keydown"]) {
    document.addEventListener(ev, () => { if (!saverOn) resetIdle(); }, true);
  }
  resetIdle();

  /* ---------- Mirror Home Assistant ---------- */

  // With "mirror" set, tiles come from HA instead of config.json: every
  // entity, grouped by area like HA's auto-generated Overview dashboard, or
  // the entities of a saved dashboard when "mirror" names one. config.json
  // tiles then only override names/icons, and "exclude" hides entities.
  const MIRROR_DOMAINS = ["camera", "light", "switch", "fan", "cover", "climate", "media_player",
    "lock", "vacuum", "scene", "script", "button", "input_boolean", "binary_sensor", "sensor"];
  const REGISTRY_EVENTS = ["entity_registry_updated", "device_registry_updated",
    "area_registry_updated", "lovelace_updated"];
  const excludeRes = (cfg.exclude || []).map((p) =>
    new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
  const overrides = new Map((cfg.tiles || []).map((t) => [t.entity, t]));

  function excluded(id) { return excludeRes.some((re) => re.test(id)); }

  function collectEntities(node, out) {
    if (Array.isArray(node)) {
      for (const n of node) {
        if (typeof n === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(n)) out.push(n);
        else collectEntities(n, out);
      }
    } else if (node && typeof node === "object") {
      if (typeof node.entity === "string") out.push(node.entity);
      for (const v of Object.values(node)) if (v && typeof v === "object") collectEntities(v, out);
    }
    return out;
  }

  async function mirrorTiles() {
    const withOverrides = (id) => Object.assign({ entity: id }, overrides.get(id));
    if (typeof cfg.mirror === "string") {
      try {
        const lv = await send({ type: "lovelace/config", url_path: cfg.mirror === "default" ? null : cfg.mirror });
        const ids = [...new Set(collectEntities(lv, []))].filter((id) => !excluded(id));
        if (ids.length) return ids.map(withOverrides);
      } catch (_) { /* no saved dashboard: fall back to the auto layout */ }
    }
    const [ents, devs, areas, all] = await Promise.all([
      send({ type: "config/entity_registry/list" }),
      send({ type: "config/device_registry/list" }),
      send({ type: "config/area_registry/list" }),
      send({ type: "get_states" }),
    ]);
    const reg = new Map(ents.map((e) => [e.entity_id, e]));
    const devArea = new Map(devs.map((d) => [d.id, d.area_id]));
    const groups = new Map();
    for (const st of all) {
      const id = st.entity_id;
      const rank = MIRROR_DOMAINS.indexOf(id.split(".")[0]);
      if (rank < 0 || excluded(id)) continue;
      const r = reg.get(id);
      // Same rule as HA's Overview: skip config/diagnostic, hidden and disabled entities.
      if (r && (r.entity_category || r.hidden_by || r.disabled_by)) continue;
      let area = (r && (r.area_id || devArea.get(r.device_id))) || "";
      if (!area && rank === 0) area = "\u0000cameras"; // area-less cameras get their own section on top
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push({ id, rank, label: String(st.attributes.friendly_name || id).toLowerCase() });
    }
    const list = [];
    for (const a of ["\u0000cameras", ...areas.map((x) => x.area_id), ""]) {
      const g = groups.get(a);
      if (!g || !g.length) continue;
      g.sort((x, y) => x.rank - y.rank || x.label.localeCompare(y.label));
      const heading = a === "\u0000cameras" ? "Cameras" : a ? (areas.find((x) => x.area_id === a) || {}).name || a : "Other";
      list.push({ heading });
      for (const t of g) list.push(withOverrides(t.id));
    }
    return list;
  }

  let resyncTimer = null;
  function scheduleResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      loadSnapshot().catch((err) => showError("Failed to refresh from HA: " + err.message));
    }, 2000);
  }

  /* ---------- WebSocket ---------- */

  function send(msg) {
    const id = ++msgId;
    msg.id = id;
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  }

  function callService(domain, service, entityId, data) {
    return send({
      type: "call_service",
      domain,
      service,
      service_data: data || {},
      target: { entity_id: entityId },
    }).catch((err) => {
      toast("Failed: " + err.message);
      throw err;
    });
  }

  function connect() {
    const url = cfg.haUrl.replace(/^http/i, "ws") + "/api/websocket";
    setConn("connecting", "Connecting…");
    try {
      ws = new WebSocket(url);
    } catch (err) {
      // A URL the browser rejects won't get better by retrying.
      showError("Cannot connect to " + cfg.haUrl + ": " + err.message);
      setConn("down", "Invalid Home Assistant URL");
      return;
    }

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error("connection lost"));
      pending.clear();
      // Anything shown now may be stale: mark every tile unavailable (and
      // drop pending lock/cover confirmations) until a fresh snapshot lands,
      // so nothing acts on a state that changed while we were disconnected.
      states.clear();
      for (const t of tiles.values()) cancelConfirm(t.el);
      renderAll();
      // Retrying a rejected token can't succeed; reload the page after fixing it.
      if (authFailed) return;
      setConn("down", "Disconnected — retrying");
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "auth_required":
        ws.send(JSON.stringify({ type: "auth", access_token: cfg.token }));
        return;
      case "auth_invalid":
        authFailed = true;
        showError("Home Assistant rejected the access token: " + (msg.message || "") +
          ". Fix the token in config.json, then reload.");
        setConn("down", "Auth failed");
        return;
      case "auth_ok":
        retryDelay = 1000;
        showError("");
        setConn("ok", "Connected to Home Assistant " + (msg.ha_version || ""));
        onAuthenticated();
        return;
      case "result": {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error((msg.error && msg.error.message) || "request failed"));
        return;
      }
      case "event": {
        const evType = msg.event && msg.event.event_type;
        if (evType && evType !== "state_changed") {
          if (cfg.mirror) scheduleResync();
          return;
        }
        const data = msg.event && msg.event.data;
        if (!data) return;
        const owner = badgeOwner.get(data.entity_id);
        if (!tiles.has(data.entity_id) && !owner) return;
        if (eventsDuringSnapshot) eventsDuringSnapshot.set(data.entity_id, data.new_state);
        if (data.new_state) states.set(data.entity_id, data.new_state);
        else states.delete(data.entity_id);
        if (tiles.has(data.entity_id)) render(data.entity_id);
        if (owner) render(owner);
        return;
      }
    }
  }

  async function onAuthenticated() {
    try {
      // Subscribe first so no change slips between the snapshot and the stream.
      await send({ type: "subscribe_events", event_type: "state_changed" });
      if (cfg.mirror) {
        for (const t of REGISTRY_EVENTS) await send({ type: "subscribe_events", event_type: t });
      }
      await loadSnapshot();
    } catch (err) {
      showError("Failed to load states: " + err.message);
    }
  }

  async function loadSnapshot() {
    try {
      eventsDuringSnapshot = new Map();
      if (cfg.mirror) buildTiles(await mirrorTiles());
      const all = await send({ type: "get_states" });
      // Rebuild from the snapshot so entities removed from HA don't linger
      // across reconnects, then replay anything newer than the snapshot.
      states.clear();
      for (const s of all) if (tiles.has(s.entity_id) || badgeOwner.has(s.entity_id)) states.set(s.entity_id, s);
      for (const [id, s] of eventsDuringSnapshot) {
        if (s) states.set(id, s);
        else states.delete(id);
      }
      renderAll();
      const missing = [...tiles.keys()].filter((id) => !states.has(id));
      if (missing.length) toast("Not found in HA: " + missing.join(", "));
    } finally {
      eventsDuringSnapshot = null;
    }
  }

  buildTiles(cfg.mirror ? [] : cfg.tiles);
  connect();
})();
