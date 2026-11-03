import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_POLL, OPTIONS_PER_VOTER, POLL_ID_PATTERN, PollStore } from "../src/store.js";

const P = FIRST_POLL.id;

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), "guildpolls-store-"));
  const store = new PollStore(join(dir, "poll.sqlite"));
  try {
    return run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = (state) => state.options.map((option) => option.name);

test("a fresh database starts with the guild-name poll", () => withStore((store) => {
  const polls = store.listPolls();
  assert.deepEqual(polls.map((poll) => [poll.id, poll.title]), [[FIRST_POLL.id, FIRST_POLL.title]]);
  assert.equal(store.state(P, "alice").poll.title, FIRST_POLL.title);
}));

test("the seed poll is created once, not again on every start", () => {
  const dir = mkdtempSync(join(tmpdir(), "guildpolls-seed-"));
  try {
    new PollStore(join(dir, "poll.sqlite")).close();
    const again = new PollStore(join(dir, "poll.sqlite"));
    assert.equal(again.listPolls().length, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new polls get a random URL-safe id and their own clean title", () => withStore((store) => {
  const id = store.createPoll("alice", "  Which   raid night? ");
  assert.match(id, POLL_ID_PATTERN);
  assert.equal(store.state(id, "bob").poll.title, "Which raid night?");
  assert.equal(store.listPolls()[0].id, id);
  assert.throws(() => store.createPoll("alice", "  "), { code: "name_required" });
  assert.throws(() => store.createPoll("alice", "x".repeat(81)), { code: "name_too_long" });
}));

test("approval voting: one voter can back several options, once each", () => withStore((store) => {
  const a = store.addOption(P, "alice", "Iron Wolves");
  const b = store.addOption(P, "alice", "Night Owls");
  store.vote(P, "alice", a);
  store.vote(P, "alice", b);
  store.vote(P, "alice", a);
  assert.deepEqual(store.state(P, "alice").options.map((option) => [option.name, option.votes, option.mine]), [
    ["Iron Wolves", 1, true],
    ["Night Owls", 1, true],
  ]);
}));

test("unvoting removes only that voter's vote", () => withStore((store) => {
  const a = store.addOption(P, "alice", "Iron Wolves");
  store.vote(P, "alice", a);
  store.vote(P, "bob", a);
  store.unvote(P, "alice", a);
  store.unvote(P, "alice", a);
  assert.equal(store.state(P, "alice").options[0].votes, 1);
  assert.equal(store.state(P, "alice").options[0].mine, false);
  assert.equal(store.state(P, "bob").options[0].mine, true);
}));

test("reset clears every vote from that voter in that poll only", () => withStore((store) => {
  const other = store.createPoll("alice", "Raid night");
  const a = store.addOption(P, "alice", "Iron Wolves");
  const b = store.addOption(P, "bob", "Night Owls");
  const c = store.addOption(other, "alice", "Tuesday");
  store.vote(P, "alice", a);
  store.vote(P, "alice", b);
  store.vote(P, "bob", a);
  store.vote(other, "alice", c);
  assert.equal(store.resetVotes(P, "alice"), 2);
  const state = store.state(P, "alice");
  assert.ok(state.options.every((option) => !option.mine));
  assert.equal(state.options.find((option) => option.id === a).votes, 1);
  assert.equal(store.state(other, "alice").options[0].mine, true);
}));

test("options are sorted by votes, ties by who was suggested first", () => withStore((store) => {
  const first = store.addOption(P, "alice", "First");
  const second = store.addOption(P, "alice", "Second");
  const third = store.addOption(P, "alice", "Third");
  store.vote(P, "bob", third);
  store.vote(P, "carol", third);
  store.vote(P, "bob", second);
  assert.deepEqual(names(store.state(P, "alice")), ["Third", "Second", "First"]);
  store.vote(P, "dave", first);
  assert.deepEqual(names(store.state(P, "alice")), ["Third", "First", "Second"]);
}));

test("each voter can add at most ten options per poll, and removing votes does not refund it", () => withStore((store) => {
  for (let i = 1; i <= OPTIONS_PER_VOTER; i += 1) {
    store.vote(P, "alice", store.addOption(P, "alice", `Guild ${i}`));
  }
  assert.deepEqual(store.state(P, "alice").you, { created: 10, limit: 10, remaining: 0 });
  assert.throws(() => store.addOption(P, "alice", "Guild 11"), { status: 429, code: "option_limit" });
  store.resetVotes(P, "alice");
  assert.throws(() => store.addOption(P, "alice", "Guild 11"), { status: 429, code: "option_limit" });
  assert.ok(store.addOption(P, "bob", "Guild 11") > 0);
  assert.equal(store.state(P, "bob").you.remaining, 9);
  const other = store.createPoll("alice", "Raid night");
  assert.ok(store.addOption(other, "alice", "Tuesday") > 0);
  assert.equal(store.state(other, "alice").you.remaining, 9);
}));

test("duplicates are rejected regardless of case and whitespace, within a poll", () => withStore((store) => {
  store.addOption(P, "alice", "Iron Wolves");
  for (const attempt of ["iron wolves", "IRONWOLVES", "  Iron   Wolves ", "iRoN wOlVeS"]) {
    assert.throws(() => store.addOption(P, "bob", attempt), { status: 409, code: "duplicate" });
  }
  assert.equal(store.state(P, "bob").you.created, 0);
  const other = store.createPoll("alice", "Mascot");
  assert.ok(store.addOption(other, "bob", "iron wolves") > 0);
}));

test("names are stored trimmed and collapsed; invalid names never count against the allowance", () => withStore((store) => {
  store.addOption(P, "alice", "   The   Gilded Gnomes ");
  assert.deepEqual(names(store.state(P, "alice")), ["The Gilded Gnomes"]);
  assert.throws(() => store.addOption(P, "alice", "   "), { code: "name_required" });
  assert.throws(() => store.addOption(P, "alice", "x".repeat(41)), { code: "name_too_long" });
  assert.equal(store.state(P, "alice").you.created, 1);
}));

test("unknown polls and options, or an option from another poll, are 404s", () => withStore((store) => {
  const other = store.createPoll("alice", "Raid night");
  const foreign = store.addOption(other, "alice", "Tuesday");
  assert.throws(() => store.state("nope-nope", "alice"), { status: 404, code: "unknown_poll" });
  assert.throws(() => store.addOption("nope-nope", "alice", "Name"), { status: 404 });
  assert.throws(() => store.vote(P, "alice", 999), { status: 404, code: "unknown_option" });
  assert.throws(() => store.vote(P, "alice", foreign), { status: 404, code: "unknown_option" });
  assert.throws(() => store.unvote(P, "alice", foreign), { status: 404 });
}));

test("the poll list summarises options, votes, voters and the leader", () => withStore((store) => {
  const a = store.addOption(P, "alice", "Iron Wolves");
  const b = store.addOption(P, "alice", "Night Owls");
  store.vote(P, "alice", a);
  store.vote(P, "bob", b);
  store.vote(P, "carol", b);
  const [poll] = store.listPolls();
  assert.deepEqual(
    { options: poll.options, votes: poll.votes, voters: poll.voters, leader: poll.leader, tiedAtTop: poll.tiedAtTop },
    { options: 2, votes: 3, voters: 3, leader: "Night Owls", tiedAtTop: 0 },
  );
  const empty = store.createPoll("alice", "Raid night");
  const emptySummary = store.listPolls().find((p) => p.id === empty);
  assert.deepEqual({ leader: emptySummary.leader, tiedAtTop: emptySummary.tiedAtTop, votes: emptySummary.votes }, {
    leader: null, tiedAtTop: 0, votes: 0,
  });
}));

test("the poll list names no leader when the top options are tied", () => withStore((store) => {
  const a = store.addOption(P, "alice", "Iron Wolves");
  const b = store.addOption(P, "alice", "Night Owls");
  store.addOption(P, "alice", "Gilded Gnomes");
  store.vote(P, "alice", a);
  store.vote(P, "bob", b);
  const [poll] = store.listPolls();
  assert.deepEqual({ leader: poll.leader, tiedAtTop: poll.tiedAtTop }, { leader: null, tiedAtTop: 2 });
}));

test("marks the options a voter added", () => withStore((store) => {
  store.addOption(P, "alice", "Iron Wolves");
  store.addOption(P, "bob", "Night Owls");
  const mine = store.state(P, "alice").options.filter((option) => option.addedByYou);
  assert.deepEqual(mine.map((option) => option.name), ["Iron Wolves"]);
}));

test("a backup is a complete, independent copy", () => withStore((store, dir) => {
  const id = store.addOption(P, "alice", "Iron Wolves");
  store.vote(P, "alice", id);
  const copyPath = join(dir, "backup.sqlite");
  store.backupTo(copyPath);
  store.resetVotes(P, "alice");
  const copy = new PollStore(copyPath);
  try {
    assert.deepEqual(copy.state(P, "alice").options.map((option) => [option.name, option.votes]), [["Iron Wolves", 1]]);
  } finally {
    copy.close();
  }
}));

test("polls, votes and options survive closing and reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "guildpolls-persist-"));
  const path = join(dir, "poll.sqlite");
  try {
    const first = new PollStore(path);
    const id = first.addOption(P, "alice", "Iron Wolves");
    first.vote(P, "alice", id);
    const raid = first.createPoll("alice", "Raid night");
    first.close();
    const second = new PollStore(path);
    const state = second.state(P, "alice");
    const polls = second.listPolls().map((poll) => poll.id);
    second.close();
    assert.deepEqual(state.options.map((option) => [option.name, option.votes, option.mine]), [["Iron Wolves", 1, true]]);
    assert.equal(state.you.created, 1);
    assert.deepEqual(polls.sort(), [P, raid].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
