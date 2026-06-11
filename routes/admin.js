import express from "express";
import multer from "multer";
import csv from "csv-parser";
import { Readable } from "stream";
import db from "../config/db.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// --- AGENCIES & EXAMS ---
router.post("/add-agency", async (req, res) => {
  try {
    await db.query("INSERT INTO agencies (name) VALUES ($1)", [req.body.name]);
    res.send("Agency Added");
  } catch (err) { res.status(400).send("Agency already exists or invalid data."); }
});

router.post("/add-exam", async (req, res) => {
  try {
    await db.query("INSERT INTO exams (agency_id, name) VALUES ($1, $2)", [req.body.agency_id, req.body.name]);
    res.send("Exam Added");
  } catch (err) { res.status(400).send("Exam already exists or invalid data."); }
});

router.delete("/delete-agency/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM agencies WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) { res.status(500).send(err.message); }
});

router.delete("/delete-exam/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM exams WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) { res.status(500).send(err.message); }
});

router.post("/link-exam-subject", async (req, res) => {
  try {
    await db.query(`INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.body.exam_id, req.body.subject_id]);
    res.send("Subject linked to exam successfully!");
  } catch (err) { res.status(500).send(err.message); }
});

// --- USERS ---
router.get("/pending-users", async (req, res) => {
  try { res.json((await db.query("SELECT id, name, email FROM users WHERE is_approved = FALSE")).rows); } 
  catch (err) { res.status(500).send(err.message); }
});

router.post("/approve-user", async (req, res) => {
  try {
    await db.query("UPDATE users SET is_approved = TRUE WHERE id = $1", [req.body.userId]);
    res.send("User approved");
  } catch (err) { res.status(500).send(err.message); }
});

router.delete("/delete-user/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.send("User removed");
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/users", async (req, res) => {
  try { res.json((await db.query("SELECT id, name, email, role FROM users WHERE is_approved = TRUE ORDER BY id")).rows); } 
  catch (err) { res.status(500).send(err.message); }
});

// --- STRUCTURE & QUESTIONS ---
router.get("/structure", async (req, res) => {
  try {
    const subjects = await db.query("SELECT * FROM subjects ORDER BY id");
    const chapters = await db.query(`SELECT c.*, COUNT(q.id) as question_count FROM chapters c LEFT JOIN questions q ON c.id = q.chapter_id GROUP BY c.id ORDER BY c.subject_id, c.id`);
    res.json({ subjects: subjects.rows, chapters: chapters.rows });
  } catch (err) { res.status(500).send(err.message); }
});

router.post("/manage-subject", async (req, res) => {
  const { id, name } = req.body;
  const exist = await db.query("SELECT id FROM subjects WHERE name ILIKE $1", [name]);
  if (exist.rows.length > 0 && exist.rows[0].id !== id) return res.status(400).send("A subject with this name already exists.");
  if (id) await db.query("UPDATE subjects SET name = $1 WHERE id = $2", [name, id]);
  else await db.query("INSERT INTO subjects (name) VALUES ($1)", [name]);
  res.send("Subject updated");
});

router.post("/manage-chapter", async (req, res) => {
  const { id, name, subject_id } = req.body;
  const exist = await db.query("SELECT id FROM chapters WHERE name ILIKE $1 AND subject_id = $2", [name, subject_id]);
  if (exist.rows.length > 0 && exist.rows[0].id !== id) return res.status(400).send("A chapter with this name already exists in this subject.");
  if (id) await db.query("UPDATE chapters SET name = $1 WHERE id = $2", [name, id]);
  else await db.query("INSERT INTO chapters (name, subject_id) VALUES ($1, $2)", [name, subject_id]);
  res.send("Chapter updated");
});

router.post("/add-question", async (req, res) => {
  try {
    const { chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation, exam_ids } = req.body;
    const exist = await db.query("SELECT id FROM questions WHERE chapter_id = $1 AND question_text = $2", [chapter_id, question_text]);
    if (exist.rows.length > 0) return res.status(400).send("This exact question already exists in this chapter.");

    const qRes = await db.query(
      `INSERT INTO questions (chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), image_url || null, exam_reference || null, question_type || "Theory", difficulty || "Medium", explanation || null]
    );

    const newId = qRes.rows[0].id;
    if (exam_ids && exam_ids.length > 0) {
      for (let eId of exam_ids) {
        await db.query(`INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [newId, eId]);
      }
    }
    res.send("Question added successfully!");
  } catch (err) { res.status(500).send(err.message); }
});

router.put("/update-question/:id", async (req, res) => {
  try {
    const { question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation, exam_ids } = req.body;
    const qId = req.params.id;

    await db.query(
      `UPDATE questions SET question_text = $1, option_a = $2, option_b = $3, option_c = $4, option_d = $5, correct_option = $6, image_url = $7, exam_reference = $8, question_type = $9, difficulty = $10, explanation = $11 WHERE id = $12`,
      [question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), image_url || null, exam_reference || null, question_type || "Theory", difficulty || "Medium", explanation || null, qId]
    );

    await db.query(`DELETE FROM question_exams WHERE question_id = $1`, [qId]);
    if (exam_ids && exam_ids.length > 0) {
      for (let eId of exam_ids) {
        await db.query(`INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [qId, eId]);
      }
    }
    res.send("Question updated successfully!");
  } catch (err) { res.status(500).send(err.message); }
});

router.delete("/delete-subject/:id", async (req, res) => {
  try { await db.query("DELETE FROM subjects WHERE id = $1", [req.params.id]); res.send("Deleted"); } catch (err) { res.status(500).send(err.message); }
});

router.delete("/delete-chapter/:id", async (req, res) => {
  try { await db.query("DELETE FROM chapters WHERE id = $1", [req.params.id]); res.send("Deleted"); } catch (err) { res.status(500).send(err.message); }
});

router.delete("/delete-question/:id", async (req, res) => {
  try { await db.query("DELETE FROM questions WHERE id = $1", [req.params.id]); res.send("Question deleted"); } catch (err) { res.status(500).send(err.message); }
});

// --- UPLOAD CSV ---
router.post("/upload-questions", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");
  const results = [];
  Readable.from(req.file.buffer.toString("utf-8"))
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        let successCount = 0, skippedCount = 0;
        for (let row of results) {
          if (!row.question_text || row.question_text.trim() === "") continue;
          try {
            const exist = await db.query("SELECT id FROM questions WHERE chapter_id = $1 AND question_text = $2", [req.body.chapter_id, row.question_text]);
            if (exist.rows.length > 0) { skippedCount++; continue; }

            await db.query(
              `INSERT INTO questions (chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [req.body.chapter_id, row.question_text, row.option_a, row.option_b, row.option_c, row.option_d, (row.correct_option || "").replace(/[^a-zA-Z]/g, "").toUpperCase(), row.image_url ? row.image_url.trim() : null, row.exam_reference ? row.exam_reference.trim() : null, row.question_type ? row.question_type.trim() : "Theory", row.difficulty ? row.difficulty.trim() : "Medium", row.explanation ? row.explanation.trim() : null]
            );
            successCount++;
          } catch (dbErr) { console.error("Row error:", dbErr); }
        }
        res.send(`Successfully uploaded ${successCount} questions. Skipped ${skippedCount} duplicates.`);
      } catch (err) { res.status(500).send("Upload error: " + err.message); }
    });
});

// --- REPORTS ---
router.get("/reported-questions", async (req, res) => {
  try {
    const query = `
      SELECT q.*, q.id as question_id, COUNT(r.id) as report_count,
      COALESCE(json_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '[]') as exam_ids
      FROM reported_questions r 
      JOIN questions q ON r.question_id = q.id 
      LEFT JOIN question_exams qe ON q.id = qe.question_id
      LEFT JOIN exams e ON qe.exam_id = e.id
      GROUP BY q.id ORDER BY report_count DESC
    `;
    res.json((await db.query(query)).rows);
  } catch (err) { res.json([]); }
});

router.delete("/dismiss-report/:question_id", async (req, res) => {
  try { await db.query("DELETE FROM reported_questions WHERE question_id = $1", [req.params.question_id]); res.send("Dismissed"); } catch (err) { res.status(500).send(err.message); }
});

export default router;