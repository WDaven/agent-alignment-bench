import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS meta_no_update BEFORE UPDATE ON meta
BEGIN SELECT RAISE(ABORT, 'meta is write-once'); END;
CREATE TRIGGER IF NOT EXISTS meta_no_delete BEFORE DELETE ON meta
BEGIN SELECT RAISE(ABORT, 'meta is write-once'); END;

CREATE TABLE IF NOT EXISTS events (
  seq                    INTEGER PRIMARY KEY,
  event_id               TEXT    NOT NULL UNIQUE,
  episode_id             TEXT    NOT NULL,
  event_type             TEXT    NOT NULL,
  role                   TEXT    NOT NULL,
  occurred_at_virtual_ms INTEGER NOT NULL,
  json                   TEXT    NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_seq_gap_free BEFORE INSERT ON events
WHEN NEW.seq <> (SELECT COALESCE(MAX(seq), -1) + 1 FROM events)
BEGIN SELECT RAISE(ABORT, 'event seq must be gap-free'); END;
CREATE TRIGGER IF NOT EXISTS events_time_monotonic BEFORE INSERT ON events
WHEN NEW.occurred_at_virtual_ms < (SELECT COALESCE(MAX(occurred_at_virtual_ms), 0) FROM events)
BEGIN SELECT RAISE(ABORT, 'virtual time must not go backwards'); END;

CREATE TABLE IF NOT EXISTS projection (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  as_of_seq INTEGER NOT NULL,
  json      TEXT    NOT NULL
) STRICT;
`;

export interface JournalRow {
  seq: number;
  eventId: string;
  episodeId: string;
  eventType: string;
  role: string;
  occurredAtVirtualMs: number;
  json: string;
}

export class SqliteJournal {
  readonly db: DatabaseSync;
  private readonly insertStmt;
  private readonly projStmt;

  constructor(readonly path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      'INSERT INTO events (seq, event_id, episode_id, event_type, role, occurred_at_virtual_ms, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.projStmt = this.db.prepare(
      'INSERT INTO projection (id, as_of_seq, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET as_of_seq = excluded.as_of_seq, json = excluded.json',
    );
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  append(row: JournalRow, projectionJson: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertStmt.run(
        row.seq,
        row.eventId,
        row.episodeId,
        row.eventType,
        row.role,
        row.occurredAtVirtualMs,
        row.json,
      );
      this.projStmt.run(row.seq, projectionJson);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  rows(): JournalRow[] {
    return (
      this.db
        .prepare(
          'SELECT seq, event_id, episode_id, event_type, role, occurred_at_virtual_ms, json FROM events ORDER BY seq',
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      seq: Number(r.seq),
      eventId: String(r.event_id),
      episodeId: String(r.episode_id),
      eventType: String(r.event_type),
      role: String(r.role),
      occurredAtVirtualMs: Number(r.occurred_at_virtual_ms),
      json: String(r.json),
    }));
  }

  storedProjection(): { asOfSeq: number; json: string } | null {
    const r = this.db.prepare('SELECT as_of_seq, json FROM projection WHERE id = 1').get() as
      { as_of_seq: number; json: string } | undefined;
    return r ? { asOfSeq: Number(r.as_of_seq), json: r.json } : null;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
