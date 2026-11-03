import { randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cleanName, cleanTitle, nameKey } from "./names.js";

export const OPTIONS_PER_VOTER = 10;
export const FIRST_POLL = { id: "guild-name", title: "What should we call the guild?" };

const POLL_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const POLL_ID_LENGTH = 8;
export const POLL_ID_PATTERN = /^[a-z0-9-]{3,40}$/;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS polls (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL,
    creator    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS options (
    id         INTEGER PRIMARY KEY,
    poll_id    TEXT    NOT NULL REFERENCES polls (id),
    name       TEXT    NOT NULL,
    name_key   TEXT    NOT NULL,
    creator    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (poll_id, name_key)
  );
  CREATE INDEX IF NOT EXISTS options_poll_creator ON options (poll_id, creator);
  CREATE TABLE IF NOT EXISTS votes (
    option_id  INTEGER NOT NULL REFERENCES options (id),
    voter      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (option_id, voter)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS votes_voter ON votes (voter);
`;

export class PollError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * All poll rules live here so every entry point obeys them. `voter` is always the salted hash of the
 * client's address, never the address itself. Polls and options are never deleted, so the number of
 * options a voter has added to a poll is a lifetime count and removing votes cannot refund it.
 * Who may create a poll at all (the password) is the HTTP layer's decision.
 */
export class PollStore {
  #db;
  #now;
  #sql;

  constructor(path, { now = Date.now } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.#db.exec(SCHEMA);
    this.#now = now;
    this.#sql = this.#prepare();
    this.#seedFirstPoll();
  }

  close() {
    this.#db.close();
  }

  /** Writes a consistent, compacted copy of the live database to `path` (which must not exist). */
  backupTo(path) {
    this.#db.prepare("VACUUM INTO ?").run(path);
  }

  listPolls() {
    return this.#sql.polls.all().map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      options: row.options,
      votes: row.votes,
      voters: row.voters,
      ...leadership(row),
    }));
  }

  createPoll(creator, rawTitle) {
    const title = cleanTitle(rawTitle);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomPollId();
      if (this.#sql.pollExists.get(id)) continue;
      this.#sql.insertPoll.run(id, title, creator, this.#now());
      return id;
    }
    throw new Error("Could not find a free poll id");
  }

  state(pollId, voter) {
    const poll = this.#requirePoll(pollId);
    const options = this.#sql.options.all(pollId, voter).map((row) => ({
      id: row.id,
      name: row.name,
      votes: row.votes,
      mine: row.mine === 1,
      addedByYou: row.added_by_you === 1,
    }));
    const created = this.#sql.createdBy.get(pollId, voter).count;
    return {
      poll: { id: poll.id, title: poll.title, createdAt: poll.created_at },
      options,
      you: { created, limit: OPTIONS_PER_VOTER, remaining: Math.max(0, OPTIONS_PER_VOTER - created) },
    };
  }

  addOption(pollId, voter, rawName) {
    this.#requirePoll(pollId);
    const name = cleanName(rawName);
    const key = nameKey(name);
    return this.#transaction(() => {
      if (this.#sql.createdBy.get(pollId, voter).count >= OPTIONS_PER_VOTER) {
        throw new PollError(429, "option_limit", `You've already added ${OPTIONS_PER_VOTER} options to this poll, the most one connection can add.`);
      }
      const existing = this.#sql.byKey.get(pollId, key);
      if (existing) throw new PollError(409, "duplicate", `“${existing.name}” is already on the list.`);
      const { lastInsertRowid } = this.#sql.insertOption.run(pollId, name, key, voter, this.#now());
      return Number(lastInsertRowid);
    });
  }

  vote(pollId, voter, optionId) {
    this.#requireOption(pollId, optionId);
    this.#sql.insertVote.run(optionId, voter, this.#now());
  }

  unvote(pollId, voter, optionId) {
    this.#requireOption(pollId, optionId);
    this.#sql.deleteVote.run(optionId, voter);
  }

  resetVotes(pollId, voter) {
    this.#requirePoll(pollId);
    return Number(this.#sql.deleteVotesBy.run(voter, pollId).changes);
  }

  #requirePoll(pollId) {
    const poll = typeof pollId === "string" ? this.#sql.poll.get(pollId) : undefined;
    if (!poll) throw new PollError(404, "unknown_poll", "That poll doesn't exist.");
    return poll;
  }

  #requireOption(pollId, optionId) {
    this.#requirePoll(pollId);
    if (!Number.isSafeInteger(optionId) || !this.#sql.optionInPoll.get(optionId, pollId)) {
      throw new PollError(404, "unknown_option", "That option isn't on this poll.");
    }
  }

  #seedFirstPoll() {
    if (this.#sql.pollCount.get().count > 0) return;
    this.#sql.insertPoll.run(FIRST_POLL.id, FIRST_POLL.title, "seed", this.#now());
  }

  #transaction(work) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #prepare() {
    const db = this.#db;
    return {
      polls: db.prepare(`
        WITH tally AS (
          SELECT o.poll_id, o.id, o.name, COUNT(v.voter) AS votes
          FROM options o LEFT JOIN votes v ON v.option_id = o.id
          GROUP BY o.id
        ),
        tops AS (SELECT poll_id, MAX(votes) AS top FROM tally GROUP BY poll_id)
        SELECT p.id, p.title, p.created_at,
               (SELECT COUNT(*) FROM tally t WHERE t.poll_id = p.id) AS options,
               (SELECT COALESCE(SUM(t.votes), 0) FROM tally t WHERE t.poll_id = p.id) AS votes,
               (SELECT COUNT(DISTINCT v.voter) FROM votes v JOIN options o ON o.id = v.option_id WHERE o.poll_id = p.id) AS voters,
               COALESCE(tops.top, 0) AS top_votes,
               (SELECT COUNT(*) FROM tally t WHERE t.poll_id = p.id AND t.votes = tops.top) AS top_count,
               (SELECT t.name FROM tally t WHERE t.poll_id = p.id AND t.votes = tops.top ORDER BY t.id LIMIT 1) AS top_name
        FROM polls p LEFT JOIN tops ON tops.poll_id = p.id
        ORDER BY p.created_at DESC, p.rowid DESC`),
      poll: db.prepare("SELECT id, title, created_at FROM polls WHERE id = ?"),
      pollExists: db.prepare("SELECT 1 FROM polls WHERE id = ?"),
      pollCount: db.prepare("SELECT COUNT(*) AS count FROM polls"),
      insertPoll: db.prepare("INSERT INTO polls (id, title, creator, created_at) VALUES (?, ?, ?, ?)"),
      options: db.prepare(`
        SELECT o.id, o.name,
               (SELECT COUNT(*) FROM votes v WHERE v.option_id = o.id) AS votes,
               EXISTS (SELECT 1 FROM votes v WHERE v.option_id = o.id AND v.voter = ?2) AS mine,
               o.creator = ?2 AS added_by_you
        FROM options o
        WHERE o.poll_id = ?1
        ORDER BY votes DESC, o.id ASC`),
      createdBy: db.prepare("SELECT COUNT(*) AS count FROM options WHERE poll_id = ? AND creator = ?"),
      byKey: db.prepare("SELECT name FROM options WHERE poll_id = ? AND name_key = ?"),
      insertOption: db.prepare("INSERT INTO options (poll_id, name, name_key, creator, created_at) VALUES (?, ?, ?, ?, ?)"),
      optionInPoll: db.prepare("SELECT 1 FROM options WHERE id = ? AND poll_id = ?"),
      insertVote: db.prepare("INSERT OR IGNORE INTO votes (option_id, voter, created_at) VALUES (?, ?, ?)"),
      deleteVote: db.prepare("DELETE FROM votes WHERE option_id = ? AND voter = ?"),
      deleteVotesBy: db.prepare("DELETE FROM votes WHERE voter = ? AND option_id IN (SELECT id FROM options WHERE poll_id = ?)"),
    };
  }
}

function leadership({ top_votes: top, top_count: count, top_name: name }) {
  if (top === 0) return { leader: null, tiedAtTop: 0 };
  return count === 1 ? { leader: name, tiedAtTop: 0 } : { leader: null, tiedAtTop: count };
}

function randomPollId() {
  let id = "";
  for (let i = 0; i < POLL_ID_LENGTH; i += 1) id += POLL_ID_ALPHABET[randomInt(POLL_ID_ALPHABET.length)];
  return id;
}
