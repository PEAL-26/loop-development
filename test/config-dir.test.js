import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveConfigDir } from "../src/config-dir.js";

test("usa OPENCODE_CONFIG_DIR se definido", () => {
  const prev = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = "C:/custom/opencode";
  try {
    assert.equal(resolveConfigDir(null), "C:/custom/opencode");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prev;
  }
});

test("usa XDG_CONFIG_HOME/opencode se OPENCODE_CONFIG_DIR ausente", () => {
  const prevOcd = process.env.OPENCODE_CONFIG_DIR;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = "C:/xdg";
  try {
    assert.equal(resolveConfigDir(null), join("C:/xdg", "opencode"));
  } finally {
    if (prevOcd === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOcd;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("fallback para ~/.config/opencode", () => {
  const prevOcd = process.env.OPENCODE_CONFIG_DIR;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(resolveConfigDir(null).endsWith(".config" + "\\opencode") || resolveConfigDir(null).endsWith(".config/opencode"), true);
  } finally {
    if (prevOcd === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOcd;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("override explícito tem prioridade", () => {
  const prev = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = "C:/env";
  try {
    assert.equal(resolveConfigDir("C:/explicit"), "C:/explicit");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prev;
  }
});
