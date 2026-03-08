#!/usr/bin/env python3
"""ClawPress Build benchmark — times single-page vs multi-page builds."""

import requests, time, sys, json

BASE = "http://localhost:3847"

def reset_site():
    print("🧹 Resetting site...")
    start = time.time()
    r = requests.post(f"{BASE}/reset", json={})
    elapsed = time.time() - start
    print(f"   Reset done in {elapsed:.1f}s")
    return elapsed

def run_build(label, prompt):
    print(f"\n{'='*60}")
    print(f"🚀 {label}")
    print(f"   Prompt: {prompt[:80]}...")
    print(f"{'='*60}")
    
    start = time.time()
    r = requests.post(f"{BASE}/build", json={
        "messages": [{"role": "user", "content": prompt}]
    })
    data = r.json()
    
    if data.get("error"):
        print(f"   ❌ Error: {data['error']}")
        return None
    
    build_id = data["buildId"]
    print(f"   Build ID: {build_id}")
    
    # Poll until done
    while True:
        time.sleep(3)
        try:
            r = requests.get(f"{BASE}/build/{build_id}")
            result = r.json()
            status = result.get("status", "")
            
            # Check server status for progress
            sr = requests.get(f"{BASE}/status")
            ss = sr.json()
            if ss.get("busy"):
                elapsed = time.time() - start
                print(f"   [{elapsed:.0f}s] Iteration {ss.get('iteration','?')}/{ss.get('maxIterations','?')} — {ss.get('toolLabel','')}")
            
            if status == "complete":
                elapsed = time.time() - start
                print(f"\n   ✅ Complete!")
                print(f"   Time: {elapsed:.1f}s")
                print(f"   Iterations: {result.get('iterations', '?')}")
                reply = result.get("reply", "")
                if reply:
                    print(f"   Reply: {reply[:200]}")
                return {"label": label, "time": elapsed, "iterations": result.get("iterations")}
            
            elif status == "error":
                elapsed = time.time() - start
                print(f"\n   ❌ Error after {elapsed:.1f}s: {result.get('error', '?')}")
                return {"label": label, "time": elapsed, "error": True}
                
        except Exception as e:
            print(f"   Poll error: {e}")
            time.sleep(2)

# ── Run benchmarks ──

results = []

# Test 1: Single page
reset_site()
r = run_build(
    "SINGLE PAGE — Coffee Shop",
    "Build a single-page site for a coffee shop called Ember & Brew in Denver. Modern and warm. Include sections for menu highlights, hours, location, and contact. Single page with anchor navigation."
)
if r: results.append(r)

# Test 2: Multi page
reset_site()
r = run_build(
    "MULTI PAGE — Photography Portfolio",
    "Build a multi-page portfolio site for a photographer named Alex Chen in Portland. Pages: Home with hero, About with bio, Portfolio gallery page, Services and pricing, Contact with form. Modern minimal aesthetic."
)
if r: results.append(r)

# Summary
print(f"\n{'='*60}")
print("📊 BENCHMARK RESULTS")
print(f"{'='*60}")
for r in results:
    status = "❌" if r.get("error") else "✅"
    print(f"  {status} {r['label']}: {r['time']:.1f}s ({r.get('iterations','?')} iterations)")
