import { test, expect } from "bun:test";
import { getByPath, setByPath, pathExists } from "./path.ts";

test("getByPath reads nested values", () => {
  const wf = { "6": { inputs: { text: "hi" } } };
  expect(getByPath(wf, "6.inputs.text")).toBe("hi");
  expect(getByPath(wf, "6.inputs")).toEqual({ text: "hi" });
});

test("getByPath returns undefined for missing paths", () => {
  const wf = { "6": { inputs: { text: "hi" } } };
  expect(getByPath(wf, "6.inputs.missing")).toBeUndefined();
  expect(getByPath(wf, "99.inputs.text")).toBeUndefined();
});

test("setByPath writes nested values", () => {
  const wf = { "10": { inputs: { width: 512, height: 512 } } };
  setByPath(wf, "10.inputs.width", 1024);
  expect(wf["10"].inputs.width).toBe(1024);
});

test("setByPath indexes arrays via numeric segments", () => {
  const wf = { "6": { inputs: { clip: ["48", 0] } } };
  setByPath(wf, "6.inputs.clip.1", 2);
  expect(wf["6"].inputs.clip[1]).toBe(2);
});

test("setByPath throws on missing intermediate segment", () => {
  const wf = { "6": { inputs: { text: "hi" } } };
  expect(() => setByPath(wf, "6.nope.text", 1)).toThrow(/does not exist/);
});

test("pathExists reflects resolvability", () => {
  const wf = { "6": { inputs: { text: "hi" } } };
  expect(pathExists(wf, "6.inputs.text")).toBe(true);
  expect(pathExists(wf, "6.inputs.seed")).toBe(false);
});
