import db from "../lib/db";

export type TalkGroupMembershipRole = "owner" | "admin" | "moderator" | "member" | "guest";
export type TalkGroupMembershipStatus = "invited" | "accepted" | "rejected" | "left" | "banned";
export type ConversationMembershipStatus = "active" | "invited" | "left" | "banned";

export type TalkGroupRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  legal_entity: string | null;
  is_public: boolean;
  is_private?: boolean | null;
  max_members?: number | null;
  member_count: number | string | null;
  conversation_id?: string | null;
  slug?: string | null;
  locale?: string | null;
  settings?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  topic_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type TalkGroupMembershipRow = {
  group_id: string;
  user_id: string;
  role: TalkGroupMembershipRole;
  status: TalkGroupMembershipStatus;
  joined_at?: string;
  metadata?: Record<string, any>;
};

export type NormalizedTalkGroup = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  legal_entity: string | null;
  is_public: boolean;
  member_count: number;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  type: string;
  member_status: TalkGroupMembershipStatus | null;
  member_role: TalkGroupMembershipRole | null;
  slug?: string | null;
  locale?: string | null;
  settings?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  topic_id?: string | null;
};

export type CreateTalkGroupInput = {
  name: string;
  description?: string | null;
  is_public?: boolean;
  legal_entity?: string | null;
  locale?: string | null;
  slug?: string | null;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  topic_id?: string | null;
};

export type ListTalkGroupsInput = {
  userId: string;
  limit?: number;
  offset?: number;
  mine?: boolean;
};

export type GetTalkGroupDetailInput = {
  groupId: string;
  userId: string;
};

export type JoinTalkGroupInput = {
  groupId: string;
  userId: string;
};

export type LeaveTalkGroupInput = {
  groupId: string;
  userId: string;
};

type DbClientLike = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  release?: () => void;
};

const DEFAULT_GROUP_LIMIT = 50;
const MAX_GROUP_LIMIT = 100;

const normalizeBooleanPublic = (value: any): boolean => value !== false;

const normalizeGroup = (
  group: TalkGroupRow,
  membership?: { role?: TalkGroupMembershipRole | null; status?: TalkGroupMembershipStatus | null } | null
): NormalizedTalkGroup => {
  const isPublic = group?.is_public ?? true;
  return {
    id: group.id,
    name: group.name,
    description: group.description ?? null,
    owner_id: group.owner_id,
    legal_entity: group.legal_entity ?? null,
    is_public: isPublic,
    member_count: Number(group.member_count || 0),
    conversation_id: group.conversation_id || null,
    created_at: group.created_at,
    updated_at: group.updated_at,
    type: isPublic ? "Communauté" : "Privé",
    member_status: membership?.status || null,
    member_role: membership?.role || null,
    slug: group.slug ?? null,
    locale: group.locale ?? null,
    settings: group.settings ?? {},
    metadata: group.metadata ?? {},
    topic_id: group.topic_id ?? null,
  };
};

const clampLimit = (limit?: number): number => {
  const next = Number(limit || DEFAULT_GROUP_LIMIT);
  if (!Number.isFinite(next) || next <= 0) return DEFAULT_GROUP_LIMIT;
  return Math.min(next, MAX_GROUP_LIMIT);
};

const normalizeOffset = (offset?: number): number => {
  const next = Number(offset || 0);
  if (!Number.isFinite(next) || next < 0) return 0;
  return next;
};

const deriveSlug = (name: string): string => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
};

const ensureUniqueSlug = async (
  client: DbClientLike,
  requestedSlug: string,
  excludeGroupId?: string | null
): Promise<string> => {
  let base = String(requestedSlug || "").trim().toLowerCase();
  if (!base) {
    throw new Error("invalid_slug");
  }

  let candidate = base;
  let suffix = 1;

  while (true) {
    const params = excludeGroupId ? [candidate, excludeGroupId] : [candidate];
    const sql = excludeGroupId
      ? `SELECT id FROM talk_groups WHERE slug = $1 AND id <> $2 LIMIT 1`
      : `SELECT id FROM talk_groups WHERE slug = $1 LIMIT 1`;
    const existing = (await client.query(sql, params)).rows[0];
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`.slice(0, 120);
  }
};

export async function updateTalkGroupMemberCount(
  groupId: string,
  client?: DbClientLike
): Promise<void> {
  const executor = client || db;
  await executor.query(
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

export async function getConversationIdForGroup(
  groupId: string,
  {
    createIfMissing = false,
    title,
    ownerId,
    client,
  }: {
    createIfMissing?: boolean;
    title?: string | null;
    ownerId?: string | null;
    client?: DbClientLike;
  } = {}
): Promise<string | null> {
  const executor = client || db;
  const existing = (
    await executor.query(
      `SELECT id
       FROM conversations
       WHERE metadata->>'group_id' = $1
       LIMIT 1`,
      [groupId]
    )
  ).rows[0];

  if (existing?.id || !createIfMissing) {
    return existing?.id || null;
  }

  const created = (
    await executor.query(
      `INSERT INTO conversations (type, title, owner_id, metadata)
       VALUES ('group', $1, $2, $3)
       RETURNING id`,
      [title || null, ownerId || null, { group_id: groupId }]
    )
  ).rows[0];

  return created?.id || null;
}

export async function createTalkGroup(
  user: { id: string; legal_entity?: string | null; locale?: string | null },
  input: CreateTalkGroupInput
): Promise<NormalizedTalkGroup> {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const name = String(input?.name || "").trim();
    if (!name) {
      throw new Error("missing_name");
    }

    const isPublic = normalizeBooleanPublic(input?.is_public);
    const tenant = input?.legal_entity || user.legal_entity || "global";
    const locale = input?.locale || user?.locale || null;
    const rawSlug = input?.slug ? String(input.slug).trim() : deriveSlug(name);
    const slug = rawSlug ? await ensureUniqueSlug(client, rawSlug) : null;

    const inserted = await client.query(
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
         topic_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        name,
        input?.description ? String(input.description) : null,
        user.id,
        isPublic,
        tenant,
        slug,
        locale,
        input?.settings || {},
        input?.metadata || {},
        input?.topic_id || null,
      ]
    );

    const group: TalkGroupRow = inserted.rows[0];
    const conversationId = await getConversationIdForGroup(group.id, {
      createIfMissing: true,
      title: group.name,
      ownerId: user.id,
      client,
    });

    await client.query(
      `INSERT INTO talk_group_members (group_id, user_id, role, status, metadata)
       VALUES ($1,$2,'owner','accepted',$3)
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET role='owner', status='accepted'`,
      [group.id, user.id, {}]
    );

    if (conversationId) {
      await client.query(
        `INSERT INTO conversation_memberships (conversation_id, user_id, role, status, metadata)
         VALUES ($1,$2,'owner','active',$3)
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET role='owner', status='active'`,
        [conversationId, user.id, {}]
      );
    }

    await updateTalkGroupMemberCount(group.id, client);
    await client.query("COMMIT");

    return normalizeGroup(
      { ...group, conversation_id: conversationId },
      { role: "owner", status: "accepted" }
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listTalkGroups(input: ListTalkGroupsInput): Promise<NormalizedTalkGroup[]> {
  const userId = input.userId;
  const limit = clampLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const mine = input.mine === true;

  if (mine) {
    const result = await db.query(
      `SELECT g.*,
              gm.role AS member_role,
              gm.status AS member_status,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.metadata->>'group_id' = g.id::text
                LIMIT 1
              ) AS conversation_id
       FROM talk_groups g
       JOIN talk_group_members gm
         ON gm.group_id = g.id
       WHERE gm.user_id = $1
         AND gm.status <> 'banned'
       ORDER BY g.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map((row: any) =>
      normalizeGroup(row, { role: row.member_role, status: row.member_status })
    );
  }

  const result = await db.query(
    `SELECT g.*,
            gm.role AS member_role,
            gm.status AS member_status,
            (
              SELECT c.id
              FROM conversations c
              WHERE c.metadata->>'group_id' = g.id::text
              LIMIT 1
            ) AS conversation_id
     FROM talk_groups g
     LEFT JOIN talk_group_members gm
       ON gm.group_id = g.id
      AND gm.user_id = $1
     WHERE g.is_public = true
        OR g.owner_id = $1
        OR (gm.status IS NOT NULL AND gm.status <> 'banned')
     ORDER BY g.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return result.rows.map((row: any) =>
    normalizeGroup(row, { role: row.member_role, status: row.member_status })
  );
}

export async function getTalkGroupDetail(
  input: GetTalkGroupDetailInput
): Promise<NormalizedTalkGroup | null> {
  const { groupId, userId } = input;

  const result = await db.query(
    `SELECT g.*,
            (
              SELECT c.id
              FROM conversations c
              WHERE c.metadata->>'group_id' = g.id::text
              LIMIT 1
            ) AS conversation_id
     FROM talk_groups g
     WHERE g.id = $1`,
    [groupId]
  );

  if (!result.rows.length) {
    return null;
  }

  const membership = (
    await db.query(
      `SELECT role, status
       FROM talk_group_members
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    )
  ).rows[0] || null;

  let group: TalkGroupRow = result.rows[0];
  if (!group.conversation_id && membership?.status === "accepted") {
    const conversationId = await getConversationIdForGroup(groupId, {
      createIfMissing: true,
      title: group.name,
      ownerId: group.owner_id,
    });
    group = { ...group, conversation_id: conversationId };
  }

  return normalizeGroup(group, membership);
}

export async function joinTalkGroup(input: JoinTalkGroupInput): Promise<{
  status: "accepted" | "invited";
  role?: TalkGroupMembershipRole;
}> {
  const { groupId, userId } = input;
  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const group = (
      await client.query(
        `SELECT id, is_public, max_members
         FROM talk_groups
         WHERE id = $1
         FOR UPDATE`,
        [groupId]
      )
    ).rows[0];

    if (!group) {
      await client.query("ROLLBACK");
      throw new Error("group_not_found");
    }

    const existing = (
      await client.query(
        `SELECT role, status
         FROM talk_group_members
         WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
      )
    ).rows[0];

    if (existing?.role === "owner") {
      await client.query("COMMIT");
      return { status: "accepted", role: "owner" };
    }

    const acceptedCountRow = (
      await client.query(
        `SELECT COUNT(*)::int AS count
         FROM talk_group_members
         WHERE group_id = $1 AND status = 'accepted'`,
        [groupId]
      )
    ).rows[0];

    const acceptedCount = Number(acceptedCountRow?.count || 0);
    const maxMembers = group.max_members == null ? null : Number(group.max_members);

    if (group.is_public === true && maxMembers !== null && acceptedCount >= maxMembers) {
      await client.query("ROLLBACK");
      throw new Error("group_full");
    }

    const targetStatus: TalkGroupMembershipStatus = group.is_public ? "accepted" : "invited";

    await client.query(
      `INSERT INTO talk_group_members (group_id, user_id, role, status, metadata)
       VALUES ($1,$2,'member',$3,$4)
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET status = EXCLUDED.status`,
      [groupId, userId, targetStatus, {}]
    );

    if (targetStatus === "accepted") {
      await updateTalkGroupMemberCount(groupId, client);

      const conversationId = await getConversationIdForGroup(groupId, {
        createIfMissing: true,
        client,
      });

      if (conversationId) {
        await client.query(
          `INSERT INTO conversation_memberships (conversation_id, user_id, role, status, metadata)
           VALUES ($1,$2,'member','active',$3)
           ON CONFLICT (conversation_id, user_id)
           DO UPDATE SET status='active'`,
          [conversationId, userId, {}]
        );
      }
    }

    await client.query("COMMIT");
    return { status: targetStatus };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function leaveTalkGroup(input: LeaveTalkGroupInput): Promise<{ ok: true }> {
  const { groupId, userId } = input;
  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const membership = (
      await client.query(
        `SELECT role, status
         FROM talk_group_members
         WHERE group_id = $1 AND user_id = $2
         FOR UPDATE`,
        [groupId, userId]
      )
    ).rows[0];

    if (!membership) {
      await client.query("ROLLBACK");
      throw new Error("not_member");
    }

    if (membership.role === "owner") {
      await client.query("ROLLBACK");
      throw new Error("owner_cannot_leave_without_transfer");
    }

    await client.query(
      `UPDATE talk_group_members
       SET status = 'left'
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    const conversationId = await getConversationIdForGroup(groupId, { client });
    if (conversationId) {
      await client.query(
        `DELETE FROM conversation_memberships
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId]
      );
    }

    await updateTalkGroupMemberCount(groupId, client);
    await client.query("COMMIT");

    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
