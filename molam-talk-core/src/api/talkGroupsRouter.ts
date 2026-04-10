import express from "express";
import { authMiddleware } from "../middleware/auth";
import {
  createTalkGroup,
  getTalkGroupDetail,
  joinTalkGroup,
  leaveTalkGroup,
  listTalkGroups,
} from "../services/talkGroupService";

const router = express.Router();
router.use(authMiddleware);

router.post("/api/v1/talk-groups", async (req: any, res) => {
  try {
    const user = req.user;
    const group = await createTalkGroup(user, {
      name: req.body?.name,
      description: req.body?.description,
      is_public: req.body?.is_public,
      legal_entity: req.body?.legal_entity,
      locale: req.body?.locale,
      slug: req.body?.slug,
      settings: req.body?.settings,
      metadata: req.body?.metadata,
      topic_id: req.body?.topic_id,
    });
    return res.status(201).json(group);
  } catch (err: any) {
    if (err?.message === "missing_name") {
      return res.status(400).json({ error: "missing_name" });
    }
    if (err?.message === "invalid_slug") {
      return res.status(400).json({ error: "invalid_slug" });
    }
    console.error("talk group create failed", err);
    return res.status(500).json({ error: "create_failed" });
  }
});

router.get("/api/v1/talk-groups", async (req: any, res) => {
  try {
    const rows = await listTalkGroups({
      userId: req.user.id,
      limit: Number(req.query.limit || 50),
      offset: Number(req.query.offset || 0),
      mine: req.query.mine === "1" || req.query.mine === "true",
    });
    return res.json(rows);
  } catch (err) {
    console.error("list talk groups failed", err);
    return res.status(500).json({ error: "list_failed" });
  }
});

router.get("/api/v1/talk-groups/:id", async (req: any, res) => {
  try {
    const group = await getTalkGroupDetail({
      groupId: req.params.id,
      userId: req.user.id,
    });
    if (!group) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json(group);
  } catch (err) {
    console.error("get talk group detail failed", err);
    return res.status(500).json({ error: "read_failed" });
  }
});

router.post("/api/v1/talk-groups/:id/join", async (req: any, res) => {
  try {
    const result = await joinTalkGroup({
      groupId: req.params.id,
      userId: req.user.id,
    });
    return res.json(result);
  } catch (err: any) {
    if (err?.message === "group_not_found") {
      return res.status(404).json({ error: "group_not_found" });
    }
    if (err?.message === "group_full") {
      return res.status(409).json({ error: "group_full" });
    }
    console.error("join talk group failed", err);
    return res.status(500).json({ error: "join_failed" });
  }
});

router.post("/api/v1/talk-groups/:id/leave", async (req: any, res) => {
  try {
    const result = await leaveTalkGroup({
      groupId: req.params.id,
      userId: req.user.id,
    });
    return res.json(result);
  } catch (err: any) {
    if (err?.message === "not_member") {
      return res.status(404).json({ error: "not_member" });
    }
    if (err?.message === "owner_cannot_leave_without_transfer") {
      return res.status(400).json({ error: "owner_cannot_leave_without_transfer" });
    }
    console.error("leave talk group failed", err);
    return res.status(500).json({ error: "leave_failed" });
  }
});

export default router;
