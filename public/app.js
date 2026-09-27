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
    const label = CLI_LABELS[key] ?? key;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.cli = key;
    // The name lives in a child span so a narrow layout can hide it visually
    // while leaving it in the accessibility tree, and the aria-label keeps the
    // token count announced even once the label is clipped away.
    const name = document.createElement("span");
    name.className = "chip-label";
    name.textContent = label;
    chip.append(name);
    chip.title = `${label}: ${numberFormat.format(clis[key])} tokens`;
    chip.setAttribute("aria-label", chip.title);
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
    cell(row, numberFormat.format(entry.requests), "col-num col-extra", "Requests");
    cell(row, numberFormat.format(entry.sessions), "col-num col-extra", "Sessions");
    cell(row, formatCost(entry.costUsd), "col-num col-cost", "Est. cost");
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

// Copy-to-clipboard for the install command. navigator.clipboard needs a secure
// context, which plain http on a LAN address is not, so fall back to a hidden
// textarea and execCommand rather than leaving the button silently dead.
const copyButton = document.querySelector("[data-copy]");
const installCommand = document.querySelector("[data-install]");
if (copyButton && installCommand) {
  copyButton.addEventListener("click", async () => {
    const text = installCommand.textContent.trim();
    const original = copyButton.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const scratch = document.createElement("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.append(scratch);
        scratch.select();
        const copied = document.execCommand("copy");
        scratch.remove();
        if (!copied) throw new Error("copy rejected");
      }
      copyButton.textContent = "Copied";
    } catch {
      copyButton.textContent = "Press ⌘C";
    }
    setTimeout(() => {
      copyButton.textContent = original;
    }, 1800);
  });
}
