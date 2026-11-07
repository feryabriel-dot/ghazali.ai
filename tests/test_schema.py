import sqlite3
import unittest
from pathlib import Path


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(":memory:")
        self.database.execute("PRAGMA foreign_keys = ON")
        migration = Path(__file__).parents[1] / "migrations" / "0001_initial.sql"
        self.database.executescript(migration.read_text(encoding="utf-8"))

    def tearDown(self):
        self.database.close()

    def test_persists_projects_and_rejects_unsupported_language(self):
        self.database.execute("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)", ("p1", "owner", "Story", "Bahasa Jawa", 60, "draft", None, "now", "now"))
        self.assertEqual(self.database.execute("SELECT title FROM projects WHERE owner=?", ("owner",)).fetchone()[0], "Story")
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)", ("p2", "owner", "Story", "Japanese", 60, "draft", None, "now", "now"))

    def test_project_deletion_cascades_jobs_and_asset_records(self):
        self.database.execute("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)", ("p1", "owner", "Story", "English (US)", 60, "draft", None, "now", "now"))
        self.database.execute("INSERT INTO jobs(id,project_id,owner,status,stage,created_at,updated_at) VALUES(?,?,?,'queued','story','now','now')", ("j1", "p1", "owner"))
        self.database.execute("INSERT INTO assets(id,job_id,project_id,kind,ordinal,status,created_at,updated_at) VALUES(?,?,?,'image',0,'pending','now','now')", ("a1", "j1", "p1"))
        self.database.execute("DELETE FROM projects WHERE id='p1'")
        self.assertEqual(self.database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)
        self.assertEqual(self.database.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()