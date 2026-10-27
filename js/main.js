(function () {
  "use strict";

  var CFG = window.MZIGO_CONFIG;
  var P = window.MzigoPricing;

  var COUNTRIES = {
    KE: { name: "Kenya",    currency: "KES", momo: "M-Pesa",                   from: "mombasa", to: "nairobi" },
    UG: { name: "Uganda",   currency: "UGX", momo: "MTN MoMo or Airtel Money", from: "kampala", to: "nairobi" },
    RW: { name: "Rwanda",   currency: "RWF", momo: "MTN MoMo or Airtel Money", from: "kigali",  to: "kampala" },
    TZ: { name: "Tanzania", currency: "TZS", momo: "M-Pesa or Airtel Money",   from: "dar",     to: "arusha" }
  };

  // Sample loads for the board. Prices are worked out with the same model as the price check.
  var LOADS = [
    { from: "mombasa", to: "nairobi", cargo: "building", what: "Building materials", t: 28, when: "Pickup Thursday",  back: false },
    { from: "nairobi", to: "kampala", cargo: "general",  what: "Household goods",    t: 12, when: "Pickup Friday",    back: false },
    { from: "kampala", to: "nairobi", cargo: "farm",     what: "Farm produce",       t: 20, when: "Flexible dates",   back: true },
    { from: "kampala", to: "kigali",  cargo: "cold",     what: "Chilled dairy",      t: 8,  when: "Pickup Monday",    back: false },
    { from: "dar",     to: "arusha",  cargo: "container",what: "40 ft container",    t: 24, when: "Pickup Tuesday",   back: false },
    { from: "eldoret", to: "nairobi", cargo: "farm",     what: "Maize",              t: 28, when: "Pickup Wednesday", back: false }
  ];

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function store(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) {}
    return null;
  }

  var state = { country: "KE", currency: "KES" };

  /* ---------- Selects ---------- */
  function fillPlaces() {
    var groups = {};
    Object.keys(P.PLACES).forEach(function (id) {
      var p = P.PLACES[id];
      if (p.border) return;
      (groups[p.country] = groups[p.country] || []).push(id);
    });
    ["from", "to"].forEach(function (selId) {
      var sel = $("#" + selId);
      Object.keys(COUNTRIES).forEach(function (code) {
        if (!groups[code]) return;
        var og = document.createElement("optgroup");
        og.label = COUNTRIES[code].name;
        groups[code].forEach(function (id) {
          var o = document.createElement("option");
          o.value = id;
          o.textContent = P.PLACES[id].name;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
    });
    var cargo = $("#cargo");
    Object.keys(CFG.cargo).forEach(function (key) {
      var o = document.createElement("option");
      o.value = key;
      o.textContent = CFG.cargo[key].label;
      cargo.appendChild(o);
    });
  }

  /* ---------- Price check ---------- */
  function renderEstimate() {
    var out = $("#est-range");
    var meta = $("#est-meta");
    var from = $("#from").value, to = $("#to").value;
    var tonnes = parseFloat($("#weight").value);

    if (from === to) {
      out.textContent = state.currency + " 0";
      meta.textContent = "Choose two different places.";
      return;
    }
    if (!(tonnes > 0)) {
      out.textContent = state.currency + " 0";
      meta.textContent = "Enter the weight in tonnes.";
      return;
    }
    var e = P.estimate({ from: from, to: to, tonnes: tonnes, cargo: $("#cargo").value, flexible: $("#flex").checked });
    if (!e) {
      out.textContent = state.currency + " 0";
      meta.textContent = "We cannot price this route yet.";
      return;
    }
    var low = P.convert(e.low, state.currency);
    var high = P.convert(e.high, state.currency);
    out.textContent = P.format(low, state.currency) + " to " + high.toLocaleString("en-US");

    var parts = [e.km.toLocaleString("en-US") + " km"];
    parts.push(e.trucks + " " + CFG.truckLabels[e.truckClass] + (e.trucks > 1 ? "s" : ""));
    parts.push(e.borders === 0 ? "no border crossing" : e.borders + " border crossing" + (e.borders > 1 ? "s" : ""));
    meta.textContent = parts.join(", ");
  }

  /* ---------- Load board ---------- */
  function renderBoard() {
    var list = $("#board-list");
    list.textContent = "";
    LOADS.forEach(function (l) {
      var e = P.estimate({ from: l.from, to: l.to, tonnes: l.t, cargo: l.cargo, flexible: l.back });
      if (!e) return;
      var countries = {};
      e.path.forEach(function (id) { countries[P.PLACES[id].country] = true; });
      // A border node belongs to one country in the table but the route reaches the next one too.
      countries[P.PLACES[l.from].country] = true;
      countries[P.PLACES[l.to].country] = true;

      var li = document.createElement("li");
      li.className = "board-row";
      li.setAttribute("data-countries", Object.keys(countries).join(" "));

      var route = document.createElement("div");
      var name = document.createElement("span");
      name.className = "route-name";
      name.textContent = P.PLACES[l.from].name + " to " + P.PLACES[l.to].name;
      var sub = document.createElement("span");
      sub.className = "cell-sub";
      sub.textContent = e.km.toLocaleString("en-US") + " km";
      route.appendChild(name);
      route.appendChild(sub);
      if (e.borders > 0) route.appendChild(tag("Crosses " + e.borders + " border" + (e.borders > 1 ? "s" : ""), true));
      if (l.back) route.appendChild(tag("Good for a return trip", false));

      var cargo = document.createElement("div");
      var c1 = document.createElement("span");
      c1.textContent = l.what;
      var c2 = document.createElement("span");
      c2.className = "cell-sub";
      c2.textContent = l.t + " t, " + CFG.truckLabels[e.truckClass];
      cargo.appendChild(c1);
      cargo.appendChild(c2);

      var when = document.createElement("div");
      when.textContent = l.when;

      var price = document.createElement("div");
      price.className = "cell-price";
      price.setAttribute("data-kes", String(e.mid));
      price.textContent = "About " + P.format(P.convert(e.mid, state.currency), state.currency);

      var act = document.createElement("a");
      act.className = "btn btn--small";
      act.href = "#join";
      act.setAttribute("data-role", "owner");
      act.setAttribute("data-details", "I can carry " + P.PLACES[l.from].name + " to " + P.PLACES[l.to].name + ", " + l.t + " t " + l.what.toLowerCase());
      act.textContent = "Offer a truck";

      [route, cargo, when, price, act].forEach(function (n) { li.appendChild(n); });
      list.appendChild(li);
    });
    applyBoardFilter();
  }

  function tag(text, isBorder) {
    var s = document.createElement("span");
    s.className = "tag" + (isBorder ? " tag--border" : "");
    s.textContent = text;
    var wrap = document.createElement("div");
    wrap.appendChild(s);
    return wrap;
  }

  function applyBoardFilter() {
    var checked = $('input[name="boardCountry"]:checked');
    var want = checked ? checked.value : "all";
    var shown = 0;
    $$(".board-row").forEach(function (row) {
      var codes = row.getAttribute("data-countries").split(" ");
      var show = want === "all" || codes.indexOf(want) !== -1;
      row.hidden = !show;
      if (show) shown++;
    });
    $("#board-empty").hidden = shown !== 0;
  }

  function repriceBoard() {
    $$(".cell-price").forEach(function (el) {
      var kes = parseFloat(el.getAttribute("data-kes"));
      el.textContent = "About " + P.format(P.convert(kes, state.currency), state.currency);
    });
  }

  /* ---------- Country and currency ---------- */
  function setCurrency(code) {
    state.currency = code;
    $("#currency").value = code;
    renderEstimate();
    repriceBoard();
  }

  function setCountry(code, opts) {
    if (!COUNTRIES[code]) code = "KE";
    opts = opts || {};
    state.country = code;
    var c = COUNTRIES[code];
    document.documentElement.setAttribute("data-country", code);
    $("#country").value = code;
    $$("[data-country-name]").forEach(function (el) { el.textContent = c.name; });
    $$("[data-momo]").forEach(function (el) { el.textContent = c.momo; });
    $("#joinCountry").value = c.name;
    if (opts.resetRoute !== false) {
      $("#from").value = c.from;
      $("#to").value = c.to;
    }
    setCurrency(c.currency);
    if (opts.persist) store("mzigo.country", code);
  }

  /* ---------- Join form ---------- */
  function setRole(role) {
    var r = $('input[name="role"][value="' + role + '"]');
    if (r) r.checked = true;
  }

  function wireRoleLinks() {
    document.addEventListener("click", function (ev) {
      var a = ev.target.closest && ev.target.closest("a[data-role]");
      if (!a) return;
      setRole(a.getAttribute("data-role"));
      var details = a.getAttribute("data-details");
      if (a.id === "est-post") {
        var from = $("#from"), to = $("#to");
        details = "Load: " + from.options[from.selectedIndex].text + " to " + to.options[to.selectedIndex].text +
          ", " + $("#weight").value + " t " + $("#cargo").options[$("#cargo").selectedIndex].text.toLowerCase() +
          ". Estimate " + $("#est-range").textContent + ".";
      }
      if (details) $("#details").value = details;
    });
  }

  function setStatus(msg, kind) {
    var el = $("#form-status");
    el.textContent = msg;
    el.className = "form-status" + (kind ? " is-" + kind : "");
  }

  function handleSubmit(ev) {
    ev.preventDefault();
    var form = ev.target;
    if ($("#website").value) return; // spam trap filled in

    var data = {
      role: ($('input[name="role"]:checked') || {}).value || "shipper",
      name: $("#name").value.trim(),
      phone: $("#phone").value.trim(),
      country: $("#joinCountry").value,
      details: $("#details").value.trim()
    };
    if (!data.name) { setStatus("Enter your name.", "error"); $("#name").focus(); return; }
    if (data.phone.replace(/[^0-9]/g, "").length < 9) { setStatus("Enter a phone number with at least 9 digits.", "error"); $("#phone").focus(); return; }

    if (CFG.formEndpoint) {
      setStatus("Sending...", "");
      fetch(CFG.formEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(data)
      }).then(function (res) {
        if (!res.ok) throw new Error("Request failed");
        form.reset();
        setCountry(state.country, { resetRoute: false });
        setStatus("You are on the list. We will message you on " + data.phone + ".", "ok");
      }).catch(function () {
        setStatus("The form could not send. Check your connection and try again.", "error");
      });
      return;
    }

    var subject = "Mzigo Hub waitlist: " + data.role;
    var body = "Role: " + data.role + "\nName: " + data.name + "\nPhone: " + data.phone +
      "\nCountry: " + data.country + "\nRoute or fleet: " + data.details;
    window.location.href = "mailto:" + CFG.contactEmail + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    setStatus("Your email app should open with your details. Send the email to join the list.", "ok");
  }

  /* ---------- Start ---------- */
  function init() {
    fillPlaces();
    renderBoard();

    var fromUrl = null;
    try { fromUrl = new URLSearchParams(window.location.search).get("country"); } catch (e) {}
    var saved = store("mzigo.country");
    setCountry((fromUrl || saved || "KE").toUpperCase(), { persist: false });

    $("#country").addEventListener("change", function (e) { setCountry(e.target.value, { persist: true }); });
    $("#currency").addEventListener("change", function (e) { setCurrency(e.target.value); });
    ["from", "to", "cargo", "weight", "flex"].forEach(function (id) {
      var el = $("#" + id);
      el.addEventListener("input", renderEstimate);
      el.addEventListener("change", renderEstimate);
    });
    $("#estimator").addEventListener("submit", function (e) { e.preventDefault(); });
    $$('input[name="boardCountry"]').forEach(function (r) { r.addEventListener("change", applyBoardFilter); });
    $("#join-form").addEventListener("submit", handleSubmit);
    wireRoleLinks();

    $("#year").textContent = new Date().getFullYear();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
