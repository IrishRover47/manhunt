import pg from "pg";
const { Pool } = pg;

let _pool = null;

function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) return null;
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    _pool.on("error", (err) => console.error("[db] pool error:", err));
  }
  return _pool;
}

export async function initDb() {
  const db = getPool();
  if (!db) {
    console.log("[db] no DATABASE_URL — running in-memory only");
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code        TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_identities (
      token       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[db] schema ready");
}

// ── Room persistence ──────────────────────────────────────────────────────────

export async function saveRoom(room) {
  const db = getPool();
  if (!db) return;
  try {
    const data = serializeRoom(room);
    await db.query(
      `INSERT INTO rooms (code, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (code) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [room.code, JSON.stringify(data)]
    );
  } catch (err) {
    console.error("[db] saveRoom error:", err.message);
  }
}

export async function deleteRoom(code) {
  const db = getPool();
  if (!db) return;
  try {
    await db.query("DELETE FROM rooms WHERE code = $1", [code]);
  } catch (err) {
    console.error("[db] deleteRoom error:", err.message);
  }
}

export async function loadAllRooms() {
  const db = getPool();
  if (!db) return [];
  try {
    const result = await db.query(
      "SELECT data FROM rooms WHERE (data->>'status') != 'done' ORDER BY updated_at DESC"
    );
    const loaded = [];
    for (const row of result.rows) {
      try {
        loaded.push(deserializeRoom(row.data));
      } catch (err) {
        console.error("[db] deserialize error:", err.message);
      }
    }
    return loaded;
  } catch (err) {
    console.error("[db] loadAllRooms error:", err.message);
    return [];
  }
}

export async function loadRoomByCode(code) {
  const db = getPool();
  if (!db) return null;
  try {
    const result = await db.query("SELECT data FROM rooms WHERE code = $1", [code]);
    if (!result.rows.length) return null;
    return deserializeRoom(result.rows[0].data);
  } catch (err) {
    console.error("[db] loadRoomByCode error:", err.message);
    return null;
  }
}

// ── Player identity ───────────────────────────────────────────────────────────

export async function upsertPlayerIdentity(token, name) {
  const db = getPool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO player_identities (token, name, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (token) DO UPDATE SET name = $2, updated_at = NOW()`,
      [token, name]
    );
  } catch (err) {
    console.error("[db] upsertPlayerIdentity error:", err.message);
  }
}

export async function getPlayerIdentity(token) {
  const db = getPool();
  if (!db) return null;
  try {
    const result = await db.query(
      "SELECT name FROM player_identities WHERE token = $1",
      [token]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.error("[db] getPlayerIdentity error:", err.message);
    return null;
  }
}

// ── Serialization ─────────────────────────────────────────────────────────────
// Map objects (pendingPaths) and ephemeral fields (socketId, timer refs)
// need special handling.

export function serializeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    mapKey: room.mapKey,
    turnLimit: room.turnLimit,
    headStart: room.headStart,
    players: room.players.map((p) => ({ ...p, socketId: null })),
    pendingPaths: Object.fromEntries(room.pendingPaths),
    gameState: room.gameState ?? null,
    lastTurnResult: room.lastTurnResult ?? null,
  };
}

export function deserializeRoom(data) {
  return {
    code: data.code,
    status: data.status,
    mapKey: data.mapKey,
    turnLimit: data.turnLimit,
    headStart: data.headStart,
    players: (data.players ?? []).map((p) => ({ ...p, socketId: null })),
    pendingPaths: new Map(Object.entries(data.pendingPaths ?? {})),
    gameState: data.gameState ?? null,
    lastTurnResult: data.lastTurnResult ?? null,
    turnTimerRef: null,
    deleteTimerRef: null,
  };
}
