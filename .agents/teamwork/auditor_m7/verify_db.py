import os
import sqlite3

def check_db():
    db_path = os.path.join(r"C:\Antigravity\GatheringScans", "data", "gathering_scans.db")
    print(f"Checking SQLite database at: {db_path}")
    if not os.path.exists(db_path):
        print(f"ERROR: Database file does not exist at {db_path}")
        return False
    
    file_size = os.path.getsize(db_path)
    print(f"Database size: {file_size:,} bytes")
    
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    
    # Run PRAGMA integrity_check
    cur.execute("PRAGMA integrity_check;")
    res = cur.fetchall()
    print("PRAGMA integrity_check:", res)
    if res != [('ok',)]:
        print("FAIL: Integrity check did not return 'ok'")
        conn.close()
        return False
        
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
    tables = cur.fetchall()
    print(f"Total tables found: {len(tables)}")
    for (t,) in tables:
        cur.execute(f"SELECT count(*) FROM [{t}];")
        cnt = cur.fetchone()[0]
        print(f"  - Table '{t}': {cnt:,} rows")
        
    conn.close()
    return True

if __name__ == "__main__":
    check_db()
