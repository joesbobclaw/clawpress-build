#!/usr/bin/env python3
"""Quick single-page benchmark after parallelization."""
import requests, time, sys

BASE = "http://localhost:3847"

# Reset
print("🧹 Resetting...")
requests.post(f"{BASE}/reset", json={})
time.sleep(1)

# Build
prompt = "Build a single-page site for a coffee shop called Ember & Brew in Denver. Modern and warm. Include sections for menu highlights, hours, location, and contact. Single page with anchor navigation."
print(f"🚀 Building single-page site...")
start = time.time()

r = requests.post(f"{BASE}/build", json={"messages": [{"role": "user", "content": prompt}]})
data = r.json()
if data.get("error"):
    print(f"❌ {data['error']}")
    sys.exit(1)

build_id = data["buildId"]
print(f"   Build ID: {build_id}")

while True:
    time.sleep(3)
    try:
        sr = requests.get(f"{BASE}/status").json()
        elapsed = time.time() - start
        if sr.get("busy"):
            print(f"   [{elapsed:.0f}s] Iter {sr.get('iteration','?')}/{sr.get('maxIterations','?')} — {sr.get('toolLabel','')}")
        
        result = requests.get(f"{BASE}/build/{build_id}").json()
        if result.get("status") == "complete":
            elapsed = time.time() - start
            print(f"\n✅ Done in {elapsed:.1f}s ({result.get('iterations','?')} iterations)")
            print(f"   Reply: {result.get('reply','')[:200]}")
            break
        elif result.get("status") == "error":
            elapsed = time.time() - start
            print(f"\n❌ Error after {elapsed:.1f}s")
            break
    except Exception as e:
        print(f"   poll error: {e}")
