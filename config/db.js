import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

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
    CREATE TABLE IF NOT EXISTS reported_questions (id SERIAL PRIMARY KEY, question_id INT, user_id INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `
).catch(console.error);

export default db;