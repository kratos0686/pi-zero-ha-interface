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
    button: "🔘", media_player: "🎵", person: "👤", vacuum: "🧹",
  };
  const TOGGLE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean", "automation", "media_player"]);
  // Domains where an accidental tap matters: require a second tap to confirm.
  const CONFIRM_DOMAINS = new Set(["lock", "cover"]);
  const ON_STATES = new Set(["on", "open", "opening", "unlocked", "playing", "home", "heat", "cool", "heat_cool", "auto"]);

  const tiles = new Map(); // entity_id -> { tile, el, parts }
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

  function buildTiles() {
    const grid = $("grid");
    grid.textContent = "";
    for (const tile of cfg.tiles) {
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
      body.append(parts.icon);

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
  }

  function stopTap(node) {
    node.addEventListener("click", (e) => e.stopPropagation());
    node.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  function isActionable(domain) {
    return TOGGLE_DOMAINS.has(domain) || CONFIRM_DOMAINS.has(domain) ||
      domain === "scene" || domain === "script" || domain === "button";
  }

  function formatState(s) {
    if (!s) return "—";
    const unit = s.attributes.unit_of_measurement;
    const domain = s.entity_id.split(".")[0];
    if (domain === "sensor") {
      const n = Number(s.state);
      const val = Number.isFinite(n) && s.state.trim() !== "" ? String(Math.round(n * 10) / 10) : s.state;
      return unit ? val + " " + unit : val;
    }
    if (domain === "light" && s.state === "on" && s.attributes.brightness != null) {
      return "On · " + Math.round((s.attributes.brightness / 255) * 100) + "%";
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
    root.classList.toggle("on", !!s && ON_STATES.has(s.state));
    if (parts.main && TOGGLE_DOMAINS.has(domain)) {
      parts.main.setAttribute("aria-pressed", String(!!s && ON_STATES.has(s.state)));
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
      case "media_player": return "media_play_pause";
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
        const data = msg.event && msg.event.data;
        if (!data || !tiles.has(data.entity_id)) return;
        if (eventsDuringSnapshot) eventsDuringSnapshot.set(data.entity_id, data.new_state);
        if (data.new_state) states.set(data.entity_id, data.new_state);
        else states.delete(data.entity_id);
        render(data.entity_id);
        return;
      }
    }
  }

  async function onAuthenticated() {
    try {
      // Subscribe first so no change slips between the snapshot and the stream.
      await send({ type: "subscribe_events", event_type: "state_changed" });
      eventsDuringSnapshot = new Map();
      const all = await send({ type: "get_states" });
      // Rebuild from the snapshot so entities removed from HA don't linger
      // across reconnects, then replay anything newer than the snapshot.
      states.clear();
      for (const s of all) if (tiles.has(s.entity_id)) states.set(s.entity_id, s);
      for (const [id, s] of eventsDuringSnapshot) {
        if (s) states.set(id, s);
        else states.delete(id);
      }
      renderAll();
      const missing = [...tiles.keys()].filter((id) => !states.has(id));
      if (missing.length) toast("Not found in HA: " + missing.join(", "));
    } catch (err) {
      showError("Failed to load states: " + err.message);
    } finally {
      eventsDuringSnapshot = null;
    }
  }

  buildTiles();
  connect();
})();
