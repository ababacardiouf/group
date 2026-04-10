/**
 * Trend Ingest Worker
 * FR: Worker qui interroge FATIMA pour les trending topics et cree des groupes automatiquement
 */
import db from "../lib/db";
import { fetchTrending } from "../lib/fatimaClient";
import { autoGroupsCounter, fatimaCallDuration, candidatesGauge } from "../lib/metrics";
import { getFatimaThresholds, shouldAutoCreate, shouldCreateCandidate } from "../lib/thresholds";
import { writeAudit } from "../lib/audit";
import { ensureCanonicalTalkGroupForSmartGroup } from "../lib/talkGroupRuntime";

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || "fatima-bot";
const LEGAL_ENTITY = process.env.LEGAL_ENTITY || "global";

/**
 * Ingest trending topics from FATIMA
 */
export async function ingestTrends(locale: string, region?: string, limit = 10) {
  const t0 = Date.now();

  try {
    const items = await fetchTrending(locale, region, limit);
    const thresholds = getFatimaThresholds();

    fatimaCallDuration.observe(
      { endpoint: "fetchTrending", status: "success" },
      (Date.now() - t0) / 1000
    );

    console.log(`[TrendIngest] Fetched ${items.length} trending items for locale=${locale}`);
    console.log(
      `[TrendIngest] Thresholds: auto=${thresholds.autoCreateThreshold}, candidate_min=${thresholds.candidateMinScore}`
    );

    const client = await db.getClient();
    let created = 0;
    let candidates = 0;

    try {
      await client.query("BEGIN");

      for (const item of items) {
        const score = Number(item.fatima_score || 0);
        if (!shouldCreateCandidate(score)) {
          continue;
        }

        const existing = (
          await client.query(
            `SELECT id
             FROM group_topics
             WHERE keyword=$1 AND locale=$2
             LIMIT 1`,
            [item.keyword, locale]
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
                item.keyword,
                item.fatima_score || 0,
                locale,
                item.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                item
              ]
            )
          ).rows[0];
          topicId = t.id;
          console.log(`[TrendIngest] Created new topic ${topicId}: ${item.keyword}`);
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
            [topicId, item]
          );
          candidates++;
        }

        if (shouldAutoCreate(score)) {
          const existingGroup = (
            await client.query(
              `SELECT id, talk_group_id
               FROM smart_groups
               WHERE topic_id = $1 AND locale = $2
               LIMIT 1`,
              [topicId, locale]
            )
          ).rows[0];

          if (!existingGroup) {
            const name = `Topic: ${item.keyword}`;
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
                  `Discussion automatique sur ${item.keyword}`,
                  topicId,
                  SYSTEM_USER_ID,
                  LEGAL_ENTITY,
                  locale,
                  item.fatima_score || 0,
                  JSON.stringify({ explanation: item.explanation || "auto_trending" }),
                  item
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

            const ev = `group.created.trend.${Date.now()}.${Math.random().toString(36).slice(2, 4)}`;

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
              actorId: SYSTEM_USER_ID,
              targetType: "group",
              targetId: materialized.id,
              legalEntity: LEGAL_ENTITY,
              payload: {
                source: "trend",
                score: item.fatima_score || 0,
                topic_id: topicId,
                talk_group_id: runtime.talkGroupId,
                conversation_id: runtime.conversationId,
              }
            });

            created++;
            autoGroupsCounter.inc({ locale, legal_entity: LEGAL_ENTITY });
            console.log(
              `[TrendIngest] Created auto group ${materialized.id} -> talk_group ${runtime.talkGroupId}: ${materialized.name}`
            );
          }
        }
      }

      await client.query("COMMIT");

      const pendingCount = (
        await db.query("SELECT COUNT(*) FROM group_candidates WHERE status='pending'")
      ).rows[0].count;
      candidatesGauge.set(Number(pendingCount));

      console.log(
        `[TrendIngest] Ingestion complete for locale=${locale}. Created: ${created}, Candidates: ${candidates}`
      );

      return { created, candidates };
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("[TrendIngest] Error during ingestion", err);
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    fatimaCallDuration.observe({ endpoint: "fetchTrending", status: "error" }, (Date.now() - t0) / 1000);
    console.error("[TrendIngest] Failed to fetch trending", err);
    throw err;
  }
}

/**
 * Main worker loop
 */
async function main() {
  const LOCALES = (process.env.LOCALES || "en,fr,es").split(",");
  const REGION = process.env.REGION || "global";
  const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1800000); // 30 minutes

  console.log(
    `[TrendIngest] Starting worker. Locales: ${LOCALES}, Region: ${REGION}, Interval: ${INTERVAL_MS}ms`
  );

  async function runCycle() {
    for (const locale of LOCALES) {
      try {
        await ingestTrends(locale.trim(), REGION);
      } catch (err: any) {
        console.error(`[TrendIngest] Failed for locale=${locale}`, err);
      }
    }
  }

  await runCycle();
  setInterval(runCycle, INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[TrendIngest] Fatal error", err);
    process.exit(1);
  });
}

export default main;
