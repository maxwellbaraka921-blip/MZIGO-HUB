/*
 * Route distances and the price estimate. No page code in here, so it can be tested in Node.
 * Distances are approximate road kilometres.
 */
(function (root) {
  "use strict";

  var PLACES = {
    mombasa:    { name: "Mombasa",        country: "KE" },
    nairobi:    { name: "Nairobi",        country: "KE" },
    nakuru:     { name: "Nakuru",         country: "KE" },
    eldoret:    { name: "Eldoret",        country: "KE" },
    kisumu:     { name: "Kisumu",         country: "KE" },
    kampala:    { name: "Kampala",        country: "UG" },
    kigali:     { name: "Kigali",         country: "RW" },
    arusha:     { name: "Arusha",         country: "TZ" },
    dar:        { name: "Dar es Salaam",  country: "TZ" },
    malaba:     { name: "Malaba",         country: "KE", border: true },
    katuna:     { name: "Katuna",         country: "UG", border: true },
    namanga:    { name: "Namanga",        country: "KE", border: true },
    lungalunga: { name: "Lunga Lunga",    country: "KE", border: true }
  };

  var EDGES = [
    ["mombasa", "nairobi", 480],
    ["nairobi", "nakuru", 160],
    ["nakuru", "eldoret", 150],
    ["eldoret", "malaba", 120],
    ["malaba", "kampala", 230],
    ["kampala", "katuna", 430],
    ["katuna", "kigali", 80],
    ["nakuru", "kisumu", 190],
    ["nairobi", "namanga", 165],
    ["namanga", "arusha", 105],
    ["arusha", "dar", 650],
    ["mombasa", "lungalunga", 100],
    ["lungalunga", "dar", 450]
  ];

  var ADJ = {};
  EDGES.forEach(function (e) {
    (ADJ[e[0]] = ADJ[e[0]] || []).push([e[1], e[2]]);
    (ADJ[e[1]] = ADJ[e[1]] || []).push([e[0], e[2]]);
  });

  function route(from, to) {
    if (!PLACES[from] || !PLACES[to]) return null;
    var dist = {}, prev = {}, done = {};
    Object.keys(PLACES).forEach(function (k) { dist[k] = Infinity; });
    dist[from] = 0;
    while (true) {
      var cur = null;
      Object.keys(dist).forEach(function (k) {
        if (!done[k] && (cur === null || dist[k] < dist[cur])) cur = k;
      });
      if (cur === null || dist[cur] === Infinity) break;
      if (cur === to) break;
      done[cur] = true;
      (ADJ[cur] || []).forEach(function (n) {
        var d = dist[cur] + n[1];
        if (d < dist[n[0]]) { dist[n[0]] = d; prev[n[0]] = cur; }
      });
    }
    if (dist[to] === Infinity) return null;
    var path = [to];
    while (path[0] !== from) path.unshift(prev[path[0]]);
    var borders = path.filter(function (id) { return PLACES[id].border; }).length;
    return { km: dist[to], path: path, borders: borders };
  }

  function truckFor(tonnes, cfg) {
    var order = ["pickup", "light", "medium", "heavy"];
    var heavyMax = cfg.maxTonnes.heavy;
    var trucks = tonnes > heavyMax ? Math.ceil(tonnes / heavyMax) : 1;
    var each = tonnes / trucks;
    var cls = "heavy";
    for (var i = 0; i < order.length; i++) {
      if (each <= cfg.maxTonnes[order[i]]) { cls = order[i]; break; }
    }
    return { trucks: trucks, truckClass: cls };
  }

  /* Returns prices in KES, or null if the inputs cannot be priced. */
  function estimate(opts, cfg) {
    cfg = cfg || root.MZIGO_CONFIG;
    var r = route(opts.from, opts.to);
    var tonnes = Number(opts.tonnes);
    var cargo = cfg.cargo[opts.cargo];
    if (!r || r.km === 0 || !(tonnes > 0) || !cargo) return null;

    var t = truckFor(tonnes, cfg);
    var perTruck = r.km * cfg.perKmByTruck[t.truckClass] * cargo.mult;
    if (opts.flexible) perTruck *= (1 - cfg.flexibleDiscount);
    perTruck += r.borders * cfg.borderFee;
    perTruck = Math.max(perTruck, cfg.minPerTruck);

    var mid = perTruck * t.trucks;
    return {
      km: r.km,
      path: r.path,
      borders: r.borders,
      trucks: t.trucks,
      truckClass: t.truckClass,
      mid: mid,
      low: mid * (1 - cfg.spread),
      high: mid * (1 + cfg.spread)
    };
  }

  function convert(kes, code, cfg) {
    cfg = cfg || root.MZIGO_CONFIG;
    var step = cfg.roundTo[code] || 1;
    return Math.round((kes * cfg.ratePerKES[code]) / step) * step;
  }

  function format(n, code) {
    return code + " " + Math.round(n).toLocaleString("en-US");
  }

  var api = {
    PLACES: PLACES,
    EDGES: EDGES,
    route: route,
    estimate: estimate,
    convert: convert,
    format: format
  };

  root.MzigoPricing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
