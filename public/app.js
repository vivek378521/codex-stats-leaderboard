"use strict";

const CLI_LABELS = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
  hermes: "Hermes",
};

const rowsBody = document.querySelector("[data-rows]");
const statusLine = document.querySelector("[data-status]");
const emptyNote = document.querySelector("[data-empty]");
const countLine = document.querySelector("[data-count]");
const refreshButton = document.querySelector("[data-refresh]");
const totalEntries = document.querySelector("[data-total-entries]");
const totalTokens = document.querySelector("[data-total-tokens]");
const lastUpdated = document.querySelector("[data-last-updated]");

const numberFormat = new Intl.NumberFormat("en-US");

function formatTokens(value) {
  const tokens = Number(value) || 0;
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return numberFormat.format(tokens);
}

function formatCost(value) {
  const cost = Number(value) || 0;
  if (cost >= 100) {
    return `$${numberFormat.format(Math.round(cost))}`;
  }
  return `$${cost.toFixed(2)}`;
}

function relativeTime(isoString) {
  const then = Date.parse(isoString);
  if (Number.isNaN(then)) {
    return "—";
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function cell(row, text, className, label) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  // Read back as a label by the card layout on narrow screens.
  td.dataset.label = label;
  row.appendChild(td);
  return td;
}

function cliChips(clis) {
  const td = document.createElement("td");
  td.className = "col-clis";
  td.dataset.label = "CLIs";
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const keys = Object.keys(clis ?? {}).sort();
  if (keys.length === 0) {
    wrap.textContent = "—";
  }
  for (const key of keys) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.cli = key;
    chip.textContent = CLI_LABELS[key] ?? key;
    chip.title = `${numberFormat.format(clis[key])} tokens`;
    wrap.appendChild(chip);
  }
  td.appendChild(wrap);
  return td;
}

function render(entries, total) {
  rowsBody.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("tr");
    cell(row, `#${entry.rank}`, "col-rank", "Rank");
    cell(row, entry.username, "col-name", "Name");
    cell(row, formatTokens(entry.totalTokens), "col-num col-tokens", "Tokens");
    row.appendChild(cliChips(entry.clis));
    cell(row, numberFormat.format(entry.requests), "col-num", "Requests");
    cell(row, numberFormat.format(entry.sessions), "col-num", "Sessions");
    cell(row, formatCost(entry.costUsd), "col-num", "Est. cost");
    rowsBody.appendChild(row);
  }

  emptyNote.hidden = entries.length > 0;
  const shown = Math.min(entries.length, total);
  countLine.textContent = total > 0 ? `Showing ${shown} of ${total}` : "";
  totalEntries.textContent = numberFormat.format(total);
  totalTokens.textContent = formatTokens(entries.reduce((sum, entry) => sum + entry.totalTokens, 0));
  const newest = entries.reduce((latest, entry) => (entry.updatedAt > latest ? entry.updatedAt : latest), "");
  lastUpdated.textContent = newest ? relativeTime(newest) : "—";
}

async function load() {
  statusLine.textContent = "Loading…";
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/leaderboard?limit=100", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    render(payload.entries, payload.total);
    statusLine.textContent = "Live from every submission.";
  } catch (error) {
    statusLine.textContent = `Could not load: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", load);
load();
setInterval(load, 30000);
