import "dotenv/config";
import { readFile, readdir } from "fs/promises";
import path from "path";
import { Pool } from "pg";

async function migrate(): Promise<void> {
  const pool = new Pool();
  const sqlDir = path.resolve(process.cwd(), "sql");
  const files = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort();

  try {
    for (const file of files) {
      const sql = await readFile(path.join(sqlDir, file), "utf8");
      console.log(`Applying ${file}...`);
      await pool.query(sql);
    }
    console.log(`Applied ${files.length} migration file(s).`);
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
