import test from "node:test";
import assert from "node:assert/strict";
import { romanize } from "../.test-build/romanize.mjs";

test("Korean, Russian and kana lines read in Latin letters", () => {
  assert.equal(romanize("사랑해"), "saranghae");
  assert.equal(romanize("너를 사랑해"), "neoreul saranghae");
  assert.equal(romanize("Привет, мир"), "Privet, mir");
  assert.equal(romanize("さくら"), "sakura");
  assert.equal(romanize("トーキョー"), "tookyoo");
  assert.equal(romanize("ちょっと"), "chotto");
});

test("Indian scripts read the way people type lyrics", () => {
  assert.equal(romanize("मेरा दिल"), "mera dil");
  assert.equal(romanize("संगीत"), "sangeet");
  assert.equal(romanize("ప్రేమ"), "prema", "Telugu keeps the final a");
  assert.equal(romanize("நான்"), "naan");
  assert.equal(romanize("ज़िंदगी"), "zindagee");
});

test("Latin lines and kanji are left alone", () => {
  assert.equal(romanize("Hello world"), null);
  assert.equal(romanize("東京の夜"), null, "kanji needs a dictionary");
});
