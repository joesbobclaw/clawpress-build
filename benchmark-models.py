#!/usr/bin/env python3
"""Benchmark: Sonnet vs Haiku vs GPT-4o — single page builds."""
import requests, time, sys

BASE = "http://localhost:3847"
PROMPT = "Build a single-page site for a coffee shop called Ember & Brew in Denver. Modern and warm. Include sections for menu highlights, hours, location, and contact. Single page with anchor navigation."

MODELS = [
    ("claude-sonnet-4-6", "Sonnet"),
    ("claude-3-5-haiku-20241022", "Haiku"),
    ("gpt-4o", "GPT-4o"),
]

results = []

for model_id, label in MODELS:
    # Reset
    print(f"\n{'='*60}")
    print(f"🧹 Resetting for {label}...")
    requests.post(f"{BASE}/reset", json={})
    time.sleep(2)
    
    print(f"🚀 {label} ({model_id})")
    start = time.time()
    
    r = requests.post(f"{BASE}/build", json={
        "messages": [{"role": "user", "content": PROMPT}],
        "model": model_id
    })
    data = r.json()
    if data.get("error"):
        print(f"   ❌ {data['error']}")
        results.append({"label": label, "time": 0, "error": True})
        continue
    
    build_id = data["buildId"]
    last_log = ""
    
    while True:
        time.sleep(3)
        try:
            sr = requests.get(f"{BASE}/status").json()
            elapsed = time.time() - start
            if sr.get("busy"):
                log = f"   [{elapsed:.0f}s] Iter {sr.get('iteration','?')}/{sr.get('maxIterations','?')} — {sr.get('toolLabel','')}"
                if log != last_log:
                    print(log)
                    last_log = log
            
            result = requests.get(f"{BASE}/build/{build_id}").json()
            if result.get("status") == "complete":
                elapsed = time.time() - start
                iters = result.get("iterations", "?")
                print(f"\n   ✅ {label}: {elapsed:.1f}s ({iters} iterations)")
                reply = result.get("reply", "")[:150]
                print(f"   Reply: {reply}")
                results.append({"label": label, "time": elapsed, "iterations": iters})
                break
            elif result.get("status") == "error":
                elapsed = time.time() - start
                print(f"\n   ❌ {label}: Error after {elapsed:.1f}s — {result.get('error','?')}")
                results.append({"label": label, "time": elapsed, "error": True})
                break
        except Exception as e:
            print(f"   poll error: {e}")
    
    # Brief cooldown between tests
    time.sleep(3)

print(f"\n{'='*60}")
print("📊 MODEL BENCHMARK RESULTS — Single Page Build")
print(f"{'='*60}")
for r in results:
    if r.get("error"):
        print(f"  ❌ {r['label']}: FAILED")
    else:
        print(f"  ✅ {r['label']}: {r['time']:.1f}s ({r.get('iterations','?')} iterations)")
