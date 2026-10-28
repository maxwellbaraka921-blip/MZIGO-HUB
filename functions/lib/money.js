"use strict";

/* Amounts are whole Kenyan shillings. M-Pesa takes no cents. */
var MIN_KES = 100;
var MAX_KES = 250000; // M-Pesa limit for one transaction

function isValidAmount(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_KES && n <= MAX_KES;
}

/* Splits a payment into the owner's payout and Mzigo Hub's commission. */
function split(amountKES, rate) {
  if (!Number.isInteger(amountKES) || amountKES <= 0) throw new Error("Bad amount");
  if (!(rate >= 0 && rate < 0.5)) throw new Error("Bad commission rate");
  var fee = Math.round(amountKES * rate);
  return { fee: fee, payout: amountKES - fee };
}

module.exports = { MIN_KES: MIN_KES, MAX_KES: MAX_KES, isValidAmount: isValidAmount, split: split };
