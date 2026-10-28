"use strict";

/*
 * The life of a load. Every status change in the backend goes through canMove(),
 * so a load can never skip a step (for example, be delivered without being paid for).
 */
var MOVES = {
  open:            ["accepted", "cancelled"],
  accepted:        ["payment_pending", "cancelled"],
  payment_pending: ["paid", "accepted"],
  paid:            ["in_transit", "disputed"],
  in_transit:      ["payout_pending", "disputed"],
  payout_pending:  ["completed", "payout_failed"],
  payout_failed:   ["payout_pending"],
  disputed:        ["payout_pending", "refunded"],
  completed:       [],
  cancelled:       [],
  refunded:        []
};

var FINISHED = ["completed", "cancelled", "refunded"];

function canMove(from, to) {
  return Array.isArray(MOVES[from]) && MOVES[from].indexOf(to) !== -1;
}

function isFinished(status) {
  return FINISHED.indexOf(status) !== -1;
}

module.exports = { MOVES: MOVES, canMove: canMove, isFinished: isFinished };
