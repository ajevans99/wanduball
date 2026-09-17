import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRoom } from "../src/lib/room-selection.ts";

const live = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
const other = "150c9a24-cbad-4238-9c1e-186623667ad5";
test("root uses the configured room; previews without configuration use practice", () => {
  assert.deepEqual(selectRoom(new URLSearchParams(), live), { roomId: live, error: "" });
  assert.deepEqual(selectRoom(new URLSearchParams(), null), { roomId: null, error: "" });
});
test("explicit room overrides default; explicit practice overrides both", () => {
  assert.equal(selectRoom(new URLSearchParams({ room: other }), live).roomId, other);
  assert.deepEqual(selectRoom(new URLSearchParams({ room: other, mode: "practice" }), live), { roomId: null, error: "" });
});
test("invalid and empty room links fail explicitly instead of loading practice or default", () => {
  for (const room of ["", "invalid"]) {
    assert.ok(selectRoom(new URLSearchParams({ room }), live).error);
  }
  assert.ok(selectRoom(new URLSearchParams(), "invalid").error);
});
