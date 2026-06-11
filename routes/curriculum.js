import express from "express";
import db from "../config/db.js";

const router = express.Router();

router.get("/agencies", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM agencies ORDER BY name")).rows);
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/exams", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM exams ORDER BY name")).rows);
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/subjects", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM subjects ORDER BY id")).rows);
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/chapters/:subjectId", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM chapters WHERE subject_id = $1 ORDER BY id", [req.params.subjectId])).rows);
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/exam-subjects", async (req, res) => {
  const { exam } = req.query;
  try {
    const query = `
      SELECT s.id, s.name FROM subjects s
      JOIN exam_subjects es ON s.id = es.subject_id
      JOIN exams e ON es.exam_id = e.id
      WHERE e.name ILIKE $1 ORDER BY s.id
    `;
    const result = await db.query(query, [`%${exam}%`]); 
    res.json(result.rows);
  } catch (err) { res.status(500).send("Database error: " + err.message); }
});

export default router;