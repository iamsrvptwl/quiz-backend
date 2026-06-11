import express from "express";
import bcrypt from "bcryptjs";
import db from "../config/db.js";

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, adminCode } = req.body;
    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
    
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

router.post("/login", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [req.body.email]);
    if (result.rows.length === 0) return res.status(400).send("User not found.");
    
    const user = result.rows[0];
    if (!(await bcrypt.compare(req.body.password, user.password_hash)))
      return res.status(400).send("Incorrect password.");
      
    if (!user.is_approved)
      return res.status(403).send("Your account is pending admin approval.");
      
    res.json({
      message: "Login successful!",
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

export default router;