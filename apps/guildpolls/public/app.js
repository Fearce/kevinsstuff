const POLL_MS = 4000;
const LIST_POLL_MS = 8000;
const RESET_CONFIRM_MS = 4000;
const POLL_PATH = /^\/p\/([a-z0-9-]{3,40})\/?$/;
const CHECK_SVG =
  '<svg viewBox="0 0 20 20" width="20" height="20"><path d="M5 10.5l3.2 3.2L15 6.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const $ = (id) => document.getElementById(id);
const els = {
  views: { home: $("home-view"), poll: $("poll-view"), missing: $("missing-view") },
  pollList: $("poll-list"),
  pollsSummary: $("polls-summary"),
  newPoll: $("new-poll"),
  newPollTitle: $("new-poll-title"),
  newPollPassword: $("new-poll-password"),
  newPollSubmit: document.querySelector("#new-poll button[type=submit]"),
  newPollMeta: $("new-poll-meta"),
  pollTitle: $("poll-title"),
  form: $("propose"),
  input: $("propose-name"),
  submit: document.querySelector("#propose button[type=submit]"),
  meta: $("propose-meta"),
  list: $("options"),
  empty: $("empty"),
  summary: $("results-summary"),
  reset: $("reset"),
  toast: $("toast"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const rows = new Map();
let view = null;
let pollId = null;
let state = null;
let etag = null;
let inFlight = 0;
let mutations = 0;
let refreshing = false;
let refreshTimer = null;
let offline = false;
let resetArmedUntil = 0;
let resetTimer = null;
let toastTimer = null;

async function api(method, path, body) {
  const init = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message ?? "Something went wrong. Try again.");
    error.code = data?.error;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function mutate(method, path, body) {
  inFlight += 1;
  mutations += 1;
  try {
    const next = await api(method, path, body);
    etag = null;
    applyState(next);
    return next;
  } finally {
    inFlight -= 1;
    mutations += 1;
  }
}

function pollApi(suffix = "") {
  return `/api/polls/${pollId}${suffix}`;
}

// Polling refreshes whichever view is open; a response that raced a vote is dropped so it can't undo it.
async function refresh() {
  clearTimeout(refreshTimer);
  if (document.hidden || refreshing || view === "missing") return;
  refreshing = true;
  const startedView = view;
  const startedPoll = pollId;
  const startedAt = mutations;
  try {
    const headers = { Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;
    const response = await fetch(view === "poll" ? pollApi() : "/api/polls", { headers });
    const current = view === startedView && pollId === startedPoll;
    if (response.status === 404 && current && view === "poll") {
      show("missing");
      return;
    }
    if (response.status === 200 && current && startedAt === mutations && inFlight === 0) {
      const next = await response.json();
      etag = response.headers.get("ETag");
      if (view === "poll") applyState(next);
      else renderPollList(next.polls);
    } else if (response.status !== 200 && response.status !== 304) {
      throw new Error(`HTTP ${response.status}`);
    }
    setOffline(false);
  } catch {
    setOffline(true);
  } finally {
    refreshing = false;
    const moved = view !== startedView || pollId !== startedPoll;
    const delay = moved ? 0 : view === "poll" ? POLL_MS : LIST_POLL_MS;
    if (view !== "missing") refreshTimer = setTimeout(refresh, delay);
  }
}

function route() {
  const match = POLL_PATH.exec(location.pathname);
  if (match) openPoll(match[1]);
  else openHome();
}

function navigate(path) {
  if (path !== location.pathname) history.pushState(null, "", path);
  route();
  window.scrollTo(0, 0);
}

function openHome() {
  pollId = null;
  show("home");
  document.title = "Guild polls";
  refresh();
}

function openPoll(id) {
  if (id !== pollId) {
    pollId = id;
    state = null;
    for (const row of rows.values()) row.li.remove();
    rows.clear();
    els.pollTitle.textContent = "";
    els.list.setAttribute("aria-busy", "true");
    els.empty.hidden = true;
    clearFormError();
    disarmReset();
  }
  show("poll");
  refresh();
}

function show(name) {
  view = name;
  etag = null;
  for (const [key, element] of Object.entries(els.views)) element.hidden = key !== name;
  if (name === "missing") document.title = "No such poll · Guild polls";
}

async function createPoll(event) {
  event.preventDefault();
  const title = els.newPollTitle.value;
  const password = els.newPollPassword.value;
  if (!title.trim()) return fieldError(els.newPollMeta, els.newPollTitle, "Give the poll a question first.");
  if (!password) return fieldError(els.newPollMeta, els.newPollPassword, "Enter the guild password.");
  els.newPollSubmit.disabled = true;
  try {
    const created = await api("POST", "/api/polls", { title, password });
    els.newPoll.reset();
    setMeta(els.newPollMeta, "Ask in guild chat for the password. It keeps strangers from spamming polls.", false);
    navigate(`/p/${created.poll.id}`);
    applyState(created);
    showToast("Poll created. Share the link, then add the first options.");
    els.input.focus();
  } catch (error) {
    fieldError(els.newPollMeta, error.code === "bad_password" ? els.newPollPassword : els.newPollTitle, error.message);
  } finally {
    els.newPollSubmit.disabled = false;
  }
}

async function toggleVote(id) {
  const option = state?.options.find((candidate) => candidate.id === id);
  if (!option || rows.get(id)?.pending) return;
  const voting = !option.mine;
  rows.get(id).pending = true;
  applyState(withVote(state, id, voting));
  try {
    await mutate(voting ? "PUT" : "DELETE", pollApi(`/options/${id}/vote`));
  } catch (error) {
    if (state) applyState(withVote(state, id, !voting));
    showToast(error.message);
  } finally {
    const row = rows.get(id);
    if (row) row.pending = false;
  }
}

async function propose(event) {
  event.preventDefault();
  const name = els.input.value;
  if (!name.trim()) return fieldError(els.meta, els.input, "Type an option first.");
  els.submit.disabled = true;
  try {
    const before = new Set(state?.options.map((option) => option.id));
    const next = await mutate("POST", pollApi("/options"), { name });
    els.input.value = "";
    const added = next.options.find((option) => !before.has(option.id));
    if (added) {
      flashRow(added.id);
      showToast(`Added “${added.name}”. Tap it to vote.`);
    }
  } catch (error) {
    setMeta(els.meta, error.message, true);
    if (error.code === "duplicate") highlightDuplicate(name);
  } finally {
    els.submit.disabled = state?.you.remaining === 0;
  }
}

async function resetVotes() {
  const mine = countMine(state);
  if (mine === 0) return;
  if (Date.now() > resetArmedUntil) {
    resetArmedUntil = Date.now() + RESET_CONFIRM_MS;
    els.reset.classList.add("is-armed");
    els.reset.textContent = `Tap again to clear ${plural(mine, "vote")}`;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
    return;
  }
  disarmReset();
  els.reset.disabled = true;
  try {
    await mutate("DELETE", pollApi("/votes"));
    showToast("Your votes in this poll are cleared.");
  } catch (error) {
    showToast(error.message);
  } finally {
    renderReset();
  }
}

function disarmReset() {
  resetArmedUntil = 0;
  clearTimeout(resetTimer);
  els.reset.classList.remove("is-armed");
  els.reset.textContent = "Reset my votes";
}

function withVote(current, id, voting) {
  const options = current.options.map((option) =>
    option.id === id && option.mine !== voting
      ? { ...option, mine: voting, votes: option.votes + (voting ? 1 : -1) }
      : option,
  );
  return { ...current, options: options.sort((a, b) => b.votes - a.votes || a.id - b.id) };
}

function countMine(current) {
  return current ? current.options.filter((option) => option.mine).length : 0;
}

function applyState(next) {
  if (next.poll.id !== pollId) return;
  state = next;
  render();
}

function render() {
  const before = measureRows();
  renderOptions();
  animateReorder(before);
  els.pollTitle.textContent = state.poll.title;
  document.title = `${state.poll.title} · Guild polls`;
  renderSummary();
  renderForm();
  renderReset();
  els.list.setAttribute("aria-busy", "false");
}

function renderPollList(polls) {
  els.pollList.replaceChildren(...polls.map(pollListItem));
  els.pollsSummary.textContent = plural(polls.length, "poll");
  els.pollList.setAttribute("aria-busy", "false");
}

function pollListItem(poll) {
  const li = el("li", "poll-item");
  const link = el("a", "poll-link");
  link.href = `/p/${poll.id}`;
  link.dataset.nav = "";
  const title = el("span", "poll-title");
  title.textContent = poll.title;
  const meta = el("span", "poll-meta");
  meta.textContent = pollSummary(poll);
  const arrow = el("span", "poll-arrow");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  link.append(title, meta, arrow);
  li.append(link);
  return li;
}

function pollSummary(poll) {
  if (poll.options === 0) return "No options yet";
  const parts = [plural(poll.options, "option"), poll.voters === 0 ? "no votes yet" : `${plural(poll.voters, "voter")}`];
  if (poll.leader) parts.push(`leading: ${poll.leader}`);
  else if (poll.tiedAtTop > 1) parts.push(`${poll.tiedAtTop}-way tie at the top`);
  return parts.join(" · ");
}

function renderOptions() {
  const { options } = state;
  const top = Math.max(1, ...options.map((option) => option.votes));
  const seen = new Set();
  let rank = 0;
  let previousVotes = null;
  options.forEach((option, index) => {
    if (option.votes !== previousVotes) rank = index + 1;
    previousVotes = option.votes;
    const row = rows.get(option.id) ?? createRow(option.id);
    updateRow(row, option, option.votes > 0 ? rank : null, option.votes / top);
    els.list.append(row.li);
    seen.add(option.id);
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.li.remove();
      rows.delete(id);
    }
  }
  els.empty.hidden = options.length > 0;
}

function createRow(id) {
  const li = el("li", "option");
  const button = el("button", "option-button");
  button.type = "button";
  button.addEventListener("click", () => toggleVote(id));
  const rank = el("span", "option-rank");
  const body = el("span", "option-body");
  const name = el("span", "option-name");
  const tag = el("span", "option-tag");
  tag.textContent = "your idea";
  const bar = el("span", "option-bar");
  const fill = el("span", "option-fill");
  bar.append(fill);
  body.append(name, tag, bar);
  const count = el("span", "option-count");
  const countNumber = el("span", "count-number");
  const countLabel = el("span", "count-label");
  count.append(countNumber, countLabel);
  const mark = el("span", "option-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = CHECK_SVG;
  button.append(rank, body, count, mark);
  li.append(button);
  const row = { li, button, rank, name, tag, fill, countNumber, countLabel, pending: false };
  rows.set(id, row);
  return row;
}

function updateRow(row, option, rank, share) {
  row.li.classList.toggle("is-mine", option.mine);
  row.button.setAttribute("aria-pressed", String(option.mine));
  row.button.setAttribute(
    "aria-label",
    `${option.name}, ${plural(option.votes, "vote")}${option.mine ? ", you voted for this" : ""}`,
  );
  row.rank.textContent = rank === null ? "" : String(rank);
  row.name.textContent = option.name;
  row.tag.hidden = !option.addedByYou;
  row.fill.style.setProperty("--share", share.toFixed(4));
  row.countNumber.textContent = String(option.votes);
  row.countLabel.textContent = option.votes === 1 ? "vote" : "votes";
}

function renderSummary() {
  const count = state.options.length;
  els.summary.textContent = count === 0 ? "" : `${plural(count, "option")} · you back ${countMine(state)}`;
}

function renderForm() {
  const { remaining, limit } = state.you;
  const full = remaining === 0;
  els.input.disabled = full;
  els.submit.disabled = full;
  if (els.meta.classList.contains("is-error")) return;
  els.meta.textContent = full
    ? `You've added ${limit} options here, the most one connection can add.`
    : `You can add ${plural(remaining, "more option")}.`;
}

function renderReset() {
  const mine = countMine(state);
  els.reset.disabled = mine === 0;
  if (mine === 0) disarmReset();
}

function setMeta(meta, message, isError) {
  meta.textContent = message;
  meta.classList.toggle("is-error", isError);
}

function fieldError(meta, input, message) {
  setMeta(meta, message, true);
  input.focus();
}

function clearFormError() {
  if (!els.meta.classList.contains("is-error")) return;
  els.meta.classList.remove("is-error");
  if (state) renderForm();
}

function highlightDuplicate(name) {
  const key = name.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const match = state?.options.find((option) => option.name.toLowerCase().replace(/\s+/gu, "") === key);
  if (match) flashRow(match.id);
}

function flashRow(id) {
  const row = rows.get(id);
  if (!row) return;
  row.li.classList.remove("is-flash");
  void row.li.offsetWidth;
  row.li.classList.add("is-flash");
  row.li.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (!offline) els.toast.hidden = true;
  }, 3200);
}

function setOffline(isOffline) {
  if (isOffline === offline) return;
  offline = isOffline;
  if (isOffline) {
    els.toast.textContent = "Can't reach the polls right now. Retrying…";
    els.toast.hidden = false;
  } else {
    els.toast.hidden = true;
  }
}

// FLIP: rows jump to their new place in the DOM, then glide there from where they were.
function measureRows() {
  if (reducedMotion.matches) return null;
  const positions = new Map();
  for (const [id, row] of rows) positions.set(id, row.li.getBoundingClientRect().top);
  return positions;
}

function animateReorder(before) {
  if (!before) return;
  for (const [id, row] of rows) {
    const from = before.get(id);
    if (from === undefined) continue;
    const delta = from - row.li.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    row.li.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
      { duration: 280, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-nav]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(new URL(link.href).pathname);
});
window.addEventListener("popstate", route);
els.newPoll.addEventListener("submit", createPoll);
els.newPollTitle.addEventListener("input", () => els.newPollMeta.classList.remove("is-error"));
els.newPollPassword.addEventListener("input", () => els.newPollMeta.classList.remove("is-error"));
els.form.addEventListener("submit", propose);
els.input.addEventListener("input", clearFormError);
els.reset.addEventListener("click", resetVotes);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
route();
