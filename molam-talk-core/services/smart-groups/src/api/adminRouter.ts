/**
 * Admin Router
 * FR: Endpoints admin pour gerer candidates et replay outbox
 */
import express from "express";
import db from "../lib/db";
import { autoGroupsCounter, candidatesGauge } from "../lib/metrics";
import { authorize } from "../lib/opa";
import { writeAudit } from "../lib/audit";
import { ensureCanonicalTalkGroupForSmartGroup } from "../lib/talkGroupRuntime";

const router = express.Router();

/**
 * POST /api/v1/admin/candidates/:id/accept
 * Accepter un candidat et creer le groupe discovery + runtime
 */
router.post("/candidates/:id/accept", async (req: any, res) => {
  const id = req.params.id;
  const admin = req.user;

  const allowed = await authorize("talk:groups:admin", admin, {
    action: "candidate.accept",
    candidate_id: id
  });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const c = (
      await client.query(
        `SELECT *
         FROM group_candidates
         WHERE id = $1
         FOR UPDATE`,
        [id]
      )
    ).rows[0];

    if (!c) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    if (c.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "invalid_status" });
    }

    const topic = (
      await client.query(
        `SELECT *
         FROM group_topics
         WHERE id = $1`,
        [c.topic_id]
      )
    ).rows[0];

    const payload = c.payload;
    const name = `Topic: ${topic.keyword}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

    const g = (
      await client.query(
        `INSERT INTO smart_groups (
           name,
           slug,
           description,
           type,
           topic_id,
           owner_id,
           legal_entity,
           locale,
           fatima_score,
           fatima_explanation,
           metadata
         )
         VALUES ($1,$2,$3,'public',$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          name,
          slug,
          payload.description || `Discussion sur ${topic.keyword}`,
          topic.id,
          admin.id,
          admin.legal_entity || "global",
          payload.locale || admin.locale,
          payload.fatima_score || null,
          JSON.stringify({ explanation: payload.explanation || "admin_accept" }),
          payload
        ]
      )
    ).rows[0];

    const runtime = await ensureCanonicalTalkGroupForSmartGroup(client, g);

    const materialized = (
      await client.query(
        `SELECT *
         FROM smart_groups
         WHERE id = $1`,
        [g.id]
      )
    ).rows[0];

    await client.query(
      `UPDATE group_candidates
       SET status = 'accepted'
       WHERE id = $1`,
      [id]
    );

    const ev = `group.created.admin.${Date.now()}.${Math.random().toString(36).slice(2, 4)}`;

    await client.query(
      `INSERT INTO smart_groups_outbox (event_id, aggregate_type, aggregate_id, type, payload)
       VALUES ($1,'group',$2,'group.created.admin',$3)`,
      [
        ev,
        materialized.id,
        {
          ...materialized,
          talk_group_id: runtime.talkGroupId,
          conversation_id: runtime.conversationId,
        }
      ]
    );

    const candidateEv = `group.candidate.accepted.${Date.now()}.${Math.random().toString(36).slice(2, 4)}`;
    await client.query(
      `INSERT INTO smart_groups_outbox (event_id, aggregate_type, aggregate_id, type, payload)
       VALUES ($1,'candidate',$2,'group.candidate.accepted',$3)`,
      [
        candidateEv,
        id,
        {
          candidate_id: id,
          topic_id: topic.id,
          smart_group_id: materialized.id,
          talk_group_id: runtime.talkGroupId,
          conversation_id: runtime.conversationId,
          admin_id: admin.id
        }
      ]
    );

    await writeAudit({
      client,
      action: "group.candidate.accepted",
      actorId: admin.id,
      targetType: "candidate",
      targetId: id,
      legalEntity: admin.legal_entity || "global",
      payload: {
        smart_group_id: materialized.id,
        talk_group_id: runtime.talkGroupId,
        conversation_id: runtime.conversationId,
        topic_id: topic.id
      }
    });

    await client.query("COMMIT");

    autoGroupsCounter.inc({ locale: materialized.locale, legal_entity: materialized.legal_entity });

    return res.json({
      ...materialized,
      talk_group_id: runtime.talkGroupId,
      conversation_id: runtime.conversationId,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("[Admin] Accept candidate error", e);
    return res.status(500).json({ error: "accept_failed" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/v1/admin/candidates/:id/reject
 * Rejeter un candidat
 */
router.post("/candidates/:id/reject", async (req: any, res) => {
  const id = req.params.id;
  const admin = req.user;

  const allowed = await authorize("talk:groups:admin", admin, {
    action: "candidate.reject",
    candidate_id: id
  });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE group_candidates SET status='rejected' WHERE id=$1", [id]);

    const ev = `group.candidate.rejected.${Date.now()}.${Math.random().toString(36).slice(2, 4)}`;
    await client.query(
      `INSERT INTO smart_groups_outbox (event_id, aggregate_type, aggregate_id, type, payload)
       VALUES ($1,'candidate',$2,'group.candidate.rejected',$3)`,
      [ev, id, { candidate_id: id, admin_id: admin.id }]
    );

    await writeAudit({
      client,
      action: "group.candidate.rejected",
      actorId: admin.id,
      targetType: "candidate",
      targetId: id,
      legalEntity: admin.legal_entity || "global"
    });

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("[Admin] Reject candidate error", err);
    return res.status(500).json({ error: "reject_failed" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/admin/candidates
 * Lister les candidats en attente
 */
router.get("/candidates", async (req: any, res) => {
  const admin = req.user;
  const { status = "pending", limit = 50 } = req.query;

  const allowed = await authorize("talk:groups:admin", admin, {
    action: "candidates.list",
    status
  });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const r = await db.query(
      `SELECT c.*, t.keyword, t.fatima_score
       FROM group_candidates c
       JOIN group_topics t ON c.topic_id = t.id
       WHERE c.status = $1
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [status, limit]
    );

    if (status === "pending") {
      candidatesGauge.set(r.rowCount || 0);
    }

    return res.json({ candidates: r.rows, count: r.rowCount });
  } catch (err: any) {
    console.error("[Admin] List candidates error", err);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * GET /api/v1/admin/groups
 * Lister les groupes discovery (avec bridge runtime)
 */
router.get("/groups", async (req: any, res) => {
  const admin = req.user;
  const allowed = await authorize("talk:groups:admin", admin, { action: "groups.list" });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const r = await db.query("SELECT * FROM smart_groups ORDER BY created_at DESC LIMIT 50");
    return res.json({ groups: r.rows, count: r.rowCount });
  } catch (err: any) {
    console.error("[Admin] List groups error", err);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * POST /api/v1/admin/replay
 * Rejouer les evenements outbox non traites
 */
router.post("/replay", async (req: any, res) => {
  const admin = req.user;
  const allowed = await authorize("talk:groups:admin", admin, { action: "outbox.replay" });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const r = await db.query("SELECT * FROM smart_groups_outbox WHERE processed=false");

    await writeAudit({
      action: "outbox.replay",
      actorId: admin.id,
      targetType: "outbox",
      targetId: null,
      legalEntity: admin.legal_entity || "global",
      payload: { count: r.rows.length }
    });

    return res.json({ replayed: r.rows.length, events: r.rows });
  } catch (err: any) {
    console.error("[Admin] Replay error", err);
    return res.status(500).json({ error: "replay_failed" });
  }
});

/**
 * GET /api/v1/admin/stats
 * Statistiques globales
 */
router.get("/stats", async (req: any, res) => {
  const admin = req.user;
  const allowed = await authorize("talk:groups:admin", admin, { action: "stats.read" });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const [groups, candidates, topics, outbox] = await Promise.all([
      db.query("SELECT COUNT(*) FROM smart_groups"),
      db.query("SELECT status, COUNT(*) FROM group_candidates GROUP BY status"),
      db.query("SELECT COUNT(*) FROM group_topics"),
      db.query("SELECT COUNT(*) FROM smart_groups_outbox WHERE processed=false")
    ]);

    return res.json({
      total_groups: Number(groups.rows[0].count),
      candidates_by_status: candidates.rows,
      total_topics: Number(topics.rows[0].count),
      unprocessed_outbox: Number(outbox.rows[0].count)
    });
  } catch (err: any) {
    console.error("[Admin] Stats error", err);
    return res.status(500).json({ error: "stats_failed" });
  }
});

export default router;
