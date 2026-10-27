/*
 * Mzigo Hub settings. Edit this file to change the waitlist form and the price model.
 * All prices in the model are in Kenyan shillings (KES) and converted for display.
 */
(function (root) {
  root.MZIGO_CONFIG = {
    // Waitlist form. Create a free form at formspree.io (or a similar service)
    // and paste its URL here, e.g. "https://formspree.io/f/abcdwxyz".
    // Leave empty and the form opens an email draft instead.
    formEndpoint: "https://formspree.io/f/xeaagdnl",
    contactEmail: "",

    // Approximate value of 1 Kenyan shilling in each currency. Update when rates move.
    ratePerKES: { KES: 1, UGX: 28, RWF: 11, TZS: 20, USD: 0.0077 },
    // Prices are rounded to these steps so estimates do not look falsely exact.
    roundTo: { KES: 500, UGX: 10000, RWF: 5000, TZS: 10000, USD: 10 },

    // Price model (KES). These are starting points, tune them with real quotes from truck owners.
    perKmByTruck: { pickup: 55, light: 95, medium: 160, heavy: 240 },
    truckLabels: {
      pickup: "pickup",
      light: "light truck",
      medium: "medium truck",
      heavy: "heavy truck"
    },
    maxTonnes: { pickup: 1.5, light: 5, medium: 12, heavy: 28 },
    borderFee: 20000,        // per truck, per border crossing (paperwork, waiting, insurance)
    minPerTruck: 6000,
    flexibleDiscount: 0.12,  // discount when the date is flexible and a returning truck can fill the load
    spread: 0.12,            // range shown is the typical price minus and plus this share

    cargo: {
      general:   { label: "General cargo",          mult: 1.0 },
      building:  { label: "Building materials",     mult: 1.0 },
      farm:      { label: "Farm produce",           mult: 1.15 },
      container: { label: "Container",              mult: 1.15 },
      machinery: { label: "Vehicles or machinery",  mult: 1.3 },
      cold:      { label: "Chilled or frozen",      mult: 1.35 },
      hazard:    { label: "Fuel or chemicals",      mult: 1.4 }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
