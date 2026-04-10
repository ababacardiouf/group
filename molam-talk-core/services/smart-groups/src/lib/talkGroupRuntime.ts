import db from "./db";

export type SmartGroupRow = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  type: string;
  topic_id: string | null;
  owner_id: string;
  legal_entity: string | null;
  locale: string | null;
  fatima_score: number | null;
  fatima_explanation: any;
  metadata: any;
  talk_group_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

type DbClientLike = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

const TALK_GROUP_DEFAULT_MAX_MEMBERS = 1000;

const normalizeSlugBase = (value: string): string => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
};

const ensureUniqueTalkGroupSlug = async (
  client: DbClientLike,
  baseValue: string
): Promise<string> => {
  const base = normalizeSlugBase(baseValue);
  if (!base) {
    throw new Error("invalid_slug");
  }

  let candidate = base;
  let suffix = 1;

  while (true) {
    const existing = (
      await client.query(
        `SELECT id
         FROM talk_groups
         WHERE slug = $1
         LIMIT 1`,
        [candidate]
      )
    ).rows[0];

    if (!existing) {
      return candidate;
    }

    suffix += 1;
    candidate = `${base}-${suffix}`.slice(0, 120);
  }
};

export async function updateTalkGroupMemberCount(
  client: DbClientLike,
  groupId: string
): Promise<void> {
  await client.query(
    `UPDATE talk_groups
     SET member_count = (
       SELECT COUNT(*)
       FROM talk_group_members
       WHERE group_id = $1 AND status = 'accepted'
     ),
     updated_at = now()
     WHERE id = $1`,
    [groupId]
  );
}

export async function ensureGroupConversation(
  client: DbClientLike,
  {
    groupId,
    title,
    ownerId,
  }: {
    groupId: string;
    title: string | null;
    ownerId: string | null;
  }
): Promise<string | null> {
  const existing = (
    await client.query(
      `SELECT id
       FROM conversations
       WHERE metadata->>'group_id' = $1
       LIMIT 1`,
      [groupId]
    )
  ).rows[0];

  if (existing?.id) {
    return existing.id;
  }

  const created = (
    await client.query(
      `INSERT INTO conversations (type, title, owner_id, metadata)
       VALUES ('group', $1, $2, $3)
       RETURNING id`,
      [title || null, ownerId || null, { group_id: groupId }]
    )
  ).rows[0];

  return created?.id || null;
}

export async function ensureCanonicalTalkGroupForSmartGroup(
  client: DbClientLike,
  smartGroup: SmartGroupRow
): Promise<{
  talkGroupId: string;
  conversationId: string | null;
}> {
  if (!smartGroup?.id) {
    throw new Error("smart_group_id_required");
  }

  if (smartGroup.talk_group_id) {
    const existingRuntime = (
      await client.query(
        `SELECT id
         FROM talk_groups
         WHERE id = $1
         LIMIT 1`,
        [smartGroup.talk_group_id]
      )
    ).rows[0];

    if (existingRuntime?.id) {
      const existingConversationId = await ensureGroupConversation(client, {
        groupId: existingRuntime.id,
        title: smartGroup.name,
        ownerId: smartGroup.owner_id,
      });

      await client.query(
        `INSERT INTO talk_group_members (group_id, user_id, role, status, metadata)
         VALUES ($1,$2,'owner','accepted',$3)
         ON CONFLICT (group_id, user_id)
         DO UPDATE SET role='owner', status='accepted'`,
        [existingRuntime.id, smartGroup.owner_id, {}]
      );

      if (existingConversationId) {
        await client.query(
          `INSERT INTO conversation_memberships (conversation_id, user_id, role, status, metadata)
           VALUES ($1,$2,'owner','active',$3)
           ON CONFLICT (conversation_id, user_id)
           DO UPDATE SET role='owner', status='active'`,
          [existingConversationId, smartGroup.owner_id, {}]
        );
      }

      await updateTalkGroupMemberCount(client, existingRuntime.id);

      return {
        talkGroupId: existingRuntime.id,
        conversationId: existingConversationId,
      };
    }
  }

  const slug = await ensureUniqueTalkGroupSlug(
    client,
    smartGroup.slug || smartGroup.name || `group-${smartGroup.id}`
  );

  const inserted = (
    await client.query(
      `INSERT INTO talk_groups (
         name,
         description,
         owner_id,
         is_public,
         legal_entity,
         slug,
         locale,
         settings,
         metadata,
         topic_id,
         is_private,
         max_members,
         member_count
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        smartGroup.name,
        smartGroup.description || null,
        smartGroup.owner_id,
        smartGroup.type !== "private",
        smartGroup.legal_entity || "global",
        slug,
        smartGroup.locale || "en",
        {},
        {
          source: "smart_groups",
          smart_group_id: smartGroup.id,
          fatima_score: smartGroup.fatima_score ?? null,
          fatima_explanation: smartGroup.fatima_explanation ?? {},
          metadata: smartGroup.metadata ?? {},
        },
        smartGroup.topic_id || null,
        smartGroup.type === "private",
        TALK_GROUP_DEFAULT_MAX_MEMBERS,
        0,
      ]
    )
  ).rows[0];

  const talkGroupId = inserted.id;

  const conversationId = await ensureGroupConversation(client, {
    groupId: talkGroupId,
    title: smartGroup.name,
    ownerId: smartGroup.owner_id,
  });

  await client.query(
    `INSERT INTO talk_group_members (group_id, user_id, role, status, metadata)
     VALUES ($1,$2,'owner','accepted',$3)
     ON CONFLICT (group_id, user_id)
     DO UPDATE SET role='owner', status='accepted'`,
    [talkGroupId, smartGroup.owner_id, {}]
  );

  if (conversationId) {
    await client.query(
      `INSERT INTO conversation_memberships (conversation_id, user_id, role, status, metadata)
       VALUES ($1,$2,'owner','active',$3)
       ON CONFLICT (conversation_id, user_id)
       DO UPDATE SET role='owner', status='active'`,
      [conversationId, smartGroup.owner_id, {}]
    );
  }

  await updateTalkGroupMemberCount(client, talkGroupId);

  await client.query(
    `UPDATE smart_groups
     SET talk_group_id = $2
     WHERE id = $1`,
    [smartGroup.id, talkGroupId]
  );

  return {
    talkGroupId,
    conversationId,
  };
}

export async function loadSmartGroupById(
  client: DbClientLike,
  smartGroupId: string
): Promise<SmartGroupRow | null> {
  const row = (
    await client.query(
      `SELECT *
       FROM smart_groups
       WHERE id = $1
       LIMIT 1`,
      [smartGroupId]
    )
  ).rows[0];

  return row || null;
}

export async function materializeRuntimeForSmartGroupId(
  smartGroupId: string
): Promise<{
  smartGroupId: string;
  talkGroupId: string;
  conversationId: string | null;
}> {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const smartGroup = await loadSmartGroupById(client, smartGroupId);
    if (!smartGroup) {
      throw new Error("smart_group_not_found");
    }

    const runtime = await ensureCanonicalTalkGroupForSmartGroup(client, smartGroup);

    await client.query("COMMIT");

    return {
      smartGroupId,
      talkGroupId: runtime.talkGroupId,
      conversationId: runtime.conversationId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
