import express from "express";
import db from "../config/db.js";

const router = express.Router();

// --- DASHBOARD: OPTED EXAMS ---
router.post("/opt-exam", async (req, res) => {
  try {
    const { user_id, agency_id, exam_name } = req.body;
    await db.query(
      `INSERT INTO user_opted_exams (user_id, agency_id, exam_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [user_id, agency_id, exam_name]
    );
    res.send("Exam saved to dashboard");
  } catch (err) { res.status(500).send(err.message); }
});

router.delete("/unopt-exam", async (req, res) => {
  try {
    const { user_id, exam_name } = req.body;
    await db.query(`DELETE FROM user_opted_exams WHERE user_id = $1 AND exam_name = $2`, [user_id, exam_name]);
    res.send("Exam removed from dashboard");
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/opted-exams/:user_id", async (req, res) => {
  try {
    const result = await db.query(`SELECT agency_id as "agencyId", exam_name as "examName" FROM user_opted_exams WHERE user_id = $1`, [req.params.user_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).send(err.message); }
});

// --- QUIZ DATA ---
router.get("/questions/:chapterId", async (req, res) => {
  try {
    const query = `
      SELECT q.*, 
      COALESCE(json_agg(e.name) FILTER (WHERE e.name IS NOT NULL), '[]') as exam_names,
      COALESCE(json_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '[]') as exam_ids
      FROM questions q
      LEFT JOIN question_exams qe ON q.id = qe.question_id
      LEFT JOIN exams e ON qe.exam_id = e.id
      WHERE q.chapter_id = $1 GROUP BY q.id ORDER BY q.id
    `;
    res.json((await db.query(query, [req.params.chapterId])).rows);
  } catch (err) { res.status(500).send(err.message); }
});

router.post("/available-exam-references", async (req, res) => {
  try {
    const { subject_ids, chapter_ids, mode, user_id } = req.body;
    let query = `
      SELECT DISTINCT q.exam_reference FROM questions q 
      JOIN chapters c ON q.chapter_id = c.id 
      WHERE q.exam_reference IS NOT NULL AND q.exam_reference != ''
    `;
    let params = [];
    let paramIdx = 1;

    if (mode === "mistake") {
      query = `
        SELECT DISTINCT q.exam_reference FROM questions q 
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
  } catch (err) { res.status(500).send("Database error: " + err.message); }
});

app.post("/save-result", async (req, res) => {
  const { 
    user_id, 
    subject_id, 
    chapter_id, 
    exam_name, 
    test_type, 
    score, 
    accuracy, 
    time_taken,
    correct_count,
    wrong_count
  } = req.body;

  try {
    const query = `
      INSERT INTO results (user_id, subject_id, chapter_id, exam_name, test_type, score, accuracy, time_taken, correct_count, wrong_count, created_at) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id;
    `;
    const values = [user_id, subject_id, chapter_id || null, exam_name || null, test_type || 'Mixed', score, accuracy, time_taken, correct_count, wrong_count];
    
    const result = await db.query(query, values);
    res.status(200).json({ success: true, test_id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error saving result");
  }
});


// --- ANALYTICS & RESULTS ---

router.get("/peer-comparison/:subjectId/:userId", async (req, res) => {
  try {
    const { subjectId, userId } = req.params;
    const userStats = await db.query(`SELECT AVG(score) as my_avg, AVG(accuracy) as my_accuracy FROM test_results WHERE user_id = $1 AND subject_id = $2`, [userId, subjectId]);
    const globalStats = await db.query(`SELECT AVG(score) as global_avg, AVG(accuracy) as global_accuracy FROM test_results WHERE subject_id = $1`, [subjectId]);
    res.json({ user: userStats.rows[0], global: globalStats.rows[0] });
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/my-results/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const query = `
      SELECT 
        r.id, r.score, r.accuracy, r.created_at, r.exam_name, r.test_type,
        s.name AS subject_name,
        c.name AS chapter_name
      FROM results r
      LEFT JOIN subjects s ON r.subject_id = s.id
      LEFT JOIN chapters c ON r.chapter_id = c.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC;
    `;
    const result = await db.query(query, [userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching history");
  }
});

router.post("/save-incorrect", async (req, res) => {
  try {
    for (let q_id of req.body.question_ids) {
      await db.query(
        `INSERT INTO incorrect_records (user_id, subject_id, question_id, error_count) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id, question_id) DO UPDATE SET error_count = incorrect_records.error_count + 1`,
        [req.body.user_id, req.body.subject_id, q_id]
      );
    }
    res.send("Errors logged");
  } catch (err) { res.status(500).send(err.message); }
});

router.get("/incorrect-questions/:user_id", async (req, res) => {
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
  } catch (err) { res.status(500).send(err.message); }
});

router.delete("/clear-history/:user_id", async (req, res) => {
  try {
    await db.query("DELETE FROM test_results WHERE user_id = $1", [req.params.user_id]);
    await db.query("DELETE FROM incorrect_records WHERE user_id = $1", [req.params.user_id]);
    res.status(200).send("History cleared successfully");
  } catch (err) { res.status(500).send(err.message); }
});

router.post("/report-question", async (req, res) => {
  try {
    await db.query("INSERT INTO reported_questions (question_id, user_id) VALUES ($1, $2)", [req.body.question_id, req.body.user_id]);
    res.send("Reported.");
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/api/test-analytics/:testId", async (req, res) => {
  const { testId } = req.params;

  try {
    // 1. Get the specific test the user clicked on
    const targetTest = await db.query(`SELECT * FROM results WHERE id = $1`, [testId]);
    if (targetTest.rows.length === 0) return res.status(404).send("Test not found");
    const test = targetTest.rows[0];

    // 2. Fetch all peers who took the EXACT SAME test configuration
    // (Same subject, chapter, exam track, and test type)
    let peerQuery = `SELECT r.*, u.name as user_name FROM results r JOIN users u ON r.user_id = u.id WHERE r.subject_id = $1`;
    let queryParams = [test.subject_id];
    let paramCount = 2;

    if (test.chapter_id) { peerQuery += ` AND r.chapter_id = $${paramCount++}`; queryParams.push(test.chapter_id); }
    if (test.exam_name) { peerQuery += ` AND r.exam_name = $${paramCount++}`; queryParams.push(test.exam_name); }
    if (test.test_type) { peerQuery += ` AND r.test_type = $${paramCount++}`; queryParams.push(test.test_type); }

    const peerResults = await db.query(peerQuery, queryParams);
    const peers = peerResults.rows;

    // 3. Calculate Leaderboard & Rank
    // Sort all attempts by score descending, then accuracy descending
    peers.sort((a, b) => b.score - a.score || b.accuracy - a.accuracy);
    
    const topRankers = peers.slice(0, 5).map(p => ({
      name: p.user_name,
      score: `${p.score}`,
      avatarBg: "#06B6D4" // Randomize this if you want different colors
    }));

    const currentRank = peers.findIndex(p => p.id === test.id) + 1;
    const totalStudents = peers.length;
    const percentile = totalStudents > 1 
      ? (((totalStudents - currentRank) / totalStudents) * 100).toFixed(2) + "%" 
      : "100%";

    // 4. Calculate Averages and Topper Stats
    const topper = peers[0];
    const avgScore = peers.reduce((acc, curr) => acc + parseFloat(curr.score), 0) / totalStudents;
    const avgAccuracy = peers.reduce((acc, curr) => acc + parseFloat(curr.accuracy), 0) / totalStudents;
    const avgCorrect = peers.reduce((acc, curr) => acc + (curr.correct_count || 0), 0) / totalStudents;
    const avgWrong = peers.reduce((acc, curr) => acc + (curr.wrong_count || 0), 0) / totalStudents;
    const avgTime = peers.reduce((acc, curr) => acc + (curr.time_taken || 0), 0) / totalStudents;

    // Format time helper (seconds to MM:SS)
    const formatTime = (seconds) => {
      if (!seconds) return "N/A";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    // 5. Generate Distribution Data (Bell Curve / Histogram)
    // Group scores into buckets (e.g., -10 to 0, 0 to 10, 10 to 20...)
    const buckets = {};
    peers.forEach(p => {
      // Grouping by increments of 10 for the chart
      const bucket = Math.floor(p.score / 10) * 10; 
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    });

    const marksDistributionData = Object.keys(buckets)
      .sort((a, b) => Number(a) - Number(b))
      .map(marks => {
        let label = null;
        if (Number(marks) === Math.floor(avgScore / 10) * 10) label = `Average: ${avgScore.toFixed(1)}`;
        if (Number(marks) === Math.floor(test.score / 10) * 10) label = `You are here: ${test.score}`;
        
        return {
          marks: Number(marks),
          students: buckets[marks],
          ...(label && { label }) // Only attach label if it exists
        };
      });

    // 6. Send everything to the frontend
    res.status(200).json({
      currentRank,
      totalStudents,
      percentile,
      topRankers,
      topperStats: {
        score: topper.score,
        accuracy: topper.accuracy,
        correct: topper.correct_count || "N/A",
        wrong: topper.wrong_count || "N/A",
        time: formatTime(topper.time_taken)
      },
      averageStats: {
        score: avgScore.toFixed(2),
        accuracy: avgAccuracy.toFixed(2),
        correct: avgCorrect.toFixed(1),
        wrong: avgWrong.toFixed(1),
        time: formatTime(avgTime)
      },
      marksDistributionData
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating analytics");
  }
});


export default router;
