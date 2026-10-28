"use strict";

/*
 * Turns what a person types into the 12-digit Kenyan format M-Pesa needs (2547XXXXXXXX).
 * Returns null when the number cannot be a Kenyan mobile number.
 */
function normalizeKenyaPhone(input) {
  if (typeof input !== "string") return null;
  var digits = input.replace(/[\s\-().]/g, "");
  if (digits.charAt(0) === "+") digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  if (digits.indexOf("254") === 0) {
    // already international
  } else if (digits.charAt(0) === "0" && digits.length === 10) {
    digits = "254" + digits.slice(1);
  } else if (digits.length === 9) {
    digits = "254" + digits;
  } else {
    return null;
  }
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

module.exports = { normalizeKenyaPhone: normalizeKenyaPhone };
