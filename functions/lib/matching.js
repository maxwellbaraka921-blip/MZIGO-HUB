"use strict";

/*
 * Auto-accept rules. A truck owner sets rules once. A load that fits every rule
 * is accepted for that truck without the owner doing anything.
 *
 * truck: { status, capacityT, activeLoadId, ownerId, approvedAt,
 *          rules: { autoAccept, routes: [{from, to}], minPriceKES, maxTonnes, cargo: [] } }
 * load:  { from, to, tonnes, cargo, priceKES, shipperId }
 */

function routeMatches(routes, from, to) {
  if (!Array.isArray(routes)) return false;
  return routes.some(function (r) {
    return r && (r.from === "*" || r.from === from) && (r.to === "*" || r.to === to);
  });
}

/* Checks that apply to every acceptance, manual or automatic. Returns { ok, reason }. */
function safety(truck, load) {
  if (!truck || !load) return { ok: false, reason: "missing" };
  if (truck.status !== "approved") return { ok: false, reason: "truck not verified" };
  if (truck.activeLoadId) return { ok: false, reason: "truck busy" };
  if (truck.ownerId === load.shipperId) return { ok: false, reason: "own load" };
  if (load.tonnes > truck.capacityT) return { ok: false, reason: "too heavy for truck" };
  return { ok: true };
}

/* The owner's own preferences. These only apply to automatic acceptance. */
function preferences(truck, load) {
  var rules = truck.rules || {};
  if (rules.maxTonnes && load.tonnes > rules.maxTonnes) return { ok: false, reason: "above max weight rule" };
  if (!routeMatches(rules.routes, load.from, load.to)) return { ok: false, reason: "route not in rules" };
  if (load.priceKES < (rules.minPriceKES || 0)) return { ok: false, reason: "below minimum price" };
  if (Array.isArray(rules.cargo) && rules.cargo.length && rules.cargo.indexOf(load.cargo) === -1) {
    return { ok: false, reason: "cargo type not accepted" };
  }
  return { ok: true };
}

/* Manual accept: the owner chose this load, so only the safety checks apply. */
function check(truck, load) {
  return safety(truck, load);
}

function autoAcceptCheck(truck, load) {
  if (!truck || !truck.rules || truck.rules.autoAccept !== true) return { ok: false, reason: "auto-accept off" };
  var s = safety(truck, load);
  return s.ok ? preferences(truck, load) : s;
}

/* Several trucks may fit. Prefer the one whose owner asks for the least, then the longest-verified. */
function pickBest(trucks, load) {
  var fits = trucks.filter(function (t) { return autoAcceptCheck(t, load).ok; });
  fits.sort(function (a, b) {
    var pa = (a.rules && a.rules.minPriceKES) || 0;
    var pb = (b.rules && b.rules.minPriceKES) || 0;
    if (pa !== pb) return pa - pb;
    return (a.approvedAtMs || 0) - (b.approvedAtMs || 0);
  });
  return fits;
}

module.exports = { routeMatches: routeMatches, safety: safety, preferences: preferences, check: check, autoAcceptCheck: autoAcceptCheck, pickBest: pickBest };
