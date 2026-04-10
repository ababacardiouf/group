/**
 * Groups Router
 * FR: API endpoints pour creation manuelle et auto de groupes intelligents
 */
import express from "express";
import db from "../lib/db";
import { fetchTrending, explainTopic } from "../lib/fatimaClient";
import { producer, ensureProducer } from "../lib/kafka";
import { autoGroupsCounter, groupCreateLatency, groupCreatedCounter } from "../lib/metrics";
import { authorize } from "../lib/opa";
import { writeAudit } from "../lib/audit";
import { getFatimaThresholds, shouldAutoCreate, shouldCreateCandidate } from "../lib/thresholds";
import { ensureCanonicalTalkGroupForSmartGroup } from "../lib/talkGroupRuntime";

const router = express.Router();

/**
 * POST /api/v1/groups
 * Creation manuelle de groupe discovery + materialisation runtime
 */
router.post("/", async (req: any, res) => {
  const t0 = Date.now();
  const user = req.user;
  const { name, description, type, topicId, locale, legal_entity } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const allowed = await authorize("talk:groups:create", user, {
    type,
    legal_entity: legal_entity || user?.legal_entity
  });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

    const insert = await client.query(
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        name,
        slug,
        description || null,
        type,
        topicId || null,
        user.id,
        legal_entity || user.legal_entity || "global",
        locale || user.locale || "en",
        null,
        {},
        {}
      ]
    );

    const smartGroup = insert.rows[0];

    const runtime = await ensureCanonicalTalkGroupForSmartGroup(client, smartGroup);

    const materialized = (
      await client.query(
        `SELECT *
         FROM smart_groups
         WHERE id = $1`,
        [smartGroup.id]
      )
    ).rows[0];

    const ev = `group.created.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    await client.query(
      `INSERT INTO smart_groups_outbox (event_id, aggregate_type, aggregate_id, type, payload)
       VALUES ($1,'group',$2,'group.created',$3)`,
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

    await writeAudit({
      client,
      action: "group.created",
      actorId: user.id,
      targetType: "group",
      targetId: materialized.id,
      legalEntity: materialized.legal_entity,
      payload: {
        source: "manual",
        type,
        topic_id: materialized.topic_id,
        talk_group_id: runtime.talkGroupId,
        conversation_id: runtime.conversationId,
      }
    });

    await client.query("COMMIT");

    try {
      await ensureProducer();
      await producer.send({
        topic: "molam.groups.events",
        messages: [
          {
            key: materialized.id,
            value: JSON.stringify({
              type: "group.created",
              data: {
                ...materialized,
                talk_group_id: runtime.talkGroupId,
                conversation_id: runtime.conversationId,
              }
            })
          }
        ]
      });
    } catch (e: any) {
      console.error("[Groups] Kafka publish failed", e.message);
    }

    groupCreateLatency.observe((Date.now() - t0) / 1000);
    groupCreatedCounter.inc({ type, source: "manual" });

    return res.status(201).json({
      ...materialized,
      talk_group_id: runtime.talkGroupId,
      conversation_id: runtime.conversationId,
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("[Groups] Create group error", err);
    return res.status(500).json({ error: "create_failed" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/v1/groups/auto/generate
 * Auto-generation de groupes bases sur trending FATIMA
 */
router.post("/auto/generate", async (req: any, res) => {
  const user = req.user;
  const { region, locale, limit } = req.body;

  const allowed = await authorize("talk:groups:auto_generate", user, {
    region,
    locale: locale || user?.locale
  });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  const thresholds = getFatimaThresholds();
  const items = await fetchTrending(locale || user.locale, region, limit || 5);
  const created: any[] = [];
  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    for (const it of items) {
      const score = Number(it.fatima_score || 0);
      if (!shouldCreateCandidate(score)) {
        continue;
      }

      const existing = (
        await client.query(
          `SELECT id
           FROM group_topics
           WHERE keyword = $1 AND locale = $2
           LIMIT 1`,
          [it.keyword, locale || user.locale]
        )
      ).rows[0];

      let topicId = existing?.id;

      if (!topicId) {
        const t = (
          await client.query(
            `INSERT INTO group_topics (keyword, fatima_score, locale, canonical_slug, metadata)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING *`,
            [
              it.keyword,
              it.fatima_score || 0,
              locale || user.locale,
              it.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              it
            ]
          )
        ).rows[0];
        topicId = t.id;
      }

      const existingCandidate = (
        await client.query(
          `SELECT id
           FROM group_candidates
           WHERE topic_id = $1
             AND status IN ('pending','accepted')
           LIMIT 1`,
          [topicId]
        )
      ).rows[0];

      if (!existingCandidate) {
        await client.query(
          `INSERT INTO group_candidates (topic_id, payload, status)
           VALUES ($1,$2,'pending')`,
          [topicId, it]
        );
      }

      if (shouldAutoCreate(score)) {
        const existingGroup = (
          await client.query(
            `SELECT id, talk_group_id
             FROM smart_groups
             WHERE topic_id = $1 AND locale = $2
             LIMIT 1`,
            [topicId, locale || user.locale]
          )
        ).rows[0];

        if (!existingGroup) {
          const name = `Topic: ${it.keyword}`;
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
                `Discussion automatique sur ${it.keyword}`,
                topicId,
                user.id,
                user.legal_entity || "global",
                locale || user.locale,
                it.fatima_score || 0,
                JSON.stringify({ explanation: it.explanation || "auto" }),
                it
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

          const ev = `group.created.auto.${Date.now()}.${Math.random().toString(36).slice(2, 4)}`;

          await client.query(
            `INSERT INTO smart_groups_outbox (event_id, aggregate_type, aggregate_id, type, payload)
             VALUES ($1,'group',$2,'group.created.auto',$3)`,
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

          await writeAudit({
            client,
            action: "group.created.auto",
            actorId: user.id,
            targetType: "group",
            targetId: materialized.id,
            legalEntity: materialized.legal_entity,
            payload: {
              source: "auto",
              score: it.fatima_score || 0,
              topic_id: topicId,
              talk_group_id: runtime.talkGroupId,
              conversation_id: runtime.conversationId,
            }
          });

          created.push({
            ...materialized,
            talk_group_id: runtime.talkGroupId,
            conversation_id: runtime.conversationId,
          });

          autoGroupsCounter.inc({ locale: materialized.locale, legal_entity: materialized.legal_entity });
          groupCreatedCounter.inc({ type: "public", source: "auto" });
        }
      }
    }

    await client.query("COMMIT");
    return res.json({
      created,
      pending: items.length - created.length,
      thresholds
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("[Groups] Auto generate failed", e);
    return res.status(500).json({ error: "auto_failed" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/groups/:groupId/explain
 * Expliquer pourquoi un groupe a ete suggere
 */
router.get("/:groupId/explain", async (req: any, res) => {
  const gid = req.params.groupId;
  const user = req.user;

  const allowed = await authorize("talk:groups:explain", user, { group_id: gid });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  const r = await db.query(
    `SELECT fatima_explanation, fatima_score, metadata, topic_id, talk_group_id
     FROM smart_groups
     WHERE id = $1`,
    [gid]
  );

  if (r.rowCount === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  const g = r.rows[0];

  if (g.fatima_explanation && Object.keys(g.fatima_explanation).length > 0) {
    return res.json({
      explanation: g.fatima_explanation,
      score: g.fatima_score,
      talk_group_id: g.talk_group_id || null,
    });
  }

  if (g.topic_id) {
    const explain = await explainTopic(g.topic_id);
    return res.json({
      explanation: explain,
      score: g.fatima_score,
      talk_group_id: g.talk_group_id || null,
    });
  }

  return res.json({
    explanation: { reason: "manual_creation" },
    score: g.fatima_score,
    talk_group_id: g.talk_group_id || null,
  });
});

/**
 * GET /api/v1/groups
 * Lister les groupes discovery (avec bridge runtime)
 */
router.get("/", async (req: any, res) => {
  const user = req.user;
  const { type, locale, limit = 20, offset = 0 } = req.query;

  const allowed = await authorize("talk:groups:list", user, { type, locale });
  if (!allowed) {
    return res.status(403).json({ error: "forbidden" });
  }

  let query = "SELECT * FROM smart_groups WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (type) {
    query += ` AND type = $${paramIndex++}`;
    params.push(type);
  }

  if (locale) {
    query += ` AND locale = $${paramIndex++}`;
    params.push(locale);
  }

  query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(limit, offset);

  try {
    const r = await db.query(query, params);
    return res.json({ groups: r.rows, count: r.rowCount });
  } catch (err: any) {
    console.error("[Groups] List error", err);
    return res.status(500).json({ error: "list_failed" });
  }
});

export default router;
