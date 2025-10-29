// src/routes/jarvis.route.js
// @ts-check
import { Router } from "express";
import { buildJarvisGraph } from "../graph/jarvis.js";

const router = Router();
const graph = buildJarvisGraph();

router.post("/jarvis/act", async (req, res) => {
  try {
    const { text } = req.body || {};
    const state = await graph.invoke({ text });
    res.json({ ok: true, result: state.result, speech: state.speech, intent: state.cmd?.intent });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
