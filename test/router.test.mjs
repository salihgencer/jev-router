import test from "node:test";
import assert from "node:assert/strict";
import { clientConfig } from "../src/router.mjs";
import { DEFAULT_JEV_MODEL, jevModel } from "../src/config.mjs";

test("pins the Jev model instead of the SDK's floating jev-latest", () => {
  assert.equal(jevModel({}), DEFAULT_JEV_MODEL);
  assert.notEqual(DEFAULT_JEV_MODEL, "jev-latest");
  assert.match(DEFAULT_JEV_MODEL, /^jev-\d+\.\d+/);
});

test("JEV_MODEL overrides the pin, blank values fall back to it", () => {
  assert.equal(jevModel({ JEV_MODEL: "jev-1.14.0" }), "jev-1.14.0");
  assert.equal(jevModel({ JEV_MODEL: "  " }), DEFAULT_JEV_MODEL);
});

test("client config carries the pinned model, tight budget and quiet logging", () => {
  const config = clientConfig({ JEV_API_KEY: "k" });
  assert.equal(config.apiKey, "k");
  assert.equal(config.defaultModel, DEFAULT_JEV_MODEL);
  assert.equal(config.logLevel, "warn");
  assert.ok(config.timeout <= 1500);
  assert.equal(clientConfig({ TYPESAFE_API_KEY: "t" }).apiKey, "t");
});
