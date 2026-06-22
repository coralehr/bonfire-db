#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const statePath = path.join(root, "docs/loop/STATE.md");

function usage() {
  console.error(`usage:
  ledger.mjs list
  ledger.mjs add --key KEY --source SOURCE --sev high|med|low --title TITLE --action ACTION
  ledger.mjs status --key KEY --status STATUS
`);
  process.exit(2);
}

function readState() {
  return fs.readFileSync(statePath, "utf8");
}

function writeState(content) {
  fs.writeFileSync(statePath, content);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    out[key.slice(2)] = value;
  }
  return out;
}

function cell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function add(flags) {
  for (const key of ["key", "source", "sev", "title", "action"]) {
    if (!flags[key]) usage();
  }
  if (!["high", "med", "low"].includes(flags.sev)) {
    console.error("ledger: --sev must be high, med, or low");
    process.exit(2);
  }

  const state = readState();
  if (state.includes(`| ${flags.key} |`)) {
    console.error(`ledger: key already exists: ${flags.key}`);
    process.exit(1);
  }

  const marker = "<!-- Append new findings above this line.";
  const row = `| ${today()} | ${cell(flags.key)} | ${cell(flags.source)} | ${cell(flags.sev)} | ${cell(flags.title)} | ${cell(flags.action)} | NEW |\n`;
  if (!state.includes(marker)) {
    console.error("ledger: inbox marker not found");
    process.exit(1);
  }
  writeState(state.replace(marker, row + "\n" + marker));
  console.log(`ledger: added ${flags.key}`);
}

function status(flags) {
  if (!flags.key || !flags.status) usage();
  const state = readState();
  const lines = state.split("\n");
  let changed = false;
  const next = lines.map((line) => {
    if (!line.includes(`| ${flags.key} |`)) return line;
    const parts = line.split("|");
    if (parts.length < 8) return line;
    parts[7] = ` ${cell(flags.status)} `;
    changed = true;
    return parts.join("|");
  });
  if (!changed) {
    console.error(`ledger: key not found: ${flags.key}`);
    process.exit(1);
  }
  writeState(next.join("\n"));
  console.log(`ledger: ${flags.key} -> ${flags.status}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "list") {
  console.log(readState());
} else if (cmd === "add") {
  add(parseFlags(rest));
} else if (cmd === "status") {
  status(parseFlags(rest));
} else {
  usage();
}
