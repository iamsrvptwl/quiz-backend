import bcrypt from "bcryptjs";
import express from "express";
import pg from "pg";
import cors from "cors";
import multer from "multer";
import csv from "csv-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { Readable } from "stream";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

const allowedOrigins = [
  "http://localhost:5173",
  "https://quiz-frontend-delta-three.vercel.app",
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "DELETE", "PUT"],
    credentials: true,
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: "Too many requests from this IP.",
});
app.use(limiter);
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const db = new pg.Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
      }
    : {
        user: "postgres",
        host: "localhost",
        database: "quiz_db",
        password: "wpc123",
        port: 5432,
      }
);

// --- AUTO-INITIALIZE MANY-TO-MANY SCHEMA ---
db.query(
  `
    CREATE TABLE IF NOT EXISTS agencies (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE);
    CREATE TABLE IF NOT EXISTS exams (id SERIAL PRIMARY KEY, agency_id INT REFERENCES agencies(id) ON DELETE CASCADE, name VARCHAR(255) UNIQUE);
    CREATE TABLE IF NOT EXISTS subjects (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE);
    CREATE TABLE IF NOT EXISTS exam_subjects (exam_id INT REFERENCES exams(id) ON DELETE CASCADE, subject_id INT REFERENCES subjects(id) ON DELETE CASCADE, PRIMARY KEY (exam_id, subject_id));
    CREATE TABLE IF NOT EXISTS question_exams (question_id INT REFERENCES questions(id) ON DELETE CASCADE, exam_id INT REFERENCES exams(id) ON DELETE CASCADE, PRIMARY KEY (question_id, exam_id));
    CREATE TABLE IF NOT EXISTS user_opted_exams (
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    agency_id INT REFERENCES agencies(id) ON DELETE CASCADE,
    exam_name VARCHAR(255),
    PRIMARY KEY (user_id, exam_name)
);
`
).catch(console.error);

// --- API ROUTES ---

app.get("/agencies", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM agencies ORDER BY name")).rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/exams", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM exams ORDER BY name")).rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post("/admin/add-agency", async (req, res) => {
  try {
    await db.query("INSERT INTO agencies (name) VALUES ($1)", [req.body.name]);
    res.send("Agency Added");
  } catch (err) {
    res.status(400).send("Agency already exists or invalid data.");
  }
});

app.post("/admin/add-exam", async (req, res) => {
  try {
    await db.query("INSERT INTO exams (agency_id, name) VALUES ($1, $2)", [
      req.body.agency_id,
      req.body.name,
    ]);
    res.send("Exam Added");
  } catch (err) {
    res.status(400).send("Exam already exists or invalid data.");
  }
});

app.delete("/admin/delete-agency/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM agencies WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/admin/delete-exam/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM exams WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/subjects", async (req, res) => {
  try {
    res.json((await db.query("SELECT * FROM subjects ORDER BY id")).rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/chapters/:subjectId", async (req, res) => {
  try {
    res.json(
      (
        await db.query(
          "SELECT * FROM chapters WHERE subject_id = $1 ORDER BY id",
          [req.params.subjectId]
        )
      ).rows
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Advanced Query: Bundle explicit exam tags into the question payload
app.get("/questions/:chapterId", async (req, res) => {
  try {
    const query = `
            SELECT q.*, 
            COALESCE(json_agg(e.name) FILTER (WHERE e.name IS NOT NULL), '[]') as exam_names,
            COALESCE(json_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '[]') as exam_ids
            FROM questions q
            LEFT JOIN question_exams qe ON q.id = qe.question_id
            LEFT JOIN exams e ON qe.exam_id = e.id
            WHERE q.chapter_id = $1
            GROUP BY q.id ORDER BY q.id
        `;
    res.json((await db.query(query, [req.params.chapterId])).rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post("/upload-questions", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");
  const results = [];
  Readable.from(req.file.buffer.toString("utf-8"))
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        let successCount = 0;
        let skippedCount = 0;
        for (let i = 0; i < results.length; i++) {
          let row = results[i];
          if (!row.question_text || row.question_text.trim() === "") continue;
          try {
            const exist = await db.query(
              "SELECT id FROM questions WHERE chapter_id = $1 AND question_text = $2",
              [req.body.chapter_id, row.question_text]
            );
            if (exist.rows.length > 0) {
              skippedCount++;
              continue;
            }

            await db.query(
              `INSERT INTO questions (chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation) 
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                req.body.chapter_id,
                row.question_text,
                row.option_a,
                row.option_b,
                row.option_c,
                row.option_d,
                (row.correct_option || "")
                  .replace(/[^a-zA-Z]/g, "")
                  .toUpperCase(),
                row.image_url ? row.image_url.trim() : null,
                row.exam_reference ? row.exam_reference.trim() : null,
                row.question_type ? row.question_type.trim() : "Theory",
                row.difficulty ? row.difficulty.trim() : "Medium",
                row.explanation ? row.explanation.trim() : null,
              ]
            );
            successCount++;
          } catch (dbErr) {
            console.error("Row error:", dbErr);
          }
        }
        res.send(
          `Successfully uploaded ${successCount} questions. Skipped ${skippedCount} duplicates.`
        );
      } catch (err) {
        res.status(500).send("Upload error: " + err.message);
      }
    });
});

app.post("/available-exam-references", async (req, res) => {
  try {
    const { subject_ids, chapter_ids, mode, user_id } = req.body;
    let query = `
            SELECT DISTINCT q.exam_reference 
            FROM questions q 
            JOIN chapters c ON q.chapter_id = c.id 
            WHERE q.exam_reference IS NOT NULL AND q.exam_reference != ''
        `;
    let params = [];
    let paramIdx = 1;

    if (mode === "mistake") {
      query = `
                SELECT DISTINCT q.exam_reference 
                FROM questions q 
                JOIN incorrect_records ir ON q.id = ir.question_id
                JOIN chapters c ON q.chapter_id = c.id
                WHERE ir.user_id = $${paramIdx++} AND q.exam_reference IS NOT NULL AND q.exam_reference != ''
            `;
      params.push(user_id);
    }

    if (chapter_ids && chapter_ids.length > 0) {
      query += ` AND q.chapter_id = ANY($${paramIdx++}::int[])`;
      params.push(chapter_ids);
    } else if (subject_ids && subject_ids.length > 0) {
      query += ` AND c.subject_id = ANY($${paramIdx++}::int[])`;
      params.push(subject_ids);
    }

    const result = await db.query(query, params);
    res.json(result.rows.map((r) => r.exam_reference));
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

app.post("/register", async (req, res) => {
  try {
    const { name, email, password, adminCode } = req.body;
    const hashedPassword = await bcrypt.hash(
      password,
      await bcrypt.genSalt(10)
    );
    
    // Security update: pulling expected admin code from environment vars if available
    const expectedAdminCode = process.env.ADMIN_SECRET_CODE || "BOSS123";
    const role = adminCode === expectedAdminCode ? "admin" : "student";

    const result = await db.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
      [name, email, hashedPassword, role]
    );
    res.json({ message: "Registration successful!", user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") res.status(400).send("Email already exists.");
    else res.status(500).send(err.message);
  }
});

app.post("/login", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [
      req.body.email,
    ]);
    if (result.rows.length === 0)
      return res.status(400).send("User not found.");
    const user = result.rows[0];
    if (!(await bcrypt.compare(req.body.password, user.password_hash)))
      return res.status(400).send("Incorrect password.");
    if (!user.is_approved)
      return res.status(403).send("Your account is pending admin approval.");
    res.json({
      message: "Login successful!",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/admin/pending-users", async (req, res) => {
  try {
    res.json(
      (
        await db.query(
          "SELECT id, name, email FROM users WHERE is_approved = FALSE"
        )
      ).rows
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post("/admin/approve-user", async (req, res) => {
  try {
    await db.query("UPDATE users SET is_approved = TRUE WHERE id = $1", [
      req.body.userId,
    ]);
    res.send("User approved");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/admin/delete-user/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.send("User removed");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/admin/users", async (req, res) => {
  try {
    res.json(
      (
        await db.query(
          "SELECT id, name, email, role FROM users WHERE is_approved = TRUE ORDER BY id"
        )
      ).rows
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/admin/structure", async (req, res) => {
  try {
    const subjects = await db.query("SELECT * FROM subjects ORDER BY id");
    const chapters = await db.query(
      `SELECT c.*, COUNT(q.id) as question_count FROM chapters c LEFT JOIN questions q ON c.id = q.chapter_id GROUP BY c.id ORDER BY c.subject_id, c.id`
    );
    res.json({ subjects: subjects.rows, chapters: chapters.rows });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post("/admin/manage-subject", async (req, res) => {
  const { id, name } = req.body;
  const exist = await db.query("SELECT id FROM subjects WHERE name ILIKE $1", [
    name,
  ]);
  if (exist.rows.length > 0 && exist.rows[0].id !== id)
    return res.status(400).send("A subject with this name already exists.");
  if (id)
    await db.query("UPDATE subjects SET name = $1 WHERE id = $2", [name, id]);
  else await db.query("INSERT INTO subjects (name) VALUES ($1)", [name]);
  res.send("Subject updated");
});

app.post("/admin/manage-chapter", async (req, res) => {
  const { id, name, subject_id } = req.body;
  const exist = await db.query(
    "SELECT id FROM chapters WHERE name ILIKE $1 AND subject_id = $2",
    [name, subject_id]
  );
  if (exist.rows.length > 0 && exist.rows[0].id !== id)
    return res
      .status(400)
      .send("A chapter with this name already exists in this subject.");
  if (id)
    await db.query("UPDATE chapters SET name = $1 WHERE id = $2", [name, id]);
  else
    await db.query("INSERT INTO chapters (name, subject_id) VALUES ($1, $2)", [
      name,
      subject_id,
    ]);
  res.send("Chapter updated");
});

app.post("/admin/add-question", async (req, res) => {
  try {
    const {
      chapter_id,
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option,
      image_url,
      exam_reference,
      question_type,
      difficulty,
      explanation,
      exam_ids,
    } = req.body;
    const exist = await db.query(
      "SELECT id FROM questions WHERE chapter_id = $1 AND question_text = $2",
      [chapter_id, question_text]
    );
    if (exist.rows.length > 0)
      return res
        .status(400)
        .send("This exact question already exists in this chapter.");

    const qRes = await db.query(
      `INSERT INTO questions (chapter_id, question_text, option_a, option_b, option_c, option_d, correct_option, image_url, exam_reference, question_type, difficulty, explanation) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        chapter_id,
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_option.toUpperCase(),
        image_url || null,
        exam_reference || null,
        question_type || "Theory",
        difficulty || "Medium",
        explanation || null,
      ]
    );

    const newId = qRes.rows[0].id;
    // MAP EXAMS (Many to Many)
    if (exam_ids && exam_ids.length > 0) {
      for (let eId of exam_ids) {
        await db.query(
          `INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [newId, eId]
        );
      }
    }
    res.send("Question added successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.put("/admin/update-question/:id", async (req, res) => {
  try {
    const {
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option,
      image_url,
      exam_reference,
      question_type,
      difficulty,
      explanation,
      exam_ids,
    } = req.body;
    const qId = req.params.id;

    await db.query(
      `UPDATE questions SET question_text = $1, option_a = $2, option_b = $3, option_c = $4, option_d = $5, correct_option = $6, image_url = $7, exam_reference = $8, question_type = $9, difficulty = $10, explanation = $11 WHERE id = $12`,
      [
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_option.toUpperCase(),
        image_url || null,
        exam_reference || null,
        question_type || "Theory",
        difficulty || "Medium",
        explanation || null,
        qId,
      ]
    );

    // REMAP EXAMS (Many to Many)
    await db.query(`DELETE FROM question_exams WHERE question_id = $1`, [qId]);
    if (exam_ids && exam_ids.length > 0) {
      for (let eId of exam_ids) {
        await db.query(
          `INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [qId, eId]
        );
      }
    }
    res.send("Question updated successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/admin/delete-subject/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM subjects WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/admin/delete-chapter/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM chapters WHERE id = $1", [req.params.id]);
    res.send("Deleted");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/admin/delete-question/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM questions WHERE id = $1", [req.params.id]);
    res.send("Question deleted");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- RESULTS & HISTORY ---
app.post("/save-result", async (req, res) => {
  try {
    await db.query(
      "INSERT INTO test_results (user_id, subject_id, score, accuracy) VALUES ($1, $2, $3, $4)",
      [
        req.body.user_id,
        req.body.subject_id,
        req.body.score,
        req.body.accuracy,
      ]
    );
    res.send("Score saved!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// NEW: Peer Comparison Dashboard Route
app.get("/peer-comparison/:subjectId/:userId", async (req, res) => {
  try {
    const { subjectId, userId } = req.params;
    
    // Get the user's average score for the subject
    const userStats = await db.query(
      `SELECT AVG(score) as my_avg, AVG(accuracy) as my_accuracy 
       FROM test_results WHERE user_id = $1 AND subject_id = $2`,
      [userId, subjectId]
    );

    // Get the global average for the subject
    const globalStats = await db.query(
      `SELECT AVG(score) as global_avg, AVG(accuracy) as global_accuracy 
       FROM test_results WHERE subject_id = $1`,
      [subjectId]
    );

    res.json({
      user: userStats.rows[0],
      global: globalStats.rows[0]
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/my-results/:userId", async (req, res) => {
  try {
    res.json(
      (
        await db.query(
          `SELECT tr.score, tr.accuracy, tr.created_at, s.name as subject_name FROM test_results tr LEFT JOIN subjects s ON tr.subject_id = s.id WHERE tr.user_id = $1 ORDER BY tr.created_at DESC`,
          [req.params.userId]
        )
      ).rows
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post("/save-incorrect", async (req, res) => {
  try {
    for (let q_id of req.body.question_ids) {
      await db.query(
        `INSERT INTO incorrect_records (user_id, subject_id, question_id, error_count) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id, question_id) DO UPDATE SET error_count = incorrect_records.error_count + 1`,
        [req.body.user_id, req.body.subject_id, q_id]
      );
    }
    res.send("Errors logged");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/incorrect-questions/:user_id", async (req, res) => {
  try {
    const query = `
            SELECT ir.error_count, q.*, s.id as subject_id, s.name as subject_name, c.id as chapter_id, c.name as chapter_name,
            COALESCE(json_agg(e.name) FILTER (WHERE e.name IS NOT NULL), '[]') as exam_names
            FROM incorrect_records ir 
            JOIN questions q ON ir.question_id = q.id 
            LEFT JOIN question_exams qe ON q.id = qe.question_id
            LEFT JOIN exams e ON qe.exam_id = e.id
            JOIN subjects s ON ir.subject_id = s.id 
            JOIN chapters c ON q.chapter_id = c.id 
            WHERE ir.user_id = $1 
            GROUP BY q.id, ir.error_count, s.id, c.id ORDER BY ir.error_count DESC
        `;
    res.json((await db.query(query, [req.params.user_id])).rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete("/clear-history/:user_id", async (req, res) => {
  try {
    await db.query("DELETE FROM test_results WHERE user_id = $1", [
      req.params.user_id,
    ]);
    await db.query("DELETE FROM incorrect_records WHERE user_id = $1", [
      req.params.user_id,
    ]);
    res.status(200).send("History cleared successfully");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- REPORTING SYSTEM ---
app.post("/report-question", async (req, res) => {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS reported_questions (id SERIAL PRIMARY KEY, question_id INT, user_id INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
    );
    await db.query(
      "INSERT INTO reported_questions (question_id, user_id) VALUES ($1, $2)",
      [req.body.question_id, req.body.user_id]
    );
    res.send("Reported.");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/admin/reported-questions", async (req, res) => {
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
  } catch (err) {
    res.json([]);
  }
});

app.delete("/admin/dismiss-report/:question_id", async (req, res) => {
  try {
    await db.query("DELETE FROM reported_questions WHERE question_id = $1", [
      req.params.question_id,
    ]);
    res.send("Dismissed");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- NEW: SAVE OPTED EXAM ---
app.post("/opt-exam", async (req, res) => {
  try {
    const { user_id, agency_id, exam_name } = req.body;
    await db.query(
      `INSERT INTO user_opted_exams (user_id, agency_id, exam_name) 
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [user_id, agency_id, exam_name]
    );
    res.send("Exam saved to dashboard");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- NEW: UN-OPT EXAM ---
app.delete("/unopt-exam", async (req, res) => {
  try {
    const { user_id, exam_name } = req.body;
    await db.query(
      `DELETE FROM user_opted_exams WHERE user_id = $1 AND exam_name = $2`,
      [user_id, exam_name]
    );
    res.send("Exam removed from dashboard");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- NEW: GET OPTED EXAMS ---
app.get("/opted-exams/:user_id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT agency_id as "agencyId", exam_name as "examName" 
       FROM user_opted_exams WHERE user_id = $1`,
      [req.params.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// FETCH SUBJECTS ASSOCIATED WITH A SPECIFIC EXAMNAME
app.get("/exam-subjects", async (req, res) => {
  const { exam } = req.query; // e.g., ?exam=ESE
  try {
    const query = `
            SELECT s.id, s.name 
            FROM subjects s
            JOIN exam_subjects es ON s.id = es.subject_id
            JOIN exams e ON es.exam_id = e.id
            WHERE e.name ILIKE $1
            ORDER BY s.id
        `;
    // Added % wrappers for safer substring matching
    const result = await db.query(query, [`%${exam}%`]); 
    res.json(result.rows);
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

// ADMIN: LINK A SUBJECT TO AN EXAM
app.post("/admin/link-exam-subject", async (req, res) => {
  const { exam_id, subject_id } = req.body;
  try {
    await db.query(
      `INSERT INTO exam_subjects (exam_id, subject_id) 
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [exam_id, subject_id]
    );
    res.send("Subject linked to exam successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`Server is awake on port ${PORT}`));
}
export default app;